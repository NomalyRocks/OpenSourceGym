import express, { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  GateRejectCode,
  GateScanResponse,
  MyBodyMetrics,
  MyDeletionRequest,
  MyEntriesResponse,
  MySubscription,
  MyWeightHistoryResponse,
  OccupancyResponse,
  ProfilePhotoResponse,
} from "@opengym/shared";
import {
  db,
  findGymSettings,
  isDuplicateKeyError,
  userCollection,
} from "../db.js";
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
import { authed, requireRole, type AuthedRequest } from "../middleware.js";
import { distanceMeters } from "../geo.js";
import { verifyGateQr } from "../gateQr.js";
import {
  getSubscriptionSummary,
  hasActiveSubscription,
} from "../subscriptions.js";
import { openDevice } from "../gateway.js";
import { getOccupancy, markInside, markOutside } from "../occupancy.js";
import { enqueueEntryEvent } from "../eventQueue.js";
import { logAudit } from "../audit.js";
import { isQrBlocked, recordSharingSignal, QR_LOC_KEY } from "../sharing.js";
import {
  ProfilePhotoBusyError,
  ProfilePhotoConfigError,
  ProfilePhotoInputError,
  ProfilePhotoRateLimitError,
  removeUserProfilePhoto,
  storeUserProfilePhoto,
} from "../profilePhoto.js";

export const meRouter: Router = Router();

// Current profile of the signed-in user (role/flags are read fresh from the DB)
meRouter.get(
  "/profile",
  requireRole("admin", "staff", "member"),
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
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const body: MySubscription = await getSubscriptionSummary(req.user.id);
    res.json(body);
  }),
);

