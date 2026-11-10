import { Router } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { DeviceMode, GateRejectCode } from "@opengym/shared";
import { db } from "../../core/db.js";
import { sendApiError } from "../../core/apiError.js";
import { authed, requireRole } from "../../core/middleware.js";
import { verifyGateQr } from "./gateQr.js";
import { resolveScanDirection } from "./scanDirection.js";
import { findGym } from "../gyms/gyms.js";
import { enqueueEntryEvent } from "./eventQueue.js";
import { recordSharingSignal } from "./sharing.js";
import {
  checkGymGeofence,
  GEOFENCE_MESSAGES,
  isGateScanRateLimited,
  recordLocationDrift,
} from "./checks.js";

import { passGate } from "./pass.js";

/** `POST /api/me/gate-scan`, mounted by `meRouter`. */
export const gateScanRouter: Router = Router();

const gateScanSchema = z.object({
  qr: z.string().min(1).max(200),
  lat: z.number().optional(),
  lng: z.number().optional(),
  /** Android: expo-location mock-location detection — Phase 6 */
  mocked: z.boolean().optional(),
});

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
    const direction = resolveScanDirection(
      (device?.direction as DeviceMode | undefined) ?? "in",
      verified.side,
    );
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
        // An incompatible QR has no resolved scan direction; keep the denial fallback.
        direction: direction ?? "in",
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

    if (direction === null) {
      deny("INVALID_QR", "Invalid QR code. Scan the code on the gate again.");
      return;
    }

    const result = await passGate({
      user: req.user,
      gym,
      deviceId,
      deviceName,
      direction,
      distanceM: scanDistanceM,
      record: enqueueEntryEvent,
      beforeSubscription: async () => {
        if (mocked === true) {
          await recordSharingSignal(
            req.user,
            "mock-location",
            { lat, lng },
            gymId,
          );
          if (direction === "in")
            return {
              code: "MOCK_LOCATION",
              message:
                "Mock location detected. Disable location-spoofing apps and try again.",
            };
        }
        return null;
      },
      beforePassage: async () => {
        if (typeof lat === "number" && typeof lng === "number")
          await recordLocationDrift(req, lat, lng, gymId);
        return direction === "in" && geofence.reject
          ? {
              code: geofence.reject,
              message: GEOFENCE_MESSAGES[geofence.reject],
            }
          : null;
      },
    });
    if (result.ok) res.json(result.body);
    else
      sendApiError(
        res,
        result.failure.status ?? 403,
        result.failure.code,
        result.failure.message,
      );
  }),
);
