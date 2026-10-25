import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  MyBodyMetrics,
  MyDeletionRequest,
  MyBusyHours,
  MyEntriesResponse,
  MyPresence,
  MyOccupancyResponse,
  MySubscription,
  MyWeightHistoryResponse,
  OccupancyResponse,
  ProfilePhotoResponse,
} from "@opengym/shared";
import { db, isDuplicateKeyError, userCollection } from "../db.js";
import {
  AGE_RANGE,
  buildBodyMetricsUpdate,
  HEIGHT_CM_RANGE,
  WEIGHT_KG_RANGE,
} from "../bodyMetrics.js";
import { env } from "../env.js";
import {
  DAY_LABEL_PATTERN,
  dayLabelSpan,
  entryQueryWindow,
  MAX_ENTRY_RANGE_DAYS,
  toEntryDays,
} from "../entryDays.js";
import {
  listWeightHistory,
  recordWeightHistoryIfChanged,
} from "../weightHistory.js";
import { sendApiError } from "../apiError.js";
import { acquireLock, redis, releaseLock } from "../redis.js";
import { authed, requireRole } from "../middleware.js";
import { endFreeze, getFreezeAllowance, startFreeze } from "../freeze.js";
import {
  getSubscriptionSummary,
  listUsableSubscriptionGymIds,
  SubscriptionLockTimeoutError,
} from "../subscriptions.js";
import {
  findGym,
  findGymsByIds,
  listActiveGyms,
  type GymDoc,
} from "../gyms.js";
import { getOccupancy, loadMemberPresence } from "../occupancy.js";
import {
  buildBusyHours,
  busyHoursQueryRange,
  zonedDayHour,
} from "../busyHours.js";
import { logAudit } from "../audit.js";
import { logMemberAudit } from "../memberScope.js";
import {
  ProfilePhotoBusyError,
  ProfilePhotoConfigError,
  ProfilePhotoInputError,
  ProfilePhotoRateLimitError,
  removeUserProfilePhoto,
  storeUserProfilePhoto,
} from "../profilePhoto.js";
import { gateScanRouter } from "../features/gate/router.js";

export const meRouter: Router = Router();

// US-7 gate scan (POST /gate-scan) lives in features/gate.
meRouter.use(gateScanRouter);

// Current profile of the signed-in user (role/flags are read fresh from the DB)
meRouter.get(
  "/profile",
  requireRole("owner", "admin", "staff", "member"),
  authed((req, res) => {
    res.json(req.user);
  }),
);

// Member's own profile photo: the API normalizes the image and writes it to R2.
meRouter.put(
  "/profile-photo",
  requireRole("member"),
  express.raw({ type: "*/*", limit: "10mb" }),
  authed(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      sendApiError(
        res,
        400,
        "PROFILE_PHOTO_MISSING",
        "No photo data was provided.",
      );
      return;
    }
    try {
      const profilePhotoUrl = await storeUserProfilePhoto(
        req.user.id,
        req.body,
        req.header("content-type") ?? "",
      );
      await logAudit(req.user, "profile-photo-updated", req.user.id);
      const body: ProfilePhotoResponse = { profilePhotoUrl };
      res.json(body);
    } catch (error) {
      if (error instanceof ProfilePhotoInputError) {
        sendApiError(res, 400, "PROFILE_PHOTO_INVALID", error.message);
        return;
      }
      if (error instanceof ProfilePhotoBusyError) {
        sendApiError(res, 409, "PROFILE_PHOTO_BUSY", error.message);
        return;
      }
      if (error instanceof ProfilePhotoRateLimitError) {
        sendApiError(res, 429, "PROFILE_PHOTO_RATE_LIMITED", error.message);
        return;
      }
      if (error instanceof ProfilePhotoConfigError) {
        sendApiError(res, 503, "PROFILE_PHOTO_UNAVAILABLE", error.message);
        return;
      }
      console.error("Failed to upload profile photo", error);
      sendApiError(
        res,
        503,
        "PROFILE_PHOTO_UNAVAILABLE",
        "Profile photo could not be uploaded. Please try again.",
      );
    }
  }),
);

