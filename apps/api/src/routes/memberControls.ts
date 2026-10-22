import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { MemberDetail, Role, UserDirectoryRow } from "@opengym/shared";
import { sendApiError } from "../apiError.js";
import {
  db,
  isDuplicateKeyError,
  toObjectId,
  userCollection,
  type UserDocument,
} from "../db.js";
import {
  logMemberAudit,
  canManageMember,
  listMemberGymIds,
} from "../memberScope.js";
import { authed, requireRole } from "../middleware.js";
import { loadMemberPresence } from "../occupancy.js";
import { buildProfilePhotoUrl } from "../profilePhoto.js";
import { tryNormalizePhoneToE164 } from "../phone.js";
import { SubscriptionLockTimeoutError } from "../subscriptions.js";
import { endFreeze, getMemberFreezeState, startFreeze } from "../freeze.js";
import {
  buildDirectoryPlan,
  userDirectoryQuerySchema,
} from "../userDirectory.js";

/**
 * Staff-side controls over a member account: detail, ban, subscription freeze
 * and a deletion request opened on the member's behalf (docs/member-controls.md).
 * The routes are member-only (`MEMBER_ONLY` for any other account) and are not
 * gym-scoped in the path. A non-owner is scoped through the gyms on any of the
 * member's periods (`canManageMember`). Audit rows are written once per gym
 * (`logMemberAudit`), so each gym's admins see the action in their own list.
 */
export const memberControlsRouter: Router = Router();

const BAN_REASON_MIN = 3;
const BAN_REASON_MAX = 500;
const DELETION_REASON_MAX = 500;

/**
 * Loads the target of a member-only control. Sends the error response and
 * returns null for a malformed id, an unknown user or a non-member account.
 */
async function loadMember(
  rawId: unknown,
  res: Response,
  caller: { role: Role; gymIds: readonly string[] },
  /** Skip the gym-scope read when the lock-guarded service checks it itself */
  checkScope = true,
): Promise<{ id: ObjectId; doc: UserDocument } | null> {
  const id = toObjectId(String(rawId ?? ""));
  if (!id) {
    sendApiError(res, 400, "INVALID_USER", "Invalid user.");
    return null;
  }
  const doc = await userCollection().findOne({ _id: id });
  if (!doc) {
    sendApiError(res, 404, "USER_NOT_FOUND", "User not found.");
    return null;
  }
  if ((doc.role ?? "member") !== "member") {
    sendApiError(
      res,
      400,
      "MEMBER_ONLY",
      "This action applies to member accounts only.",
    );
    return null;
  }
  if (checkScope && !canManageMember(caller, await listMemberGymIds(id))) {
    sendOutOfScope(res);
    return null;
  }
  return { id, doc };
}

function sendOutOfScope(res: Response): void {
  sendApiError(
    res,
    403,
    "GYM_OUT_OF_SCOPE",
    "This member has no subscription at any of your gyms.",
  );
}

function sendBusy(res: Response): void {
  sendApiError(
    res,
    503,
    "SUBSCRIPTION_BUSY",
    "A subscription operation is in progress. Please try again.",
  );
}

/** The directory row of one user (same shape as GET /users/directory items). */
async function loadDirectoryRow(
  id: ObjectId,
  caller: { role: Role; gymIds: readonly string[] },
): Promise<UserDirectoryRow | null> {
  const plan = buildDirectoryPlan(
    userDirectoryQuerySchema.parse({}),
    { _id: id },
    new Date(),
  );
  const [result] = await userCollection()
    .aggregate<{
      items: (UserDocument & {
        subscriptionStatus: UserDirectoryRow["subscriptionStatus"];
        subscriptionEndsAt: Date | null;
        subscriptionGymIds: string[];
      })[];
    }>(plan.pipeline)
    .toArray();
  const doc = result?.items[0];
  if (!doc) return null;
  const presence = (await loadMemberPresence([doc._id.toString()], caller)).get(
    doc._id.toString(),
  );
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
    subscriptionStatus: doc.subscriptionStatus,
    subscriptionEndsAt: doc.subscriptionEndsAt?.toISOString() ?? null,
    subscriptionGymIds: doc.subscriptionGymIds ?? [],
    presence: presence ?? null,
  };
}

// Everything the panel's member drawer needs in one call. Any role may be
// opened (the drawer is also reachable from the Entries page); ban and freeze
// simply stay empty for non-members.
memberControlsRouter.get(
  "/users/:id",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const id = toObjectId(String(req.params.id ?? ""));
    if (!id) {
      sendApiError(res, 400, "INVALID_USER", "Invalid user.");
      return;
    }
    const [user, doc, freeze, pending] = await Promise.all([
      loadDirectoryRow(id, req.user),
      userCollection().findOne({ _id: id }, { projection: { ban: 1 } }),
      getMemberFreezeState(id),
      db
        .collection("deletion_requests")
        .findOne({ userId: id, status: "pending" }),
    ]);
    if (!user || !doc) {
      sendApiError(res, 404, "USER_NOT_FOUND", "User not found.");
      return;
    }
    const requestedBy = pending?.requestedBy as
      { id: string; name: string } | null | undefined;
    const body: MemberDetail = {
      user,
      ban: doc.ban
        ? {
            reason: doc.ban.reason,
            bannedAt: doc.ban.bannedAt.toISOString(),
            bannedBy: doc.ban.bannedBy,
          }
        : null,
      freeze,
      pendingDeletion: pending
        ? {
            id: pending._id.toString(),
            requestedAt: new Date(pending.requestedAt as Date).toISOString(),
            requestedBy: requestedBy ?? null,
          }
        : null,
    };
    res.json(body);
  }),
);

