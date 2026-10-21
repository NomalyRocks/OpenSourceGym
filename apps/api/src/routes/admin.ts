import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { ObjectId, type Document, type WithId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type {
  AuditLogEntry,
  CancelSubscriptionResponse,
  ChainSettings,
  DeletionRequest,
  Page,
  PublicUser,
  SubscriptionStatus,
  UserDirectoryPage,
} from "@opengym/shared";
import { auth } from "../auth.js";
import { sendApiError } from "../apiError.js";
import {
  db,
  findChainSettings,
  chainSettingsCollection,
  toObjectId,
  userCollection,
  weightHistoryCollection,
  CHAIN_SETTINGS_ID,
  type ChainSettingsDocument,
  type UserDocument,
} from "../db.js";
import { acquireLock, redis, releaseLock } from "../redis.js";
import { logAudit, logAuditPerGym } from "../audit.js";
import { authed, requireRole } from "../middleware.js";
import { loadMemberPresence, markOutsideEverywhere } from "../occupancy.js";
import { revokeUserSessions } from "../sessions.js";
import {
  buildProfilePhotoUrl,
  deleteUserProfilePhotoForAccountDeletion,
} from "../profilePhoto.js";
import { FP_CHURN_KEY, QR_BLOCK_KEY, QR_LOC_KEY } from "../sharing.js";
import { LEGAL_DEFAULTS } from "../legal.js";
import { legalDocumentUrlSchema } from "../legalUrl.js";
import {
  canAccessGym,
  findGymsByIds,
  validateSubscriptionGymIds,
} from "../gyms.js";
import {
  cancelScheduledSubscription,
  createSequentialSubscription,
  findSubscription,
  listUserSubscriptions,
  setSubscriptionGymIds,
  SubscriptionLockTimeoutError,
} from "../subscriptions.js";
import {
  findOpenFreeze,
  freezeConfigSchema,
  getFreezeConfig,
} from "../freeze.js";
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
  buildDirectoryPlan,
  buildDirectoryUserMatch,
  userDirectoryQuerySchema,
} from "../userDirectory.js";
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
    gymIds: doc.gymIds ?? [],
    emailVerified: doc.emailVerified ?? false,
    twoFactorEnabled: doc.twoFactorEnabled ?? false,
    profilePhotoUrl: buildProfilePhotoUrl(
      doc.profilePhotoKey,
      doc.profilePhotoUpdatedAt,
    ),
    createdAt: doc.createdAt?.toISOString() ?? "",
  };
}

/** Audit row → API shape (shared by the chain and per-gym audit viewers). */
export function toAuditLogEntry(d: WithId<Document>): AuditLogEntry {
  return {
    id: d._id.toString(),
    actorId: d.actorId,
    actorEmail: d.actorEmail,
    action: d.action,
    targetId: d.targetId ?? undefined,
    details: d.details ?? undefined,
    at: (d.at as Date).toISOString(),
    gymId: d.gymId ?? null,
  };
}

const initialPasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