meRouter.delete(
  "/profile-photo",
  requireRole("member"),
  authed(async (req, res) => {
    try {
      await removeUserProfilePhoto(req.user.id);
      await logAudit(req.user, "profile-photo-removed", req.user.id);
      const body: ProfilePhotoResponse = { profilePhotoUrl: null };
      res.json(body);
    } catch (error) {
      if (error instanceof ProfilePhotoBusyError) {
        sendApiError(res, 409, "PROFILE_PHOTO_BUSY", error.message);
        return;
      }
      if (error instanceof ProfilePhotoConfigError) {
        sendApiError(res, 503, "PROFILE_PHOTO_UNAVAILABLE", error.message);
        return;
      }
      console.error("Failed to remove profile photo", error);
      sendApiError(
        res,
        503,
        "PROFILE_PHOTO_UNAVAILABLE",
        "Profile photo could not be removed. Please try again.",
      );
    }
  }),
);

// US-4: member's own subscription status (mobile home screen)
meRouter.get(
  "/subscription",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const summary = await getSubscriptionSummary(req.user.id);
    const body: MySubscription = {
      ...summary,
      freezeAllowance: await getFreezeAllowance(new ObjectId(req.user.id), {
        isMember: req.user.role === "member",
        banned: req.user.ban !== null,
      }),
    };
    res.json(body);
  }),
);

const myEntriesQuerySchema = z.object({
  from: z.string().regex(DAY_LABEL_PATTERN),
  to: z.string().regex(DAY_LABEL_PATTERN),
});

/**
 * Match fragment for allowed entry-direction scans (no exits, no refusals).
 * Direction is persisted on current records; legacy records without it are
 * judged by the current out-device ids.
 */
async function inboundEntryMatch(): Promise<Record<string, unknown>> {
  const outDevices = await db
    .collection("devices")
    .find({ direction: "out" }, { projection: { _id: 1 } })
    .toArray();
  const outDeviceIds = outDevices.map((device) => device._id.toString());
  return {
    allowed: true,
    $or: [
      { direction: "in" },
      {
        direction: { $exists: false },
        ...(outDeviceIds.length > 0
          ? { deviceId: { $nin: outDeviceIds } }
          : {}),
      },
    ],
  };
}

/**
 * Attendance layer for the mobile calendar: the member's OWN entry days.
 *
 * Only allowed scans in the entry direction count; otherwise an exit-gate scan
 * would look like a second entry on the same day. Direction is now persisted as
 * `entry_events.direction` at scan time, so history remains classified even if
 * the device is later deleted. Legacy records written BEFORE this field lack
 * `direction`; as a one-time compatibility fallback, use current device ids.
 */
meRouter.get(
  "/entries",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const query = myEntriesQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid date range.");
      return;
    }
    const { from, to } = query.data;
    const span = dayLabelSpan(from, to);
    if (!Number.isFinite(span) || span < 0 || span > MAX_ENTRY_RANGE_DAYS) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid date range.");
      return;
    }

    const timeZone = env.reportsTimeZone;
    const { start, end } = entryQueryWindow(from, to);

    const inboundMatch = await inboundEntryMatch();

    const rows = await db
      .collection("entry_events")
      .aggregate<{ _id: string; entries: number }>([
        {
          $match: {
            userId: req.user.id,
            at: { $gte: start, $lte: end },
            ...inboundMatch,
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$at",
                format: "%Y-%m-%d",
                timezone: timeZone,
              },
            },
            entries: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const body: MyEntriesResponse = {
      days: toEntryDays(rows, from, to),
      timeZone,
    };
    res.json(body);
  }),
);

// Own "am I inside" state plus the latest allowed entry, for the mobile home.
meRouter.get(
  "/presence",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    // The caller is looking at themselves, so no gym scope applies.
    const presence = await loadMemberPresence([req.user.id], {
      role: "owner",
      gymIds: [],
    });
    const last = await db
      .collection("entry_events")
      .find({ userId: req.user.id, ...(await inboundEntryMatch()) })
      .sort({ at: -1, _id: -1 })
      .limit(1)
      .next();
    let lastEntry: MyPresence["lastEntry"] = null;
    if (last && typeof last.gymId === "string") {
      const gym = await findGym(last.gymId);
      lastEntry = {
        gymId: last.gymId,
        gymName: gym?.name ?? "",
        at: new Date(last.at).toISOString(),
      };
    }
    const body: MyPresence = {
      inside: presence.get(req.user.id) ?? null,
      lastEntry,
    };
    res.json(body);
  }),
);

