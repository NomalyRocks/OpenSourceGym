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
import { authed, requireRole, type AuthedRequest } from "../middleware.js";
import { distanceMeters, evaluateGeofence } from "../geo.js";
import { isImpossibleTravel } from "../travel.js";
import { verifyGateQr } from "../gateQr.js";
import {
  checkEntryDuringFreeze,
  endFreeze,
  findOpenFreeze,
  getFreezeAllowance,
  settlePendingCredit,
  startFreeze,
} from "../freeze.js";
import {
  checkEntrySubscription,
  getSubscriptionSummary,
  listActiveSubscriptionGymIds,
  SubscriptionLockTimeoutError,
} from "../subscriptions.js";
import {
  canAccessGym,
  findGym,
  findGymsByIds,
  listActiveGyms,
  type GymDoc,
} from "../gyms.js";
import { isDeviceOnline, openDevice } from "../gateway.js";
import {
  closeInsideRecordsElsewhere,
  hasAutoExitMarker,
  getOccupancy,
  hasInsideRecord,
  isInside,
  markInside,
  markOutside,
} from "../occupancy.js";
import { enqueueEntryEvent } from "../eventQueue.js";
import { logAudit } from "../audit.js";
import { logMemberAudit } from "../memberScope.js";
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
// The turnstile is already open: on a timeout the freeze stays open and the next entry scan ends it.
const GATE_FREEZE_END_WAIT_MS = 1_000;
const LOCATION_HISTORY_TTL_SECONDS = 120;
const LOCATION_DRIFT_WINDOW_MS = 120_000;
const LOCATION_DRIFT_THRESHOLD_M = 1000;

/**
 * Re-entry cooldown used only when the gym has no exit turnstile registered.
 * There, nothing can mark a member outside before autoExitHours elapses, so
 * strict anti-passback would lock them out of their own gym for hours; a
 * cooldown still removes the "hold the QR photo and hammer the gate" case.
 */
const ENTRY_COOLDOWN_SECONDS = 60;

const GEOFENCE_MESSAGES: Record<GeofenceReject, string> = {
  LOCATION_REQUIRED:
    "Location information is unavailable. Enable location services and try again.",
  OUT_OF_RANGE:
    "You do not appear to be at the gym. Entry is allowed only on site.",
  // The operator has not configured the gym location. The member can do nothing
  // about it, so both the code and this message point at reception rather than
  // at their phone's location settings.
  GYM_LOCATION_UNSET:
    "Entry is unavailable because the gym location is not configured. Contact reception.",
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
  gymId: string,
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
        await recordSharingSignal(
          req.user,
          "location-inconsistency",
          {
            distanceM,
            deviceId: fingerprintId,
            prevDeviceId: prev.d,
          },
          gymId,
        );
      }
    }
  }
  await redis.set(
    locKey,
    JSON.stringify({ d: fingerprintId, lat, lng, at: Date.now() }),
    { expiration: { type: "EX", value: LOCATION_HISTORY_TTL_SECONDS } },
  );
}

type GeofenceReject =
  "LOCATION_REQUIRED" | "OUT_OF_RANGE" | "GYM_LOCATION_UNSET";

interface GeofenceResult {
  reject: GeofenceReject | null;
  /** Metres from the gym, when both the phone position and the gym location are known. */
  distanceM: number | null;
}

/** Applies {@link evaluateGeofence} to the scanned gym's configured location. */
function checkGymGeofence(
  gym: GymDoc | null,
  lat: number | undefined,
  lng: number | undefined,
): GeofenceResult {
  const { verdict, distanceM } = evaluateGeofence(gym?.location, lat, lng);
  return { reject: verdict === "OK" ? null : verdict, distanceM };
}

/**
 * Whether the member can actually scan themselves out right now.
 *
 * Strict anti-passback refuses entry while the member is marked inside, and only
 * an exit scan clears that mark. So the strict rule is safe **only** while a
 * reachable exit turnstile exists: a gym with no exit device is a supported
 * topology (`PRD.md`), and an exit device that is offline is the same situation
 * from the member's side — they cannot scan out, so refusing their entry would
 * lock them out of their own gym until `autoExitHours` elapses.
 */
async function hasUsableExitDevice(gymId: string): Promise<boolean> {
  const exitDevices = await db
    .collection("devices")
    .find({ gymId, direction: "out" }, { projection: { _id: 1 } })
    .toArray();
  return exitDevices.some((device) => isDeviceOnline(device._id.toString()));
}

