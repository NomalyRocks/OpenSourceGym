import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type {
  AdminStats,
  ApiErrorCode,
  AuditLogEntry,
  DeletionRequest,
  EntryEvent,
  GymSettings,
  Page,
  PublicUser,
} from "@opengym/shared";
import { auth } from "../auth.js";
import { sendApiError } from "../apiError.js";
import {
  db,
  findGymSettings,
  gymSettingsCollection,
  toObjectId,
  userCollection,
  weightHistoryCollection,
  GYM_SETTINGS_ID,
  type GymSettingsDocument,
  type UserDocument,
} from "../db.js";
import { redis } from "../redis.js";
import { logAudit } from "../audit.js";
import { authed, requireRole } from "../middleware.js";
import { markOutside } from "../occupancy.js";
import { revokeUserSessions } from "../sessions.js";
import {
  buildProfilePhotoUrl,
  deleteUserProfilePhotoForAccountDeletion,
} from "../profilePhoto.js";
import {
  FP_CHURN_KEY,
  QR_BLOCK_KEY,
  QR_LOC_KEY,
  SHARING_DEFAULTS,
} from "../sharing.js";
import { countActiveMembers, countRenewalsDue } from "../reports.js";
import { LEGAL_DEFAULTS } from "../legal.js";
import { legalDocumentUrlSchema } from "../legalUrl.js";
import { REMINDER_DEFAULTS } from "../renewalReminders.js";
import {
  createSequentialSubscription,
  listUserSubscriptions,
  SubscriptionLockTimeoutError,
} from "../subscriptions.js";
import { tryNormalizePhoneToE164 } from "../phone.js";
import {
  dateRangeFilter,
  findPage,
  InvalidCursorError,
  pageQuerySchema,
} from "../pagination.js";
import {
  buildUserSearchFilter,
  parseUserSearchQuery,
  USER_SEARCH_LIMIT,
} from "../userSearch.js";
import {
  findActivePhoneConflictUserIds,
  reconcilePhoneConflictsAfterUserChange,
} from "../phoneBackfill.js";

export const adminRouter: Router = Router();

function toPublicUser(doc: UserDocument): PublicUser {
  return {
    id: doc._id.toString(),
    name: doc.name ?? "",
    email: doc.email ?? "",
    firstName: doc.firstName ?? "",
    lastName: doc.lastName ?? "",
    phone:
      doc.phoneE164 ?? tryNormalizePhoneToE164(doc.phone) ?? doc.phone ?? "",
    role: doc.role ?? "member",
    emailVerified: doc.emailVerified ?? false,
    twoFactorEnabled: doc.twoFactorEnabled ?? false,
    profilePhotoUrl: buildProfilePhotoUrl(
      doc.profilePhotoKey,
      doc.profilePhotoUpdatedAt,
    ),
    createdAt: doc.createdAt?.toISOString() ?? "",
  };
}

const initialPasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

// US-2: mandatory password change after first sign-in
adminRouter.post(
  "/initial-password",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const parsed = initialPasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "PASSWORD_TOO_SHORT",
        "New password must be at least 8 characters long.",
      );
      return;
    }
    const { currentPassword, newPassword } = parsed.data;
    try {
      await auth.api.changePassword({
        headers: fromNodeHeaders(req.headers),
        body: { currentPassword, newPassword, revokeOtherSessions: false },
      });
    } catch {
      sendApiError(
        res,
        400,
        "CURRENT_PASSWORD_INVALID",
        "Current password is incorrect.",
      );
      return;
    }
    await userCollection().updateOne(
      { _id: new ObjectId(req.user.id) },
      { $set: { mustChangePassword: false } },
    );
    await logAudit(req.user, "initial-password-changed");
    res.json({ ok: true });
  }),
);

// US-3: member search by phone, email, first name, or last name (staff + admin)
adminRouter.get("/users", requireRole("admin", "staff"), async (req, res) => {
  const query = parseUserSearchQuery(req.query.q);
  if (!query) {
    sendApiError(
      res,
      400,
      "SEARCH_QUERY_TOO_SHORT",
      "Enter at least two characters to search.",
    );
    return;
  }
  const phoneE164 = tryNormalizePhoneToE164(query);
  const conflictUserIds = phoneE164
    ? await findActivePhoneConflictUserIds(phoneE164)
    : [];
  const docs = await userCollection()
    .find(buildUserSearchFilter(query, conflictUserIds))
    .limit(USER_SEARCH_LIMIT)
    .toArray();
  res.json(docs.map(toPublicUser));
});