const banSchema = z
  .object({
    reason: z.string().trim().min(BAN_REASON_MIN).max(BAN_REASON_MAX),
  })
  .strict();

// Ban a member: entry scans are refused, exits never are, and the session is
// kept so the app can show the ban screen. Re-banning updates the reason.
memberControlsRouter.post(
  "/users/:id/ban",
  requireRole("owner", "admin"),
  authed(async (req, res) => {
    const target = await loadMember(req.params.id, res, req.user);
    if (!target) return;
    const parsed = banSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "INVALID_BAN_REASON",
        "Enter a ban reason of 3 to 500 characters.",
      );
      return;
    }
    const { reason } = parsed.data;
    await userCollection().updateOne(
      { _id: target.id },
      {
        $set: { ban: { reason, bannedAt: new Date(), bannedBy: req.user.id } },
      },
    );
    await logMemberAudit(req.user, "member-banned", target.id, {
      reason,
      previousReason: target.doc.ban?.reason ?? null,
    });
    res.json({ ok: true });
  }),
);

memberControlsRouter.delete(
  "/users/:id/ban",
  requireRole("owner", "admin"),
  authed(async (req, res) => {
    const target = await loadMember(req.params.id, res, req.user);
    if (!target) return;
    const cleared = await userCollection().findOneAndUpdate(
      { _id: target.id, ban: { $exists: true } },
      { $unset: { ban: "" } },
    );
    if (!cleared) {
      sendApiError(res, 409, "NOT_BANNED", "This member is not banned.");
      return;
    }
    await logMemberAudit(req.user, "member-unbanned", target.id, {
      reason: cleared.ban?.reason ?? null,
    });
    res.json({ ok: true });
  }),
);

memberControlsRouter.post(
  "/users/:id/freeze",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    // Scope is checked inside the freeze lock, not here.
    const target = await loadMember(req.params.id, res, req.user, false);
    if (!target) return;
    try {
      const result = await startFreeze(target.id, req.user.id, {
        canManage: (gymIds) => canManageMember(req.user, gymIds),
      });
      if (result.status !== "started") {
        switch (result.status) {
          case "out-of-scope":
            sendOutOfScope(res);
            return;
          case "disabled":
            sendApiError(
              res,
              409,
              "FREEZE_DISABLED",
              "Subscription freezing is turned off.",
            );
            return;
          case "already-frozen":
            sendApiError(
              res,
              409,
              "ALREADY_FROZEN",
              "This membership is already frozen.",
            );
            return;
          case "no-active-period":
            sendApiError(
              res,
              409,
              "NO_ACTIVE_PERIOD",
              "The member has no subscription period running right now.",
            );
            return;
          case "limit-reached":
            sendApiError(
              res,
              409,
              "FREEZE_LIMIT_REACHED",
              "The yearly freeze limit has been reached.",
            );
            return;
        }
      }
      await logMemberAudit(req.user, "subscription-frozen", target.id, {
        freezeId: result.freeze._id.toHexString(),
        startedAt: result.freeze.startedAt.toISOString(),
        maxDays: result.freeze.maxDays,
      });
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendBusy(res);
        return;
      }
      throw error;
    }
  }),
);

memberControlsRouter.delete(
  "/users/:id/freeze",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    // Scope is checked inside the freeze lock, not here.
    const target = await loadMember(req.params.id, res, req.user, false);
    if (!target) return;
    try {
      const result = await endFreeze(target.id, {
        reason: "resumed",
        endedBy: req.user.id,
        canManage: (gymIds) => canManageMember(req.user, gymIds),
      });
      if (result.status === "out-of-scope") {
        sendOutOfScope(res);
        return;
      }
      if (result.status === "not-frozen") {
        sendApiError(res, 409, "NOT_FROZEN", "This membership is not frozen.");
        return;
      }
      await logMemberAudit(req.user, "subscription-unfrozen", target.id, {
        freezeId: result.freeze._id.toHexString(),
        startedAt: result.freeze.startedAt.toISOString(),
        endedAt: result.freeze.endedAt?.toISOString() ?? null,
        creditedMs: result.creditedMs,
        reason: "resumed",
      });
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendBusy(res);
        return;
      }
      throw error;
    }
  }),
);

const deletionOnBehalfSchema = z
  .object({ reason: z.string().trim().max(DELETION_REASON_MAX).optional() })
  .strict();

// Opens a deletion request on a member's behalf. Approval stays owner-only on
// the Data Requests page, which shows who asked and why.
memberControlsRouter.post(
  "/users/:id/deletion-request",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const target = await loadMember(req.params.id, res, req.user);
    if (!target) return;
    const parsed = deletionOnBehalfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid request.");
      return;
    }
    const reason = parsed.data.reason || null;
    const alreadyPending = (): void =>
      sendApiError(
        res,
        409,
        "DELETION_ALREADY_PENDING",
        "This member already has a pending deletion request.",
      );
    // Cheap precheck; the partial unique index on pending requests is the guard.
    if (
      await db
        .collection("deletion_requests")
        .findOne({ userId: target.id, status: "pending" })
    ) {
      alreadyPending();
      return;
    }
    try {
      await db.collection("deletion_requests").insertOne({
        userId: target.id,
        email: target.doc.email,
        name: target.doc.name,
        requestedAt: new Date(),
        status: "pending",
        resolvedAt: null,
        resolvedBy: null,
        requestedBy: { id: req.user.id, name: req.user.name },
        reason,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        alreadyPending();
        return;
      }
      throw error;
    }
    await logMemberAudit(req.user, "account-deletion-requested", target.id, {
      onBehalf: true,
      reason,
    });
    res.json({ ok: true });
  }),
);