/**
 * Anti-passback. Returns a member-facing message when the entry scan must be
 * refused, or null when it may proceed.
 *
 * Without this, one member could stand at the gate and open it repeatedly for a
 * queue of non-members: the only previous brakes were a 3-second per-device
 * lock and a 30/60s rate limit, which still allow roughly twenty openings a
 * minute.
 *
 * The cooldown runs in BOTH modes. On its own the strict rule is defeated by a
 * photograph of the exit QR — scan out, scan in, repeat — which is exactly the
 * abuse being prevented. The cooldown caps that loop at one opening a minute
 * regardless of which QRs the attacker holds.
 */
async function checkAntiPassback(
  gymId: string,
  userId: string,
): Promise<{ reason: GateRejectCode; message: string } | null> {
  if ((await hasUsableExitDevice(gymId)) && (await isInside(gymId, userId))) {
    return {
      reason: "ALREADY_INSIDE",
      message:
        "You are already inside. Use the exit turnstile before entering again.",
    };
  }

  // Keyed per member and gym, not per device, so a second entry gate of the
  // same gym cannot reset it.
  const fresh = await redis.set(entryCooldownKey(gymId, userId), "1", {
    condition: "NX",
    expiration: { type: "EX", value: ENTRY_COOLDOWN_SECONDS },
  });
  // A SEPARATE code from ALREADY_INSIDE. The clients render the message from the
  // code, not from this string, so sharing one code made a member who had just
  // scanned OUT be told they were still inside.
  return fresh === null
    ? {
        reason: "ENTRY_COOLDOWN",
        message:
          "You have just entered. Please wait a moment before scanning again.",
      }
    : null;
}

const entryCooldownKey = (gymId: string, userId: string): string =>
  `og:gate-cooldown:${gymId}:${userId}`;

/**
 * Undoes the cooldown claimed by {@link checkAntiPassback} when the gate never
 * actually opened. Without this an offline turnstile would cost the member a
 * full cooldown for an entry they never made.
 */
async function clearEntryCooldown(
  gymId: string,
  userId: string,
): Promise<void> {
  await redis.del(entryCooldownKey(gymId, userId));
}