// US-2: mandatory password change after first sign-in
adminRouter.post(
  "/initial-password",
  requireRole("owner", "admin", "staff", "member"),
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
adminRouter.get(
  "/users",
  requireRole("owner", "admin", "staff"),
  async (req, res) => {
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
  },
);

// Paged, filterable user directory for the admin panel (chain-wide, like search)
adminRouter.get(
  "/users/directory",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const parsed = userDirectoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid user directory query parameters.",
      );
      return;
    }
    const query = parsed.data;

    // An empty `q` means "no search"; a single character is too short to
    // match meaningfully, same as the search endpoint.
    const rawQuery = (query.q ?? "").trim();
    const searchText = parseUserSearchQuery(rawQuery);
    if (rawQuery && !searchText) {
      sendApiError(
        res,
        400,
        "SEARCH_QUERY_TOO_SHORT",
        "Enter at least two characters to search.",
      );
      return;
    }

    if (
      query.gymId &&
      req.user.role !== "owner" &&
      !req.user.gymIds.includes(query.gymId)
    ) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "This gym is outside your scope.",
      );
      return;
    }

    let searchFilter = null;
    if (searchText) {
      const phoneE164 = tryNormalizePhoneToE164(searchText);
      const conflictUserIds = phoneE164
        ? await findActivePhoneConflictUserIds(phoneE164)
        : [];
      searchFilter = buildUserSearchFilter(searchText, conflictUserIds);
    }

    const plan = buildDirectoryPlan(
      query,
      buildDirectoryUserMatch(query, searchFilter),
      new Date(),
    );
    const [result] = await userCollection()
      .aggregate<{
        total: { n: number }[];
        items: (UserDocument & {
          subscriptionStatus: SubscriptionStatus;
          subscriptionEndsAt: Date | null;
          subscriptionGymIds: string[];
        })[];
      }>(plan.pipeline, plan.collation ? { collation: plan.collation } : {})
      .toArray();

    const presence = await loadMemberPresence(
      (result?.items ?? []).map((doc) => doc._id.toString()),
      req.user,
    );
    const body: UserDirectoryPage = {
      total: result?.total[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      items: (result?.items ?? []).map((doc) => ({
        ...toPublicUser(doc),
        subscriptionStatus: doc.subscriptionStatus,
        subscriptionEndsAt: doc.subscriptionEndsAt?.toISOString() ?? null,
        subscriptionGymIds: doc.subscriptionGymIds ?? [],
        presence: presence.get(doc._id.toString()) ?? null,
      })),
    };
    res.json(body);
  }),
);

const OWNER_ROLE_LOCK_KEY = "og:lock:owner-role";
const OWNER_ROLE_LOCK_TTL_MS = 10_000;
const OWNER_ROLE_LOCK_WAIT_MS = 3_000;

type RoleChange =
  | { status: "ok"; previous: UserDocument }
  | { status: "not-found" | "last-owner" | "busy" }
  /** A banned or frozen member cannot be promoted: the unban/unfreeze routes only accept members */
  | { status: "banned" | "frozen" };

/**
 * Applies a role change. Every change is serialized through one Redis lock: the
 * last-owner check is a count followed by a write, so without the lock two
 * owners demoting each other at the same time would both pass the count and
 * leave the chain with no owner.
 */
async function changeUserRole(
  targetId: ObjectId,
  role: "owner" | "admin" | "staff" | "member",
): Promise<RoleChange> {
  const token = randomUUID();
  const deadline = Date.now() + OWNER_ROLE_LOCK_WAIT_MS;
  while (
    !(await acquireLock(OWNER_ROLE_LOCK_KEY, token, OWNER_ROLE_LOCK_TTL_MS))
  ) {
    if (Date.now() >= deadline) return { status: "busy" };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    const current = await userCollection().findOne({ _id: targetId });
    if (!current) return { status: "not-found" };
    if (current.role === "owner" && role !== "owner") {
      const owners = await userCollection().countDocuments({ role: "owner" });
      if (owners <= 1) return { status: "last-owner" };
    }
    // Best-effort: the ban and freeze routes check the role before taking their
    // locks, so a ban or freeze written concurrently with this check is missed.
    if ((current.role ?? "member") === "member" && role !== "member") {
      if (current.ban) return { status: "banned" };
      if (await findOpenFreeze(targetId)) return { status: "frozen" };
    }
    // Gym scope only exists for admin/staff, so it is cleared on any change to
    // member or owner and kept otherwise (the owner re-assigns it explicitly).
    const previous = await userCollection().findOneAndUpdate(
      { _id: targetId },
      role === "member" || role === "owner"
        ? { $set: { role }, $unset: { gymIds: "" } }
        : { $set: { role } },
    );
    return previous ? { status: "ok", previous } : { status: "not-found" };
  } finally {
    await releaseLock(OWNER_ROLE_LOCK_KEY, token);
  }
}