const myEntriesQuerySchema = z.object({
  from: z.string().regex(DAY_LABEL_PATTERN),
  to: z.string().regex(DAY_LABEL_PATTERN),
});

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
  requireRole("admin", "staff", "member"),
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

    const outDevices = await db
      .collection("devices")
      .find({ direction: "out" }, { projection: { _id: 1 } })
      .toArray();
    const outDeviceIds = outDevices.map((device) => device._id.toString());

    const rows = await db
      .collection("entry_events")
      .aggregate<{ _id: string; entries: number }>([
        {
          $match: {
            userId: req.user.id,
            allowed: true,
            at: { $gte: start, $lte: end },
            $or: [
              // Direction is persisted (current record), valid even if the device was deleted.
              { direction: "in" },
              // Legacy record: no direction, so consult the current device id list.
              {
                direction: { $exists: false },
                ...(outDeviceIds.length > 0
                  ? { deviceId: { $nin: outDeviceIds } }
                  : {}),
              },
            ],
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

// Weight layer for the mobile calendar: history appended whenever weightKg changes.
meRouter.get(
  "/weight-history",
  requireRole("admin", "staff", "member"),
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
  requireRole("admin", "staff", "member"),
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

const gateScanSchema = z.object({
  qr: z.string().min(1).max(200),
  lat: z.number().optional(),
  lng: z.number().optional(),
  /** Android: expo-location mock-location detection — Phase 6 */
  mocked: z.boolean().optional(),
});

const GATE_SCAN_RATE_LIMIT = 30;
const GATE_SCAN_RATE_WINDOW_SECONDS = 60;
const GATE_OPEN_LOCK_TTL_MS = 3_000;
const GATE_OPEN_MS = 500;
const LOCATION_HISTORY_TTL_SECONDS = 120;
const LOCATION_DRIFT_WINDOW_MS = 120_000;
const LOCATION_DRIFT_THRESHOLD_M = 1000;

const GEOFENCE_MESSAGES: Record<"LOCATION_REQUIRED" | "OUT_OF_RANGE", string> =
  {
    LOCATION_REQUIRED:
      "Location information is unavailable. Enable location services and try again.",
    OUT_OF_RANGE:
      "You do not appear to be at the gym. Entry is allowed only on site.",
  };

/** Simple rate limit: 30 scan requests per user per minute. */
async function isGateScanRateLimited(userId: string): Promise<boolean> {
  const key = `og:rl:gate-scan:${userId}`;
  const count = await redis.incr(key);
  // NX: set the TTL only when absent; if a crash occurs between incr and expire,
  // the next request repairs it, avoiding a permanent key that locks the user.
  await redis.expire(key, GATE_SCAN_RATE_WINDOW_SECONDS, "NX");
  return count > GATE_SCAN_RATE_LIMIT;
}

/**
 * Identity of the requesting device. The raw session token is never written to
 * signal/audit records. Without a fingerprint header (for example iOS or web),
 * a one-way SHA-256 token hash stands in for the device identity.
 */
function resolveDeviceFingerprint(req: AuthedRequest): string | null {
  const headerFp = req.header("x-device-fingerprint");
  if (headerFp && /^[a-f0-9]{64}$/.test(headerFp)) return headerFp;
  return req.sessionToken
    ? createHash("sha256").update(req.sessionToken).digest("hex")
    : null;
}

/**
 * Phase 6: scan requests from two devices at distant locations within a short
 * interval are recorded as suspected account sharing. The request is not
 * rejected; it is processed only as a signal.
 */
async function recordLocationDrift(
  req: AuthedRequest,
  lat: number,
  lng: number,
): Promise<void> {
  const fingerprintId = resolveDeviceFingerprint(req);
  const locKey = QR_LOC_KEY(req.user.id);
  const prevRaw = await redis.get(locKey);
  if (prevRaw && fingerprintId) {
    const prev = JSON.parse(prevRaw) as {
      d: string | null;
      lat: number;
      lng: number;
      at: number;
    };
    if (
      prev.d &&
      prev.d !== fingerprintId &&
      Date.now() - prev.at < LOCATION_DRIFT_WINDOW_MS
    ) {
      const distanceM = distanceMeters(prev.lat, prev.lng, lat, lng);
      if (distanceM > LOCATION_DRIFT_THRESHOLD_M) {
        await recordSharingSignal(req.user, "location-inconsistency", {
          distanceM,
          deviceId: fingerprintId,
          prevDeviceId: prev.d,
        });
      }
    }
  }
  await redis.set(
    locKey,
    JSON.stringify({ d: fingerprintId, lat, lng, at: Date.now() }),
    { expiration: { type: "EX", value: LOCATION_HISTORY_TTL_SECONDS } },
  );
}

/** Checks distance when the gym location is configured; returns null on success. */
async function checkGymGeofence(
  lat: number | undefined,
  lng: number | undefined,
): Promise<"LOCATION_REQUIRED" | "OUT_OF_RANGE" | null> {
  const settings = await findGymSettings();
  const location = settings?.location;
  // Skip the distance check if the operator has not configured location validation.
  if (!location) return null;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return "LOCATION_REQUIRED";
  }
  const distance = distanceMeters(lat, lng, location.lat, location.lng);
  return distance > location.radiusM ? "OUT_OF_RANGE" : null;
}

// US-7: member scans the static QR attached to the gate to request entry
meRouter.post(
  "/gate-scan",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const parsed = gateScanSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid request.");
      return;
    }
    const { qr, lat, lng, mocked } = parsed.data;

    if (await isGateScanRateLimited(req.user.id)) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Too many requests. Please wait a moment.",
      );
      return;
    }

    const verified = verifyGateQr(qr);
    if (!verified.ok) {
      // Device could not be resolved; still record the event with an empty device.
      enqueueEntryEvent({
        deviceId: "",
        deviceName: "",
        userId: req.user.id,
        memberName: req.user.name,
        allowed: false,
        reason: "INVALID_QR",
        at: new Date(),
        direction: "in",
      });
      sendApiError(
        res,
        403,
        "INVALID_QR",
        "Invalid QR code. Scan the code on the gate again.",
      );
      return;
    }
    const { deviceId } = verified;

    // Read the device before rejection checks so its name appears in every
    // subsequent denial record.
    const device = await db
      .collection("devices")
      .findOne({ _id: new ObjectId(deviceId) });
    const deviceName = device ? (device.name as string) : "";
    const direction = (device?.direction as "in" | "out" | undefined) ?? "in";

    // Every denial produces both a response and an entry_events audit record.
    const deny = (reason: GateRejectCode, message: string): void => {
      enqueueEntryEvent({
        deviceId,
        deviceName,
        userId: req.user.id,
        memberName: req.user.name,
        allowed: false,
        reason,
        at: new Date(),
        direction,
      });
      sendApiError(res, 403, reason, message);
    };

    if (!device) {
      deny(
        "UNKNOWN_DEVICE",
        "This gate is no longer registered. Contact reception.",
      );
      return;
    }

    // Phase 6: gate access is temporarily blocked for accounts above the escalation threshold.
    if (await isQrBlocked(req.user.id)) {
      deny(
        "SHARING_BLOCKED",
        "Unusual activity was detected on your account. Entry is temporarily blocked. Contact reception.",
      );
      return;
    }

    // Phase 6: expo-location's "mocked" flag identifies fake-location apps and
    // denies entry. This works even without a configured gym location and runs
    // BEFORE writing location history (QR_LOC_KEY), so fake coordinates do not
    // feed the location-inconsistency signal.
    if (mocked === true) {
      await recordSharingSignal(req.user, "mock-location", { lat, lng });
      deny(
        "MOCK_LOCATION",
        "Mock location detected. Disable location-spoofing apps and try again.",
      );
      return;
    }

    // Do not check subscriptions on exit; a member with an expired subscription must be able to leave.
    if (direction === "in" && !(await hasActiveSubscription(req.user.id))) {
      deny(
        "NO_ACTIVE_SUBSCRIPTION",
        "You do not have an active subscription. Contact gym reception.",
      );
      return;
    }

    if (typeof lat === "number" && typeof lng === "number") {
      await recordLocationDrift(req, lat, lng);
    }

    const geofenceReject = await checkGymGeofence(lat, lng);
    if (geofenceReject) {
      deny(geofenceReject, GEOFENCE_MESSAGES[geofenceReject]);
      return;
    }

    // Short duplicate-scan lock for consecutive scans by the same member and device.
    const lockKey = `og:gate-open:${req.user.id}:${deviceId}`;
    const lockToken = randomUUID();
    if (!(await acquireLock(lockKey, lockToken, GATE_OPEN_LOCK_TTL_MS))) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Too many requests. Please wait a moment.",
      );
      return;
    }

    if (!openDevice(deviceId, GATE_OPEN_MS)) {
      // The gate did not open; release the lock so the member can retry as soon
      // as the connection returns.
      await releaseLock(lockKey, lockToken);
      deny("DEVICE_OFFLINE", "The gate is offline. Contact reception.");
      return;
    }

    if (direction === "out") {
      await markOutside(req.user.id);
    } else {
      await markInside(req.user.id);
    }
    enqueueEntryEvent({
      deviceId,
      deviceName,
      userId: req.user.id,
      memberName: req.user.name,
      allowed: true,
      reason: null,
      at: new Date(),
      direction,
    });

    const body: GateScanResponse = {
      ok: true,
      deviceName,
      direction,
      openMs: GATE_OPEN_MS,
    };
    res.json(body);
  }),
);

// Phase 5 — US-4: live gym occupancy
meRouter.get(
  "/occupancy",
  requireRole("admin", "staff", "member"),
  async (_req, res) => {
    const inside = await getOccupancy();
    const settings = await findGymSettings();
    const capacity = settings?.capacity ?? null;
    const body: OccupancyResponse = {
      inside,
      capacity,
      ratio: capacity ? Math.round((inside / capacity) * 100) / 100 : null,
    };
    res.json(body);
  },
);

// Phase 5 — Data protection: member's own account deletion request status
meRouter.get(
  "/deletion-request",
  requireRole("admin", "staff", "member"),
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
  requireRole("admin", "staff", "member"),
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
  requireRole("admin", "staff", "member"),
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