// US-7: member scans the static QR attached to the gate to request entry
meRouter.post(
  "/gate-scan",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const parsed = gateScanSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid request.");
      return;
    }
    const { qr, lat, lng, mocked } = parsed.data;

    /**
     * Refusal before the QR has been resolved to a device, recorded all the
     * same — a denial that leaves no trace is not reviewable, and a run of these
     * rows against one member is itself the finding.
     *
     * These rows carry no device and no distance, and that is not an omission:
     * neither is known yet. `direction` records the same "in" that the
     * resolved-device path falls back to, because a scan whose device is unknown
     * has no direction to report. See {@link deny} for the refusals that come
     * after the device is in hand.
     */
    const denyBeforeDevice = (
      reason: GateRejectCode,
      message: string,
      status = 403,
    ): void => {
      enqueueEntryEvent({
        gymId: null,
        deviceId: "",
        deviceName: "",
        userId: req.user.id,
        memberName: req.user.name,
        allowed: false,
        reason,
        at: new Date(),
        direction: "in",
        distanceM: null,
      });
      sendApiError(res, status, reason, message);
    };

    if (await isGateScanRateLimited(req.user.id)) {
      // Throttled before the QR is parsed, so a burst costs no signature
      // verification, and no distance is resolved either — that would put a
      // Mongo read on the path a flood is already hammering.
      denyBeforeDevice(
        "RATE_LIMITED",
        "Too many requests. Please wait a moment.",
        429,
      );
      return;
    }

    const verified = verifyGateQr(qr);
    if (!verified.ok) {
      denyBeforeDevice(
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
    // The QR resolves device -> gym. A device without a resolvable gym is as
    // good as unregistered.
    const gym =
      device && typeof device.gymId === "string"
        ? await findGym(device.gymId)
        : null;
    const gymId = gym ? gym._id.toHexString() : null;

    // Resolved up front rather than at the geofence check, so that an early
    // denial (unknown device, sharing block, no subscription) still records
    // where the attempt came from. Otherwise those rows are indistinguishable
    // from a scan that carried no coordinates at all.
    const geofence = checkGymGeofence(gym, lat, lng);
    const scanDistanceM = geofence.distanceM;

    // Every denial produces both a response and an entry_events audit record.
    // The status is a parameter because throttling answers 429 while the access
    // decisions answer 403 — but both are refusals and both must be reviewable.
    // The counterpart to {@link denyBeforeDevice}: this one names the device and
    // the scan distance, so it is the form to prefer wherever both are known.
    const deny = (
      reason: GateRejectCode,
      message: string,
      status = 403,
    ): void => {
      enqueueEntryEvent({
        gymId,
        deviceId,
        deviceName,
        userId: req.user.id,
        memberName: req.user.name,
        allowed: false,
        reason,
        at: new Date(),
        direction,
        distanceM: scanDistanceM,
      });
      sendApiError(res, status, reason, message);
    };

    if (!device || !gym || !gymId) {
      deny(
        "UNKNOWN_DEVICE",
        "This gate is no longer registered. Contact reception.",
      );
      return;
    }

    // A banned member is refused ENTRY only; an exit is never blocked, so a
    // ban cannot trap someone inside. `ban` comes from the per-request re-read.
    if (direction === "in" && req.user.ban) {
      deny("BANNED", "Your account is banned. Contact reception.");
      return;
    }

    // A deactivated gym refuses every ENTRY scan; exits are never refused, so
    // nobody is trapped inside when the owner deactivates a gym.
    if (direction === "in" && !gym.active) {
      deny("GYM_INACTIVE", "This gym is currently closed. Contact reception.");
      return;
    }

    // Phase 6: gate access is temporarily blocked for accounts above the
    // escalation threshold. Entry only — a member already inside when the block
    // lands must still be able to walk out of the building.
    if (direction === "in" && (await isQrBlocked(req.user.id))) {
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
      // The signal is recorded either way; only entry is refused. A spoofed
      // location cannot fake someone OUT of a building they are standing in, so
      // refusing the exit would only trap them.
      await recordSharingSignal(req.user, "mock-location", { lat, lng }, gymId);
      if (direction === "in") {
        deny(
          "MOCK_LOCATION",
          "Mock location detected. Disable location-spoofing apps and try again.",
        );
        return;
      }
    }

    // An interrupted freeze credit is settled first, so the periods judged below
    // are final. A failure is logged and the scan continues with the normal check.
    if (direction === "in" && req.user.role === "member") {
      try {
        await settlePendingCredit(new ObjectId(req.user.id));
      } catch (error) {
        console.error("pending freeze credit settle failed:", error);
      }
    }

    // Soft unfreeze: an entry scan by a frozen member resumes the membership.
    // The freeze is NOT ended here: a scan refused further down (wrong gym,
    // anti-passback, offline gate, ...) must leave it untouched. The decision
    // below is a dry run of the credit; the freeze really ends only after the
    // turnstile has opened.
    const frozen =
      direction === "in" && req.user.role === "member"
        ? await findOpenFreeze(new ObjectId(req.user.id))
        : null;

    // Do not check subscriptions on exit; a member with an expired subscription must be able to leave.
    // Staff pass the subscription check at their own gyms (the owner at every
    // gym): they still go through the QR flow, geofence and anti-passback.
    if (direction === "in" && !canAccessGym(req.user, gymId)) {
      const subscription = frozen
        ? await checkEntryDuringFreeze(req.user.id, gymId, frozen)
        : await checkEntrySubscription(req.user.id, gymId);
      if (subscription === "none") {
        deny(
          "NO_ACTIVE_SUBSCRIPTION",
          "You do not have an active subscription. Contact gym reception.",
        );
        return;
      }
      if (subscription === "other-gym") {
        deny(
          "NOT_ALLOWED_AT_GYM",
          "Your subscription does not include this gym. Contact gym reception.",
        );
        return;
      }
    }

    if (typeof lat === "number" && typeof lng === "number") {
      await recordLocationDrift(req, lat, lng, gymId);
    }

    // The geofence guards ENTRY only. It defends against someone opening the
    // gate remotely with a photographed QR, which is a way IN — refusing an exit
    // scan does not prevent that, it traps a member inside a building over a
    // missing GPS fix or an unconfigured setting. The distance is still recorded
    // above, so a remote exit scan remains reviewable.
    if (direction === "in" && geofence.reject) {
      deny(geofence.reject, GEOFENCE_MESSAGES[geofence.reject]);
      return;
    }

    if (direction === "in") {
      const passback = await checkAntiPassback(gymId, req.user.id);
      if (passback) {
        deny(passback.reason, passback.message);
        return;
      }
    } else if (
      !(await hasInsideRecord(gymId, req.user.id)) &&
      // A record closed by an entry at another gym does not revoke the right
      // to leave: "exit is never refused" for someone who may still be inside.
      !(await hasAutoExitMarker(gymId, req.user.id))
    ) {
      // Symmetric anti-passback on the way out. Safe to refuse — and only
      // refused — when there is no record of the member ever coming in, so it
      // cannot trap anyone: someone with no entry record is by definition not in
      // the building. Without it the exit QR opened the gate on demand, and each
      // scan also cleared the inside flag, handing back a free reset of the
      // strict rule above.
      deny(
        "NOT_INSIDE",
        "You are not recorded as having entered the gym. Contact reception.",
      );
      return;
    }

    // Duplicate-scan lock, keyed per MEMBER rather than per member+device: with a
    // device-scoped key, two entry turnstiles scanned at once both read "outside"
    // and both open. One member cannot legitimately pass two gates in 3 seconds.
    const lockKey = `og:gate-open:${req.user.id}`;
    const lockToken = randomUUID();
    if (!(await acquireLock(lockKey, lockToken, GATE_OPEN_LOCK_TTL_MS))) {
      // Logged like the other refusals: this is where a member's QR being
      // presented at two turnstiles at once shows up, which is precisely the
      // pattern a reviewer is looking for.
      deny("RATE_LIMITED", "Too many requests. Please wait a moment.", 429);
      return;
    }

    if (!openDevice(deviceId, GATE_OPEN_MS)) {
      // The gate did not open; release the lock and the anti-passback cooldown
      // so the member can retry as soon as the connection returns.
      await releaseLock(lockKey, lockToken);
      if (direction === "in") await clearEntryCooldown(gymId, req.user.id);
      deny("DEVICE_OFFLINE", "The gate is offline. Contact reception.");
      return;
    }

    // The relay has already fired: the member is walking through a turnstile
    // that is physically open. An occupancy write that fails here must not turn
    // that into a 500 with no audit record — worse, on exit a failed markOutside
    // would leave the member flagged inside and refused re-entry for hours.
    let autoExitedGymId: string | null = null;
    try {
      if (direction === "out") {
        await markOutside(gymId, req.user.id);
      } else {
        // A member is inside at most one gym: entering here closes any record
        // elsewhere, and an implausible hop between the two gyms is a sharing
        // signal (the entry itself is not refused).
        const closed = await closeInsideRecordsElsewhere(req.user.id, gymId);
        await markInside(gymId, req.user.id);
        const previous = closed[0];
        if (previous) {
          autoExitedGymId = previous.gymId;
          const previousGym = await findGym(previous.gymId);
          const travel = isImpossibleTravel(
            previousGym?.location ?? null,
            gym.location ?? null,
            distanceMeters,
            Date.now() - previous.enteredAt,
          );
          if (travel.impossible) {
            await recordSharingSignal(
              req.user,
              "location-inconsistency",
              {
                fromGymId: previous.gymId,
                toGymId: gymId,
                distanceM: travel.distanceM,
                speedKmh: travel.speedKmh,
              },
              gymId,
            );
          }
        }
      }
    } catch (error) {
      console.error("occupancy update failed after the gate opened:", error);
    }
    // Every refusal has passed and the gate is open: only now does the freeze
    // end. The member is already walking through, so a failure here is logged
    // and never turns into a refusal. The next entry scan retries: an open
    // freeze is ended again, and an interrupted credit is settled before the
    // decision (settlePendingCredit), as the hourly reaper also does.
    let unfrozen = false;
    if (frozen) {
      try {
        const ended = await endFreeze(new ObjectId(req.user.id), {
          reason: "gate-scan",
          endedBy: req.user.id,
          lockWaitMs: GATE_FREEZE_END_WAIT_MS,
        });
        if (ended.status === "ended") {
          unfrozen = true;
          await logMemberAudit(
            req.user,
            "subscription-unfrozen",
            new ObjectId(req.user.id),
            {
              freezeId: ended.freeze._id.toHexString(),
              startedAt: ended.freeze.startedAt.toISOString(),
              endedAt: ended.freeze.endedAt?.toISOString() ?? null,
              creditedMs: ended.creditedMs,
              reason: "gate-scan",
            },
          );
        }
      } catch (error) {
        console.error("freeze end failed after the gate opened:", error);
      }
    }
    enqueueEntryEvent({
      gymId,
      autoExitedGymId,
      deviceId,
      deviceName,
      userId: req.user.id,
      memberName: req.user.name,
      allowed: true,
      reason: null,
      at: new Date(),
      direction,
      distanceM: scanDistanceM,
    });

    const body: GateScanResponse = {
      ok: true,
      deviceName,
      direction,
      openMs: GATE_OPEN_MS,
      ...(unfrozen ? { unfrozen: true } : {}),
    };
    res.json(body);
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
      const ids = await listActiveSubscriptionGymIds(req.user.id);
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