const roleSchema = z.object({
  role: z.enum(["owner", "admin", "staff", "member"]),
});

const mfaSchema = z.object({
  mfaCode: z.string().min(1),
  mfaMethod: z.enum(["totp", "otp"]),
});

// US-3: role assignment (owner only) — requires step-up verification when the caller has MFA enabled
adminRouter.post(
  "/users/:id/role",
  requireRole("owner"),
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

    const change = await changeUserRole(targetId, role);
    if (change.status === "busy") {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Another role change is in progress. Please retry.",
      );
      return;
    }
    if (change.status === "not-found") {
      sendApiError(res, 404, "USER_NOT_FOUND", "User not found.");
      return;
    }
    if (change.status === "last-owner") {
      sendApiError(res, 409, "LAST_OWNER", "The last owner cannot be demoted.");
      return;
    }
    if (change.status === "banned") {
      sendApiError(
        res,
        409,
        "MEMBER_BANNED",
        "Unban the member before changing their role.",
      );
      return;
    }
    if (change.status === "frozen") {
      sendApiError(
        res,
        409,
        "MEMBER_FROZEN",
        "End the member's freeze before changing their role.",
      );
      return;
    }
    if (change.status !== "ok") return;
    const result = change.previous;
    await logAudit(req.user, "role-assigned", idParam, {
      previousRole: result.role ?? "member",
      newRole: role,
      mfaVerified,
    });
    res.json({ ok: true });
  }),
);

const setUserGymsSchema = z.object({
  gymIds: z.array(z.string().min(1).max(64)).max(200),
});

// Owner assigns an admin/staff account to gyms (replaces the whole scope).
adminRouter.put(
  "/users/:id/gyms",
  requireRole("owner"),
  authed(async (req, res) => {
    const targetId = toObjectId(String(req.params.id ?? ""));
    const parsed = setUserGymsSchema.safeParse(req.body ?? {});
    if (!targetId || !parsed.success) {
      sendApiError(res, 400, "INVALID_GYMS", "Invalid gym list.");
      return;
    }
    const gymIds = [...new Set(parsed.data.gymIds)];
    const gyms = await findGymsByIds(gymIds);
    if (gyms.length !== gymIds.length) {
      sendApiError(res, 404, "GYM_NOT_FOUND", "One or more gyms do not exist.");
      return;
    }
    const target = await userCollection().findOne({ _id: targetId });
    if (!target) {
      sendApiError(res, 404, "USER_NOT_FOUND", "User not found.");
      return;
    }
    if (target.role !== "admin" && target.role !== "staff") {
      sendApiError(
        res,
        400,
        "INVALID_USER_OR_ROLE",
        "Only admin and staff accounts have a gym scope.",
      );
      return;
    }
    const canonical = gyms.map((gym) => gym._id.toHexString());
    await userCollection().updateOne(
      { _id: targetId },
      { $set: { gymIds: canonical } },
    );
    await logAudit(req.user, "user-gyms-assigned", targetId.toHexString(), {
      previousGymIds: target.gymIds ?? [],
      newGymIds: canonical,
    });
    res.json({ ok: true });
  }),
);