const roleSchema = z.object({ role: z.enum(["admin", "staff", "member"]) });

const mfaSchema = z.object({
  mfaCode: z.string().min(1),
  mfaMethod: z.enum(["totp", "otp"]),
});

// US-3: role assignment (admin only) — requires step-up verification when the caller has MFA enabled
adminRouter.post(
  "/users/:id/role",
  requireRole("admin"),
  authed(async (req, res) => {
    const idParam = String(req.params.id ?? "");
    const targetId = toObjectId(idParam);
    const parsedRole = roleSchema.safeParse(req.body ?? {});
    if (!targetId || !parsedRole.success) {
      sendApiError(res, 400, "INVALID_USER_OR_ROLE", "Invalid user or role.");
      return;
    }
    const { role } = parsedRole.data;
    // Compare with ObjectId.equals: raw string equality lets non-canonical hex
    // input (for example uppercase) bypass self-role-change protection.
    if (targetId.equals(req.user.id)) {
      sendApiError(
        res,
        400,
        "SELF_ROLE_CHANGE",
        "You cannot change your own role.",
      );
      return;
    }

    // Role assignment by MFA-enabled admins requires TOTP or OTP verification.
    let mfaVerified = false;
    if (req.user.twoFactorEnabled) {
      const parsedMfa = mfaSchema.safeParse(req.body);
      if (!parsedMfa.success) {
        sendApiError(
          res,
          403,
          "MFA_REQUIRED",
          "MFA verification is required for this action.",
        );
        return;
      }
      const { mfaCode, mfaMethod } = parsedMfa.data;

      // Brute-force lock: BetterAuth's HTTP rate limiter does NOT cover direct
      // auth.api.* calls, so attempts are counted here (15 min / 5 invalid codes).
      const mfaFailKey = `og:mfa-fail:${req.user.id}`;
      const failCount = Number((await redis.get(mfaFailKey)) ?? 0);
      if (failCount >= 5) {
        sendApiError(
          res,
          429,
          "MFA_LOCKED",
          "Too many invalid code attempts. Try again in 15 minutes.",
        );
        return;
      }

      try {
        const headers = fromNodeHeaders(req.headers);
        if (mfaMethod === "totp") {
          await auth.api.verifyTOTP({ body: { code: mfaCode }, headers });
        } else {
          await auth.api.verifyTwoFactorOTP({
            body: { code: mfaCode },
            headers,
          });
        }
        mfaVerified = true;
        await redis.del(mfaFailKey);
      } catch {
        const fails = await redis.incr(mfaFailKey);
        if (fails === 1) {
          await redis.expire(mfaFailKey, 900);
        }
        sendApiError(
          res,
          403,
          "MFA_INVALID",
          "The verification code is invalid or has expired.",
        );
        return;
      }
    }

    const result = await userCollection().findOneAndUpdate(
      { _id: targetId },
      { $set: { role } },
    );
    if (!result) {
      sendApiError(res, 404, "USER_NOT_FOUND", "User not found.");
      return;
    }
    await logAudit(req.user, "role-assigned", idParam, {
      previousRole: result.role ?? "member",
      newRole: role,
      mfaVerified,
    });
    res.json({ ok: true });
  }),
);