// Typical hourly traffic at a gym the member currently has access to — the
// gyms GET /subscription lists, so a frozen member keeps theirs.
meRouter.get(
  "/gyms/:gymId/busy-hours",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const gymId = String(req.params.gymId);
    const allowed = (await listUsableSubscriptionGymIds(req.user.id)).some(
      (id) => id.toHexString() === gymId,
    );
    const gym = allowed ? await findGym(gymId) : null;
    // Unknown, malformed and out-of-subscription ids answer identically.
    if (!gym) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "This gym is outside your scope.",
      );
      return;
    }
    const timeZone = env.reportsTimeZone;
    const now = new Date();
    const today = zonedDayHour(now, timeZone).day;
    const cacheKey = `og:busyhours:v2:${gymId}:${today}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.json(JSON.parse(cached) as MyBusyHours);
      return;
    }
    const { start, end } = busyHoursQueryRange(today);
    const events = await db
      .collection("entry_events")
      .find(
        {
          gymId,
          at: { $gte: start, $lte: end },
          ...(await inboundEntryMatch()),
        },
        { projection: { at: 1 } },
      )
      .toArray();
    const body = buildBusyHours({
      gymId,
      timeZone,
      now,
      gymCreatedAt: gym.createdAt,
      entryTimes: events.map((event) => new Date(event.at)),
    });
    await redis.set(cacheKey, JSON.stringify(body), {
      expiration: { type: "EX", value: 3600 },
    });
    res.json(body);
  }),
);

// Weight layer for the mobile calendar: history appended whenever weightKg changes.
meRouter.get(
  "/weight-history",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const entries = await listWeightHistory(req.user.id);
    const body: MyWeightHistoryResponse = {
      entries: entries.map((entry) => ({
        weightKg: entry.weightKg,
        at: entry.at.toISOString(),
      })),
    };
    res.json(body);
  }),
);

// Member's own age/height/weight. This lives here instead of BetterAuth's
// `update-user` endpoint: writes must pass through `requireRole` so the user is
// re-read from Mongo on every request and accounts with `mustChangePassword`
// cannot write (see AGENTS.md, auth.ts additionalFields `input: false`).
const bodyMetricsSchema = z
  .object({
    age: z.number().int().min(AGE_RANGE.min).max(AGE_RANGE.max).nullable(),
    heightCm: z
      .number()
      .min(HEIGHT_CM_RANGE.min)
      .max(HEIGHT_CM_RANGE.max)
      .nullable(),
    weightKg: z
      .number()
      .min(WEIGHT_KG_RANGE.min)
      .max(WEIGHT_KG_RANGE.max)
      .nullable(),
  })
  .partial();

const BODY_METRICS_RATE_LIMIT = 10;
const BODY_METRICS_RATE_WINDOW_SECONDS = 60;
const BODY_METRICS_LOCK_TTL_MS = 5000;

/** Weight history grows with every change; writes are rate-limited per user. */
async function isBodyMetricsRateLimited(userId: string): Promise<boolean> {
  const key = `og:rl:body-metrics:${userId}`;
  const count = await redis.incr(key);
  await redis.expire(key, BODY_METRICS_RATE_WINDOW_SECONDS, "NX");
  return count > BODY_METRICS_RATE_LIMIT;
}

meRouter.patch(
  "/body-metrics",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const parsed = bodyMetricsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Body metrics are missing or out of the accepted range.",
      );
      return;
    }

    // Check for emptiness after the schema: Zod may accept `{ age: undefined }`
    // and leave an empty update, causing updateOne to throw on an empty document.
    // Base the decision on the generated update document.
    const { set, unset } = buildBodyMetricsUpdate(parsed.data);
    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "At least one body metric field must be provided.",
      );
      return;
    }

    if (await isBodyMetricsRateLimited(req.user.id)) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Too many body metric updates. Please wait a minute.",
      );
      return;
    }

    // The lock makes the profile write and weight-history append one unit, so
    // two concurrent requests for one member cannot interleave and append
    // history in an order inconsistent with the profile.
    const lockKey = `og:lock:body-metrics:${req.user.id}`;
    const lockToken = randomUUID();
    if (!(await acquireLock(lockKey, lockToken, BODY_METRICS_LOCK_TTL_MS))) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Another body metrics update is in progress. Please retry.",
      );
      return;
    }

    try {
      const result = await userCollection().updateOne(
        { _id: new ObjectId(req.user.id) },
        {
          ...(Object.keys(set).length > 0 ? { $set: set } : {}),
          ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        },
      );
      // Account deletion approval may have raced this request. If no document
      // matched, the user is gone; appending history would recreate deleted
      // health data.
      if (result.matchedCount !== 1) {
        sendApiError(res, 401, "AUTH_REQUIRED", "Account is no longer active.");
        return;
      }

      // Weight history grows only when a real value is written; clearing with
      // null does not append a history record.
      if (typeof set.weightKg === "number") {
        await recordWeightHistoryIfChanged(req.user.id, set.weightKg);
      }

      // Return the complete current state, not only fields written by this
      // request, so the client does not treat other fields as cleared.
      const doc = await userCollection().findOne(
        { _id: new ObjectId(req.user.id) },
        { projection: { age: 1, heightCm: 1, weightKg: 1 } },
      );
      // Health-data writes must be auditable (often sensitive-category data).
      // Record only field names: audit_logs are retained indefinitely, and
      // copying values there would undermine the right to erasure.
      await logAudit(req.user, "body-metrics-updated", req.user.id, {
        fields: [...Object.keys(set), ...Object.keys(unset)],
      });

      const body: MyBodyMetrics = {
        age: typeof doc?.age === "number" ? doc.age : null,
        heightCm: typeof doc?.heightCm === "number" ? doc.heightCm : null,
        weightKg: typeof doc?.weightKg === "number" ? doc.weightKg : null,
      };
      res.json(body);
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }),
);

// Member self-service freeze (docs/member-controls.md). Same service, lock and
// credit logic as the admin routes; the member is the actor.
function sendFreezeRefusal(
  res: express.Response,
  status:
    | "disabled"
    | "out-of-scope"
    | "already-frozen"
    | "no-active-period"
    | "limit-reached",
): void {
  switch (status) {
    case "out-of-scope":
      // Unreachable for self-service (no scope callback); kept exhaustive.
      sendApiError(res, 403, "GYM_OUT_OF_SCOPE", "Not allowed.");
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
        "You have no subscription period running right now.",
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

function sendSubscriptionBusy(res: express.Response): void {
  sendApiError(
    res,
    503,
    "SUBSCRIPTION_BUSY",
    "A subscription operation is in progress. Please try again.",
  );
}

meRouter.post(
  "/freeze",
  requireRole("member"),
  authed(async (req, res) => {
    if (req.user.ban) {
      sendApiError(
        res,
        403,
        "BANNED",
        "Your account is banned. Contact reception.",
      );
      return;
    }
    try {
      const result = await startFreeze(new ObjectId(req.user.id), req.user.id, {
        selfService: true,
      });
      if (result.status !== "started") {
        sendFreezeRefusal(res, result.status);
        return;
      }
      await logMemberAudit(
        req.user,
        "subscription-frozen",
        new ObjectId(req.user.id),
        {
          freezeId: result.freeze._id.toHexString(),
          startedAt: result.freeze.startedAt.toISOString(),
          maxDays: result.freeze.maxDays,
          selfService: true,
        },
      );
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendSubscriptionBusy(res);
        return;
      }
      throw error;
    }
  }),
);

// Resume is always allowed (even when freezing was switched off or the member
// is banned), so a member can never be stuck frozen.
meRouter.delete(
  "/freeze",
  requireRole("member"),
  authed(async (req, res) => {
    try {
      const result = await endFreeze(new ObjectId(req.user.id), {
        reason: "resumed",
        endedBy: req.user.id,
      });
      if (result.status !== "ended") {
        // "out-of-scope" cannot happen here (no scope callback is passed).
        sendApiError(res, 409, "NOT_FROZEN", "This membership is not frozen.");
        return;
      }
      await logMemberAudit(
        req.user,
        "subscription-unfrozen",
        new ObjectId(req.user.id),
        {
          freezeId: result.freeze._id.toHexString(),
          startedAt: result.freeze.startedAt.toISOString(),
          endedAt: result.freeze.endedAt?.toISOString() ?? null,
          creditedMs: result.creditedMs,
          reason: "resumed",
          selfService: true,
        },
      );
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendSubscriptionBusy(res);
        return;
      }
      throw error;
    }
  }),
);

// Phase 5 — US-4: live occupancy of every active gym the caller may enter:
// the gyms on a member's active subscription, an admin/staff account's own
// gyms, or (owner) every active gym.
meRouter.get(
  "/occupancy",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    let gyms: GymDoc[];
    if (req.user.role === "owner") {
      gyms = await listActiveGyms();
    } else if (req.user.role === "member") {
      const ids = await listUsableSubscriptionGymIds(req.user.id);
      gyms = (await findGymsByIds(ids.map((id) => id.toHexString()))).filter(
        (gym) => gym.active,
      );
    } else {
      gyms = (await findGymsByIds(req.user.gymIds)).filter((gym) => gym.active);
    }
    const items: OccupancyResponse[] = await Promise.all(
      gyms.map(async (gym) => {
        const gymId = gym._id.toHexString();
        const inside = await getOccupancy(gymId);
        const capacity = gym.capacity ?? null;
        return {
          gymId,
          gymName: gym.name,
          inside,
          capacity,
          ratio: capacity ? Math.round((inside / capacity) * 100) / 100 : null,
        };
      }),
    );
    const body: MyOccupancyResponse = { gyms: items };
    res.json(body);
  }),
);

// Phase 5 — Data protection: member's own account deletion request status
meRouter.get(
  "/deletion-request",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const latest = await db
      .collection("deletion_requests")
      .find({ userId: new ObjectId(req.user.id) })
      .sort({ requestedAt: -1 })
      .limit(1)
      .next();
    const body: MyDeletionRequest = latest
      ? {
          status:
            latest.status === "pending"
              ? "pending"
              : latest.status === "rejected"
                ? "rejected"
                : "none",
          requestedAt: latest.requestedAt
            ? new Date(latest.requestedAt).toISOString()
            : null,
        }
      : { status: "none", requestedAt: null };
    res.json(body);
  }),
);

// Data protection: create an account deletion request — members may request only for their own account
meRouter.post(
  "/deletion-request",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    if (req.user.role !== "member") {
      sendApiError(
        res,
        403,
        "DELETION_MEMBER_ONLY",
        "Only member accounts can create a deletion request.",
      );
      return;
    }
    const userId = new ObjectId(req.user.id);
    // This check does not guarantee uniqueness; the partial unique index on
    // deletion_requests does. Read-then-write is not atomic, so concurrent
    // requests could create two pending requests for one member. This precheck
    // is only a cheaper path for the common case.
    const existingPending = await db
      .collection("deletion_requests")
      .findOne({ userId, status: "pending" });
    if (existingPending) {
      sendApiError(
        res,
        409,
        "DELETION_ALREADY_PENDING",
        "You already have a pending deletion request.",
      );
      return;
    }
    try {
      await db.collection("deletion_requests").insertOne({
        userId,
        email: req.user.email,
        name: req.user.name,
        requestedAt: new Date(),
        status: "pending",
        resolvedAt: null,
        resolvedBy: null,
        requestedBy: null,
        reason: null,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        sendApiError(
          res,
          409,
          "DELETION_ALREADY_PENDING",
          "You already have a pending deletion request.",
        );
        return;
      }
      throw err;
    }
    await logAudit(req.user, "account-deletion-requested");
    res.json({ ok: true });
  }),
);

// Data protection: withdraw a pending deletion request
meRouter.delete(
  "/deletion-request",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const result = await db.collection("deletion_requests").deleteOne({
      userId: new ObjectId(req.user.id),
      status: "pending",
    });
    if (result.deletedCount === 0) {
      sendApiError(
        res,
        404,
        "DELETION_NOT_PENDING",
        "No pending deletion request was found.",
      );
      return;
    }
    await logAudit(req.user, "account-deletion-cancelled");
    res.json({ ok: true });
  }),
);