const createSubscriptionSchema = z
  .object({
    userId: z.string(),
    months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
    gymIds: z.array(z.string().min(1).max(64)).max(200),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

type GymCheckFailure = Extract<
  Awaited<ReturnType<typeof validateSubscriptionGymIds>>,
  { ok: false }
>["reason"];

function sendGymCheckError(res: Response, reason: GymCheckFailure): void {
  switch (reason) {
    case "out-of-scope":
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "A selected gym is outside your scope.",
      );
      break;
    case "not-found":
      sendApiError(res, 404, "GYM_NOT_FOUND", "A selected gym does not exist.");
      break;
    case "inactive":
      sendApiError(res, 400, "GYM_INACTIVE", "A selected gym is inactive.");
      break;
    default:
      sendApiError(res, 400, "INVALID_GYMS", "Select at least one active gym.");
  }
}

// US-6: create or extend a subscription. Members are chain-wide, so the route
// is not gym-scoped; instead the caller must have access to EVERY gym listed.
adminRouter.post(
  "/subscriptions",
  requireRole("owner", "admin", "staff"),
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
    const gymCheck = await validateSubscriptionGymIds(
      parsed.data.gymIds,
      req.user,
    );
    if (!gymCheck.ok) {
      sendGymCheckError(res, gymCheck.reason);
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
        gymIds: gymCheck.ids,
        note: parsed.data.note || null,
        createdBy: req.user.id,
      });
      const gymHexIds = gymCheck.ids.map((id) => id.toHexString());
      await logAuditPerGym(
        req.user,
        "subscription-created",
        parsed.data.userId,
        {
          months: parsed.data.months,
          startsAt: created.startsAt.toISOString(),
          endsAt: created.endsAt.toISOString(),
          subscriptionId: created.id.toHexString(),
          gymIds: gymHexIds,
        },
        gymHexIds,
      );
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

const setSubscriptionGymsSchema = z
  .object({ gymIds: z.array(z.string().min(1).max(64)).max(200) })
  .strict();

// Changes which gyms a current or future period covers, without touching its
// dates — adding a gym must not sell a new period. Non-owners may only add or
// remove gyms in their own scope; gyms outside it stay on the period.
adminRouter.put(
  "/subscriptions/:id/gyms",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const subscriptionId = toObjectId(String(req.params.id ?? ""));
    const parsed = setSubscriptionGymsSchema.safeParse(req.body ?? {});
    if (!subscriptionId || !parsed.success) {
      sendApiError(res, 400, "INVALID_GYMS", "Select at least one active gym.");
      return;
    }
    const subscription = await findSubscription(subscriptionId);
    if (!subscription) {
      sendApiError(
        res,
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription not found.",
      );
      return;
    }
    if (subscription.endsAt.getTime() <= Date.now()) {
      sendApiError(
        res,
        409,
        "SUBSCRIPTION_ENDED",
        "This subscription period has already ended.",
      );
      return;
    }
    const before = (subscription.gymIds ?? []).map((id) => id.toHexString());
    const requested = [
      ...new Set(parsed.data.gymIds.map((id) => id.toLowerCase())),
    ];
    if (requested.length === 0) {
      sendApiError(res, 400, "INVALID_GYMS", "Select at least one active gym.");
      return;
    }
    const added = requested.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !requested.includes(id));
    if (removed.some((id) => !canAccessGym(req.user, id))) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "A selected gym is outside your scope.",
      );
      return;
    }
    // Only newly added gyms must be active and in scope; gyms already on the
    // period are kept even if one has since been deactivated.
    if (added.length > 0) {
      const gymCheck = await validateSubscriptionGymIds(added, req.user);
      if (!gymCheck.ok) {
        sendGymCheckError(res, gymCheck.reason);
        return;
      }
    }
    const kept = (subscription.gymIds ?? []).filter((id) =>
      requested.includes(id.toHexString()),
    );
    const next = [...kept, ...added.map((id) => new ObjectId(id))];
    const updated = await setSubscriptionGymIds(subscriptionId, next);
    if (!updated) {
      sendApiError(
        res,
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription not found.",
      );
      return;
    }
    const after = next.map((id) => id.toHexString());
    // One row per gym whose membership changed, so each gym's admins see it.
    await logAuditPerGym(
      req.user,
      "subscription-gyms-updated",
      updated.userId.toHexString(),
      { subscriptionId: subscriptionId.toHexString(), before, after },
      [...added, ...removed],
    );
    res.json({
      id: updated._id.toHexString(),
      userId: updated.userId.toHexString(),
      startsAt: updated.startsAt.toISOString(),
      endsAt: updated.endsAt.toISOString(),
      note: updated.note ?? undefined,
      gymIds: after,
      createdBy: updated.createdBy,
      createdAt: updated.createdAt.toISOString(),
    });
  }),
);

