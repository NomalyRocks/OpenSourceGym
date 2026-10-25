import { Router } from "express";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { GateRejectCode, GateScanResponse } from "@opengym/shared";
import { db } from "../../db.js";
import { sendApiError } from "../../apiError.js";
import { acquireLock, releaseLock } from "../../redis.js";
import { authed, requireRole } from "../../middleware.js";
import { distanceMeters } from "../../geo.js";
import { isImpossibleTravel } from "../../travel.js";
import { verifyGateQr } from "../../gateQr.js";
import {
  checkEntryDuringFreeze,
  endFreeze,
  findOpenFreeze,
  settlePendingCredit,
} from "../../freeze.js";
import { checkEntrySubscription } from "../../subscriptions.js";
import { canAccessGym, findGym } from "../../gyms.js";
import { openDevice } from "../../gateway.js";
import {
  closeInsideRecordsElsewhere,
  hasAutoExitMarker,
  hasInsideRecord,
  markInside,
  markOutside,
} from "../../occupancy.js";
import { enqueueEntryEvent } from "../../eventQueue.js";
import { logMemberAudit } from "../../memberScope.js";
import { isQrBlocked, recordSharingSignal } from "../../sharing.js";
import {
  checkAntiPassback,
  checkGymGeofence,
  clearEntryCooldown,
  GEOFENCE_MESSAGES,
  isGateScanRateLimited,
  recordLocationDrift,
} from "./checks.js";

/** `POST /api/me/gate-scan`, mounted by `meRouter`. */
export const gateScanRouter: Router = Router();

const gateScanSchema = z.object({
  qr: z.string().min(1).max(200),
  lat: z.number().optional(),
  lng: z.number().optional(),
  /** Android: expo-location mock-location detection — Phase 6 */
  mocked: z.boolean().optional(),
});

const GATE_OPEN_LOCK_TTL_MS = 3_000;
const GATE_OPEN_MS = 500;
// The turnstile is already open: on a timeout the freeze stays open and the next entry scan ends it.
const GATE_FREEZE_END_WAIT_MS = 1_000;

// US-7: member scans the static QR attached to the gate to request entry
gateScanRouter.post(
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
