import { randomUUID } from "node:crypto";
import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type {
  PublicUser,
  SubscriptionStatus,
  UserDirectoryPage,
} from "@opengym/shared";
import { auth } from "../../auth/auth.js";
import { sendApiError } from "../../core/apiError.js";
import {
  toObjectId,
  userCollection,
  type UserDocument,
} from "../../core/db.js";
import { acquireLock, redis, releaseLock } from "../../core/redis.js";
import { logAudit } from "../../core/audit.js";
import { authed, requireRole } from "../../core/middleware.js";
import { loadMemberPresence } from "../gyms/occupancy.js";
import { buildProfilePhotoUrl } from "../profilePhoto/profilePhoto.js";
import { findGymsByIds } from "../gyms/gyms.js";
import { findOpenFreeze } from "../freeze/freeze.js";
import { tryNormalizePhoneToE164 } from "../../lib/phone.js";
import {
  buildUserSearchFilter,
  parseUserSearchQuery,
  USER_SEARCH_LIMIT,
} from "./userSearch.js";
import {
  buildDirectoryPlan,
  buildDirectoryUserMatch,
  userDirectoryQuerySchema,
} from "./userDirectory.js";
import { findActivePhoneConflictUserIds } from "../../repairs/phoneBackfill.js";

export const membersRouter: Router = Router();

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

const initialPasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

// US-2: mandatory password change after first sign-in
membersRouter.post(
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
membersRouter.get(
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
membersRouter.get(
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
membersRouter.post(
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
membersRouter.put(
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