// Undo for a period granted by mistake. Only periods that have not started can
// be cancelled; later periods move earlier so the timeline keeps no gap.
adminRouter.delete(
  "/subscriptions/:id",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const subscriptionId = toObjectId(String(req.params.id ?? ""));
    if (!subscriptionId) {
      sendApiError(
        res,
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription not found.",
      );
      return;
    }
    try {
      const result = await cancelScheduledSubscription(
        subscriptionId,
        (gymIds) => gymIds.every((gymId) => canAccessGym(req.user, gymId)),
      );
      switch (result.status) {
        case "not-found":
          sendApiError(
            res,
            404,
            "SUBSCRIPTION_NOT_FOUND",
            "Subscription not found.",
          );
          return;
        case "started":
          sendApiError(
            res,
            409,
            "SUBSCRIPTION_STARTED",
            "This subscription period has already started and cannot be cancelled.",
          );
          return;
        case "out-of-scope":
          sendApiError(
            res,
            403,
            "GYM_OUT_OF_SCOPE",
            "A gym on this subscription is outside your scope.",
          );
          return;
      }
      const { cancelled, shifted } = result;
      const gymHexIds = (cancelled.gymIds ?? []).map((id) => id.toHexString());
      await logAuditPerGym(
        req.user,
        "subscription-cancelled",
        cancelled.userId.toHexString(),
        {
          subscriptionId: cancelled._id.toHexString(),
          startsAt: cancelled.startsAt.toISOString(),
          endsAt: cancelled.endsAt.toISOString(),
          gymIds: gymHexIds,
          shifted: shifted.map((doc) => ({
            id: doc._id.toHexString(),
            startsAt: doc.startsAt.toISOString(),
            endsAt: doc.endsAt.toISOString(),
          })),
        },
        gymHexIds,
      );
      const body: CancelSubscriptionResponse = {
        ok: true,
        shifted: shifted.map((doc) => ({
          id: doc._id.toHexString(),
          userId: doc.userId.toHexString(),
          startsAt: doc.startsAt.toISOString(),
          endsAt: doc.endsAt.toISOString(),
          note: doc.note ?? undefined,
          gymIds: (doc.gymIds ?? []).map((id) => id.toHexString()),
          createdBy: doc.createdBy,
          createdAt: doc.createdAt.toISOString(),
        })),
      };
      res.json(body);
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
  requireRole("owner", "admin", "staff"),
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
        gymIds: (d.gymIds ?? []).map((id) => id.toHexString()),
        createdBy: d.createdBy,
        createdAt: d.createdAt.toISOString(),
      })),
    );
  },
);

// Chain-wide settings (owner only): chain display name and legal documents.
// Gym-specific settings live under /api/admin/gyms/:gymId/settings.
adminRouter.get(
  "/settings",
  requireRole("owner", "admin"),
  async (_req, res) => {
    const doc = await findChainSettings();
    const settings: ChainSettings = {
      chainName: doc?.chainName ?? "",
      legal: { ...LEGAL_DEFAULTS, ...(doc?.legal ?? {}) },
      freeze: await getFreezeConfig(),
    };
    res.json(settings);
  },
);

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

const chainSettingsSchema = z.object({
  chainName: z.string().trim().min(1),
  // Preserve the existing legal document URLs when absent.
  legal: legalSchema.optional(),
  // Preserve the existing freeze rules when absent.
  freeze: freezeConfigSchema.optional(),
});

