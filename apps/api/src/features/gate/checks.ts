import { createHash } from "node:crypto";
import type { GateRejectCode } from "@opengym/shared";
import { db } from "../../db.js";
import { redis } from "../../redis.js";
import type { AuthedRequest } from "../../middleware.js";
import { distanceMeters, evaluateGeofence } from "../../geo.js";
import { isDeviceOnline } from "../../gateway.js";
import { isInside } from "../../occupancy.js";
import { recordSharingSignal, QR_LOC_KEY } from "../../sharing.js";
import type { GymDoc } from "../../gyms.js";

const GATE_SCAN_RATE_LIMIT = 30;
const GATE_SCAN_RATE_WINDOW_SECONDS = 60;
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

export const GEOFENCE_MESSAGES: Record<GeofenceReject, string> = {
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
export async function isGateScanRateLimited(userId: string): Promise<boolean> {
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
export async function recordLocationDrift(
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

export type GeofenceReject =
  "LOCATION_REQUIRED" | "OUT_OF_RANGE" | "GYM_LOCATION_UNSET";

interface GeofenceResult {
  reject: GeofenceReject | null;
  /** Metres from the gym, when both the phone position and the gym location are known. */
  distanceM: number | null;
}

/** Applies {@link evaluateGeofence} to the scanned gym's configured location. */
export function checkGymGeofence(
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
export async function checkAntiPassback(
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
export async function clearEntryCooldown(
  gymId: string,
  userId: string,
): Promise<void> {
  await redis.del(entryCooldownKey(gymId, userId));
}