const createSubscriptionSchema = z
  .object({
    userId: z.string(),
    months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

// US-6: create or extend a subscription (staff + admin)
adminRouter.post(
  "/subscriptions",
  requireRole("admin", "staff"),
  authed(async (req, res) => {
    const parsed = createSubscriptionSchema.safeParse(req.body ?? {});
    const targetId = parsed.success ? toObjectId(parsed.data.userId) : null;
    if (!parsed.success || !targetId) {
      sendApiError(
        res,
        400,
        "INVALID_SUBSCRIPTION",
        "Enter a valid user and subscription plan.",
      );
      return;
    }
    const target = await userCollection().findOne({ _id: targetId });
    if (!target) {
      sendApiError(res, 404, "USER_NOT_FOUND", "User not found.");
      return;
    }
    try {
      const created = await createSequentialSubscription({
        userId: targetId,
        months: parsed.data.months,
        note: parsed.data.note || null,
        createdBy: req.user.id,
      });
      await logAudit(req.user, "subscription-created", parsed.data.userId, {
        months: parsed.data.months,
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
        subscriptionId: created.id.toHexString(),
      });
      res.json({
        ok: true,
        id: created.id.toHexString(),
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendApiError(
          res,
          503,
          "SUBSCRIPTION_BUSY",
          "A subscription operation is in progress. Please try again.",
        );
        return;
      }
      throw error;
    }
  }),
);

adminRouter.get(
  "/users/:id/subscriptions",
  requireRole("admin", "staff"),
  async (req, res) => {
    const targetId = toObjectId(String(req.params.id ?? ""));
    if (!targetId) {
      sendApiError(res, 400, "INVALID_USER", "Invalid user.");
      return;
    }
    const docs = await listUserSubscriptions(targetId);
    res.json(
      docs.map((d) => ({
        id: d._id.toString(),
        userId: d.userId.toString(),
        startsAt: d.startsAt.toISOString(),
        endsAt: d.endsAt.toISOString(),
        note: d.note ?? undefined,
        createdBy: d.createdBy,
        createdAt: d.createdAt.toISOString(),
      })),
    );
  },
);

// Setup wizard: gym settings (admin only)
adminRouter.get("/settings", requireRole("admin"), async (_req, res) => {
  const doc = await findGymSettings();
  const settings: GymSettings = {
    gymName: doc?.gymName ?? "",
    location: doc?.location ?? null,
    capacity: doc?.capacity ?? null,
    autoExitHours: doc?.autoExitHours ?? 4,
    sharing: { ...SHARING_DEFAULTS, ...(doc?.sharing ?? {}) },
    reminders: { ...REMINDER_DEFAULTS, ...(doc?.reminders ?? {}) },
    legal: { ...LEGAL_DEFAULTS, ...(doc?.legal ?? {}) },
  };
  res.json(settings);
});

const reminderSchema = z.object({
  enabled: z.boolean(),
  // Thresholds are not deduplicated or sorted here; the sweep already chooses
  // the narrowest one. The upper bound is 90: reminders beyond it are pointless.
  daysBefore: z.array(z.number().int().min(0).max(90)).min(1).max(5),
});

// An empty string means clear: deleting the field in the panel resets the URL
// to null while the consent checkbox remains visible without a link.
const legalUrlSchema = z
  .union([legalDocumentUrlSchema, z.literal("")])
  .nullish()
  .transform((value) => (value ? value : null));

const legalSchema = z.object({
  dataProcessingUrl: legalUrlSchema,
  privacyUrl: legalUrlSchema,
  version: z.coerce.number().int().min(1).max(1_000_000),
});

const sharingSchema = z.object({
  memberMaxSessions: z.number().int().min(1).max(10),
  staffMaxSessions: z.number().int().min(1).max(20),
  signalThreshold: z.number().int().min(1).max(20),
  signalWindowHours: z.number().int().min(1).max(168),
  qrBlockHours: z.number().int().min(1).max(168),
});

// The setup wizard may send numeric fields as string form inputs; coerce
// preserves the behavior of the previous hand-written Number() conversion.
const gymSettingsSchema = z.object({
  gymName: z.string().trim().min(1),
  location: z
    .object({
      lat: z.coerce.number().finite(),
      lng: z.coerce.number().finite(),
      radiusM: z.coerce.number().finite().positive(),
    })
    .nullish(),
  capacity: z.coerce.number().finite().positive().nullish(),
  autoExitHours: z.coerce.number().int().min(1).max(48).nullish(),
  // Phase 6: sharing-detection settings are updated only when present in the
  // request body; silently overwriting configured values must be avoided.
  sharing: sharingSchema.optional(),
  // Same rationale as sharing: preserve the existing setting when absent.
  reminders: reminderSchema.optional(),
  // Same rationale as sharing: preserve existing legal document URLs when absent.
  legal: legalSchema.optional(),
});

// Clients interpret the code, not the message; each field keeps its stable code.
const SETTINGS_FIELD_ERRORS: Record<string, [ApiErrorCode, string]> = {
  gymName: ["GYM_NAME_REQUIRED", "Gym name is required."],
  location: ["INVALID_LOCATION", "Invalid location information."],
  capacity: ["INVALID_CAPACITY", "Invalid capacity."],
  autoExitHours: ["INVALID_AUTO_EXIT", "Invalid automatic exit duration."],
  sharing: ["INVALID_SHARING_SETTINGS", "Invalid sharing detection settings."],
  reminders: [
    "INVALID_REMINDER_SETTINGS",
    "Invalid renewal reminder settings.",
  ],
  legal: ["INVALID_LEGAL_SETTINGS", "Invalid legal document settings."],
};

adminRouter.put(
  "/settings",
  requireRole("admin"),
  authed(async (req, res) => {
    const parsed = gymSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      const [code, message] = SETTINGS_FIELD_ERRORS[field] ?? [
        "GYM_NAME_REQUIRED",
        "Gym name is required.",
      ];
      sendApiError(res, 400, code, message);
      return;
    }
    const {
      gymName,
      location,
      capacity,
      autoExitHours,
      sharing,
      reminders,
      legal,
    } = parsed.data;

    const setDoc: Partial<Omit<GymSettingsDocument, "_id">> = {
      gymName,
      location: location ?? null,
      capacity: capacity ?? null,
      autoExitHours: autoExitHours ?? 4,
    };
    if (sharing !== undefined) {
      setDoc.sharing = sharing;
    }
    if (reminders !== undefined) {
      setDoc.reminders = reminders;
    }
    if (legal !== undefined) {
      setDoc.legal = legal;
    }

    await gymSettingsCollection().updateOne(
      { _id: GYM_SETTINGS_ID },
      { $set: setDoc },
      { upsert: true },
    );
    await logAudit(req.user, "settings-updated", undefined, {
      gymName,
      autoExitHours: setDoc.autoExitHours,
      ...(sharing !== undefined ? { sharing } : {}),
      // Enabling or disabling reminders determines whether members receive
      // email, so it must appear in the audit log.
      ...(reminders !== undefined ? { reminders } : {}),
      // The consent-text version presented is evidence in a legal dispute, so
      // changes must be recorded in the audit log.
      ...(legal !== undefined ? { legal } : {}),
    });
    res.json({ ok: true });
  }),
);

// Overview dashboard KPIs (staff + admin)
// Counts use the same helpers as the reports module: if Renewals Due in the
// overview differs from the reports page, there is no clear source of truth.
adminRouter.get("/stats", requireRole("admin", "staff"), async (_req, res) => {
  const now = new Date();
  const [activeMembers, renewalsDue] = await Promise.all([
    countActiveMembers(db, now),
    countRenewalsDue(db, now),
  ]);
  const body: AdminStats = { activeMembers, renewalsDue };
  res.json(body);
});

/**
 * Converts findPage's malformed-cursor error to 400 and leaves other errors to
 * the terminal error handler. Express 5 catches rejected promises in async
 * routes, so rethrowing is safe.
 */
function toInvalidCursorResponse(res: Response) {
  return (err: unknown): null => {
    if (err instanceof InvalidCursorError) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid pagination cursor.");
      return null;
    }
    throw err;
  };
}

const auditQuerySchema = pageQuerySchema.extend({
  action: z.string().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Audit log viewer (admin only) — cursor pagination + action/date filters
adminRouter.get("/audit", requireRole("admin"), async (req, res) => {
  const query = auditQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendApiError(res, 400, "INVALID_REQUEST", "Invalid list query parameters.");
    return;
  }
  const { cursor, limit, action, from, to } = query.data;

  const filters: Record<string, unknown>[] = [];
  if (action) filters.push({ action });
  const range = dateRangeFilter("at", from, to);
  if (Object.keys(range).length > 0) filters.push(range);

  const page = await findPage(db.collection("audit_logs"), {
    timeField: "at",
    filter: filters.length > 0 ? { $and: filters } : {},
    cursor,
    limit,
  }).catch(toInvalidCursorResponse(res));
  if (!page) return;

  const body: Page<AuditLogEntry> = {
    items: page.docs.map((d) => ({
      id: d._id.toString(),
      actorId: d.actorId,
      actorEmail: d.actorEmail,
      action: d.action,
      targetId: d.targetId ?? undefined,
      details: d.details ?? undefined,
      at: (d.at as Date).toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
  res.json(body);
});

const entryEventQuerySchema = pageQuerySchema.extend({
  deviceId: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
  // Query parameters always arrive as strings; z.coerce.boolean() also turns
  // "false" into true, so use an explicit enum.
  allowed: z.enum(["true", "false"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Phase 4: gate entry events (allow/deny) — staff + admin
// Cursor pagination + device/member/result/date filters
adminRouter.get(
  "/entry-events",
  requireRole("admin", "staff"),
  async (req, res) => {
    const query = entryEventQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }
    const { cursor, limit, deviceId, userId, allowed, from, to } = query.data;

    const filters: Record<string, unknown>[] = [];
    if (deviceId) filters.push({ deviceId });
    if (userId) filters.push({ userId });
    if (allowed) filters.push({ allowed: allowed === "true" });
    const range = dateRangeFilter("at", from, to);
    if (Object.keys(range).length > 0) filters.push(range);

    const page = await findPage(db.collection("entry_events"), {
      timeField: "at",
      filter: filters.length > 0 ? { $and: filters } : {},
      cursor,
      limit,
    }).catch(toInvalidCursorResponse(res));
    if (!page) return;

    const body: Page<EntryEvent> = {
      items: page.docs.map((d) => ({
        id: d._id.toString(),
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        userId: d.userId ?? null,
        memberName: d.memberName ?? null,
        allowed: d.allowed,
        reason: d.reason ?? null,
        at: (d.at as Date).toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
    res.json(body);
  },
);

const deletionRequestQuerySchema = pageQuerySchema.extend({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

// Phase 5 — Data protection: account deletion request list (admin only)
// Cursor pagination + status filter
adminRouter.get(
  "/deletion-requests",
  requireRole("admin"),
  async (req, res) => {
    const query = deletionRequestQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }
    const { cursor, limit, status } = query.data;

    const page = await findPage(db.collection("deletion_requests"), {
      timeField: "requestedAt",
      filter: status ? { status } : {},
      cursor,
      limit,
    }).catch(toInvalidCursorResponse(res));
    if (!page) return;

    const body: Page<DeletionRequest> = {
      items: page.docs.map((d) => ({
        id: d._id.toString(),
        userId: (d.userId as ObjectId).toString(),
        email: d.email ?? "",
        name: d.name ?? "",
        requestedAt: (d.requestedAt as Date).toISOString(),
        status: d.status,
        resolvedAt: d.resolvedAt ? new Date(d.resolvedAt).toISOString() : null,
        resolvedBy: d.resolvedBy ?? null,
      })),
      nextCursor: page.nextCursor,
    };
    res.json(body);
  },
);

// Data protection: approve deletion — permanently deletes the member and all related data
adminRouter.post(
  "/deletion-requests/:id/approve",
  requireRole("admin"),
  authed(async (req, res) => {
    const requestId = toObjectId(String(req.params.id ?? ""));
    if (!requestId) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Deletion request not found.",
      );
      return;
    }
    // TOCTOU protection: atomically claim the request from pending to approved.
    // If two admins approve concurrently, only one matches and the other gets
    // 409, preventing duplicate audit records and repeated processing.
    const claimed = await db.collection("deletion_requests").findOneAndUpdate(
      { _id: requestId, status: "pending" },
      {
        $set: {
          status: "approved",
          resolvedAt: new Date(),
          resolvedBy: req.user.id,
        },
      },
      { returnDocument: "after" },
    );
    if (!claimed) {
      const existing = await db
        .collection("deletion_requests")
        .findOne({ _id: requestId }, { projection: { _id: 1 } });
      sendApiError(
        res,
        existing ? 409 : 404,
        existing ? "DELETION_REQUEST_RESOLVED" : "DELETION_REQUEST_NOT_FOUND",
        existing
          ? "Deletion request has already been resolved."
          : "Deletion request not found.",
      );
      return;
    }
    const targetId = claimed.userId as ObjectId;
    const targetIdStr = targetId.toString();

    // Revoke all user sessions (Redis + Mongo); application routes already
    // return 401 because the middleware re-reads Mongo.
    await revokeUserSessions(targetIdStr);

    try {
      await deleteUserProfilePhotoForAccountDeletion(targetIdStr);
    } catch (error) {
      console.error(
        "Failed to delete profile photo during account deletion",
        error,
      );
      // Cleanup failed: restore the request to pending so an admin can retry
      // (fail closed — user data has not yet been deleted).
      await db.collection("deletion_requests").updateOne(
        { _id: requestId },
        {
          $set: { status: "pending" },
          $unset: { resolvedAt: "", resolvedBy: "" },
        },
      );
      sendApiError(
        res,
        503,
        "DELETION_CLEANUP_FAILED",
        "Profile photo could not be deleted from storage. Please try again.",
      );
      return;
    }

    await userCollection().deleteOne({ _id: targetId });
    await db.collection("account").deleteMany({ userId: targetId });
    await db.collection("subscriptions").deleteMany({ userId: targetId });
    await db.collection("twoFactor").deleteMany({ userId: targetId });
    // Reminder records reveal that an email was sent to this member on a date
    // and cannot remain tied to a member whose subscriptions were deleted under
    // the right to erasure. They have no statistical value, so delete them.
    await db.collection("renewal_reminders").deleteMany({ userId: targetId });
    // Weight history is health data meaningful only with the member identity;
    // it has no statistical value to anonymize, so delete it completely.
    // Note: weight_history.userId is stored as a string, not an ObjectId.
    await weightHistoryCollection().deleteMany({ userId: targetIdStr });
    // Phase 6 sharing-detection records are also personal data (device
    // fingerprint, location drift). Retaining them for up to 30 days via TTL
    // conflicts with erasure, so approval removes them from storage and Redis.
    await db.collection("sharing_signals").deleteMany({ userId: targetId });
    await redis.del([
      QR_LOC_KEY(targetIdStr),
      QR_BLOCK_KEY(targetIdStr),
      FP_CHURN_KEY(targetIdStr),
      `og:mfa-fail:${targetIdStr}`,
    ]);
    await markOutside(targetIdStr);
    // Historical gate records are kept for statistics but must not contain
    // personal data.
    await db
      .collection("entry_events")
      .updateMany(
        { userId: targetIdStr },
        { $set: { userId: null, memberName: null } },
      );
    // Audit records must not retain the deleted member's email under the right
    // to erasure; action history remains anonymously linked through actorId.
    await db
      .collection("audit_logs")
      .updateMany({ actorId: targetIdStr }, { $set: { actorEmail: null } });

    // ALL of the user's requests, including earlier rejected ones, must lose
    // PII. This request's status/resolvedAt/resolvedBy fields were already set
    // during the atomic claim; only PII is cleared here.
    await db
      .collection("deletion_requests")
      .updateMany({ userId: targetId }, { $set: { email: null, name: null } });

    // Remove the deleted user's PII from duplicate-phone conflict records; if
    // one account remains, migrate it to E.164 and delete the conflict record.
    await reconcilePhoneConflictsAfterUserChange(targetIdStr);

    await logAudit(req.user, "account-deletion-approved", targetIdStr);
    res.json({ ok: true });
  }),
);

// Data protection: reject a deletion request
adminRouter.post(
  "/deletion-requests/:id/reject",
  requireRole("admin"),
  authed(async (req, res) => {
    const requestId = toObjectId(String(req.params.id ?? ""));
    if (!requestId) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Deletion request not found.",
      );
      return;
    }
    const request = await db
      .collection("deletion_requests")
      .findOne({ _id: requestId });
    if (!request) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Deletion request not found.",
      );
      return;
    }
    if (request.status !== "pending") {
      sendApiError(
        res,
        409,
        "DELETION_REQUEST_RESOLVED",
        "Deletion request has already been resolved.",
      );
      return;
    }
    await db.collection("deletion_requests").updateOne(
      { _id: requestId },
      {
        $set: {
          status: "rejected",
          resolvedAt: new Date(),
          resolvedBy: req.user.id,
        },
      },
    );
    await logAudit(
      req.user,
      "account-deletion-rejected",
      (request.userId as ObjectId).toString(),
    );
    res.json({ ok: true });
  }),
);