adminRouter.put(
  "/settings",
  requireRole("owner"),
  authed(async (req, res) => {
    const parsed = chainSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      if (field === "freeze") {
        sendApiError(
          res,
          400,
          "INVALID_FREEZE_SETTINGS",
          "Invalid subscription freeze settings.",
        );
      } else if (field === "legal") {
        sendApiError(
          res,
          400,
          "INVALID_LEGAL_SETTINGS",
          "Invalid legal document settings.",
        );
      } else {
        sendApiError(res, 400, "GYM_NAME_REQUIRED", "Chain name is required.");
      }
      return;
    }
    const { chainName, legal, freeze } = parsed.data;
    const setDoc: Partial<Omit<ChainSettingsDocument, "_id">> = { chainName };
    if (legal !== undefined) setDoc.legal = legal;
    if (freeze !== undefined) setDoc.freeze = freeze;

    await chainSettingsCollection().updateOne(
      { _id: CHAIN_SETTINGS_ID },
      { $set: setDoc },
      { upsert: true },
    );
    await logAudit(req.user, "settings-updated", undefined, {
      chainName,
      // The consent-text version presented is evidence in a legal dispute, so
      // changes must be recorded in the audit log.
      ...(legal !== undefined ? { legal } : {}),
      ...(freeze !== undefined ? { freeze } : {}),
    });
    res.json({ ok: true });
  }),
);

/**
 * Converts findPage's malformed-cursor error to 400 and leaves other errors to
 * the terminal error handler. Express 5 catches rejected promises in async
 * routes, so rethrowing is safe.
 */
export function toInvalidCursorResponse(res: Response) {
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
  gymId: z.string().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Audit log viewer — cursor pagination + action/gym/date filters. Owner sees
// everything; an admin sees only rows whose gymId is in their scope (chain-level
// rows are hidden).
adminRouter.get(
  "/audit",
  requireRole("owner", "admin"),
  authed(async (req, res) => {
    const query = auditQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }
    const { cursor, limit, action, gymId, from, to } = query.data;

    const filters: Record<string, unknown>[] = [];
    if (action) filters.push({ action });
    if (req.user.role === "owner") {
      if (gymId) filters.push({ gymId });
    } else if (gymId) {
      if (!req.user.gymIds.includes(gymId)) {
        sendApiError(
          res,
          403,
          "GYM_OUT_OF_SCOPE",
          "This gym is outside your scope.",
        );
        return;
      }
      filters.push({ gymId });
    } else {
      filters.push({ gymId: { $in: req.user.gymIds } });
    }
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
      items: page.docs.map(toAuditLogEntry),
      nextCursor: page.nextCursor,
    };
    res.json(body);
  }),
);

const deletionRequestQuerySchema = pageQuerySchema.extend({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

// Phase 5 — Data protection: account deletion request list (admin only)
// Cursor pagination + status filter
adminRouter.get(
  "/deletion-requests",
  requireRole("owner"),
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
        requestedBy: d.requestedBy ?? null,
        reason: d.reason ?? null,
      })),
      nextCursor: page.nextCursor,
    };
    res.json(body);
  },
);

// Data protection: approve deletion — permanently deletes the member and all related data
adminRouter.post(
  "/deletion-requests/:id/approve",
  requireRole("owner"),
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
    await db
      .collection("subscription_freezes")
      .deleteMany({ userId: targetId });
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
    await markOutsideEverywhere(targetIdStr);
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
    await db.collection("deletion_requests").updateMany(
      { userId: targetId },
      // `reason` is free text typed by staff about this member.
      { $set: { email: null, name: null, reason: null } },
    );
    // Ban and deletion-request reasons are free text about the member and sit
    // in audit rows targeting them; the rows stay (who did what, when) but the
    // text goes. The `ban` field itself lives on the user document, deleted
    // above.
    await db.collection("audit_logs").updateMany(
      {
        targetId: targetIdStr,
        action: {
          $in: [
            "member-banned",
            "member-unbanned",
            "account-deletion-requested",
          ],
        },
      },
      { $unset: { "details.reason": "", "details.previousReason": "" } },
    );

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
  requireRole("owner"),
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
