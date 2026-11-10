import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import type {
  DeviceDirection,
  GateRejectCode,
  GateScanResponse,
} from "@opengym/shared";
import type { SessionUser } from "../../core/middleware.js";
import { acquirePassageLock, releasePassageLock } from "./locks.js";
import { distanceMeters } from "../../lib/geo.js";
import { isImpossibleTravel } from "./travel.js";
import {
  checkEntryDuringFreeze,
  endFreeze,
  findOpenFreeze,
  settlePendingCredit,
} from "../freeze/freeze.js";
import { checkEntrySubscription } from "../subscriptions/subscriptions.js";
import { canAccessGym, findGym, type GymDoc } from "../gyms/gyms.js";
import { openDevice } from "../devices/gateway.js";
import {
  closeInsideRecordsElsewhere,
  hasAutoExitMarker,
  hasInsideRecord,
  markInside,
  markOutside,
} from "../gyms/occupancy.js";
import { logMemberAudit } from "../members/memberScope.js";
import { isQrBlocked, recordSharingSignal } from "./sharing.js";
import { checkAntiPassback, clearEntryCooldown } from "./checks.js";

const GATE_OPEN_LOCK_TTL_MS = 3_000;
const GATE_OPEN_MS = 500;
const GATE_FREEZE_END_WAIT_MS = 1_000;

export type PassingUser = Pick<
  SessionUser,
  "id" | "email" | "name" | "role" | "gymIds" | "ban"
>;
export interface GateFailure {
  code: GateRejectCode;
  message: string;
  status?: number;
}
export interface PassageEvent {
  gymId: string;
  deviceId: string;
  deviceName: string;
  userId: string;
  memberName: string;
  allowed: boolean;
  reason: GateRejectCode | null;
  at: Date;
  direction: DeviceDirection;
  distanceM: number | null;
  autoExitedGymId?: string | null;
}
export type GatePassResult =
  { ok: true; body: GateScanResponse } | { ok: false; failure: GateFailure };

/** Shared passage controls; transport-specific QR/location checks keep their original ordering. */
export async function passGate({
  user,
  gym,
  deviceId,
  deviceName,
  direction,
  distanceM,
  record,
  beforeSubscription,
  beforePassage,
}: {
  user: PassingUser;
  gym: GymDoc;
  deviceId: string;
  deviceName: string;
  direction: DeviceDirection;
  distanceM: number | null;
  record: (event: PassageEvent) => void | Promise<void>;
  beforeSubscription?: () => Promise<GateFailure | null>;
  beforePassage?: () => Promise<GateFailure | null>;
}): Promise<GatePassResult> {
  const gymId = gym._id.toHexString();
  async function deny(
    codeOrFailure: GateRejectCode | GateFailure,
    message = "",
    status = 403,
  ): Promise<GatePassResult> {
    const failure =
      typeof codeOrFailure === "string"
        ? { code: codeOrFailure, message, status }
        : codeOrFailure;
    await record({
      gymId,
      deviceId,
      deviceName,
      userId: user.id,
      memberName: user.name,
      allowed: false,
      reason: failure.code,
      at: new Date(),
      direction,
      distanceM,
    });
    return { ok: false, failure };
  }
  // A banned member is refused ENTRY only; an exit is never blocked, so a
  // ban cannot trap someone inside. `ban` comes from the per-request re-read.
  if (direction === "in" && user.ban) {
    return deny("BANNED", "Your account is banned. Contact reception.");
  }

  // A deactivated gym refuses every ENTRY scan; exits are never refused, so
  // nobody is trapped inside when the owner deactivates a gym.
  if (direction === "in" && !gym.active) {
    return deny(
      "GYM_INACTIVE",
      "This gym is currently closed. Contact reception.",
    );
  }

  // Phase 6: gate access is temporarily blocked for accounts above the
  // escalation threshold. Entry only — a member already inside when the block
  // lands must still be able to walk out of the building.
  if (direction === "in" && (await isQrBlocked(user.id))) {
    return deny(
      "SHARING_BLOCKED",
      "Unusual activity was detected on your account. Entry is temporarily blocked. Contact reception.",
    );
  }

  const beforeSubscriptionFailure = await beforeSubscription?.();
  if (beforeSubscriptionFailure) return deny(beforeSubscriptionFailure);

  // An interrupted freeze credit is settled first, so the periods judged below
  // are final. A failure is logged and the scan continues with the normal check.
  if (direction === "in" && user.role === "member") {
    try {
      await settlePendingCredit(new ObjectId(user.id));
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
    direction === "in" && user.role === "member"
      ? await findOpenFreeze(new ObjectId(user.id))
      : null;

  // Do not check subscriptions on exit; a member with an expired subscription must be able to leave.
  // Staff pass the subscription check at their own gyms (the owner at every
  // gym): they still go through the QR flow, geofence and anti-passback.
  if (direction === "in" && !canAccessGym(user, gymId)) {
    const subscription = frozen
      ? await checkEntryDuringFreeze(user.id, gymId, frozen)
      : await checkEntrySubscription(user.id, gymId);
    if (subscription === "none") {
      return deny(
        "NO_ACTIVE_SUBSCRIPTION",
        "You do not have an active subscription. Contact gym reception.",
      );
    }
    if (subscription === "other-gym") {
      return deny(
        "NOT_ALLOWED_AT_GYM",
        "Your subscription does not include this gym. Contact gym reception.",
      );
    }
  }

  const beforePassageFailure = await beforePassage?.();
  if (beforePassageFailure) return deny(beforePassageFailure);

  if (direction === "in") {
    const passback = await checkAntiPassback(gymId, user.id);
    if (passback) {
      return deny(passback.reason, passback.message);
    }
  } else if (
    !(await hasInsideRecord(gymId, user.id)) &&
    // A record closed by an entry at another gym does not revoke the right
    // to leave: "exit is never refused" for someone who may still be inside.
    !(await hasAutoExitMarker(gymId, user.id))
  ) {
    // Symmetric anti-passback on the way out. Safe to refuse — and only
    // refused — when there is no record of the member ever coming in, so it
    // cannot trap anyone: someone with no entry record is by definition not in
    // the building. Without it the exit QR opened the gate on demand, and each
    // scan also cleared the inside flag, handing back a free reset of the
    // strict rule above.
    return deny(
      "NOT_INSIDE",
      "You are not recorded as having entered the gym. Contact reception.",
    );
  }

  // Duplicate-scan lock, keyed per MEMBER rather than per member+device: with a
  // device-scoped key, two entry turnstiles scanned at once both read "outside"
  // and both open. One member cannot legitimately pass two gates in 3 seconds.
  const lockToken = randomUUID();
  if (!(await acquirePassageLock(user.id, lockToken, GATE_OPEN_LOCK_TTL_MS))) {
    // Logged like the other refusals: this is where a member's QR being
    // presented at two turnstiles at once shows up, which is precisely the
    // pattern a reviewer is looking for.
    return deny(
      "RATE_LIMITED",
      "Too many requests. Please wait a moment.",
      429,
    );
  }

  if (!openDevice(deviceId, GATE_OPEN_MS, direction)) {
    // The gate did not open; release the lock and the anti-passback cooldown
    // so the member can retry as soon as the connection returns.
    await releasePassageLock(user.id, lockToken);
    if (direction === "in") await clearEntryCooldown(gymId, user.id);
    return deny("DEVICE_OFFLINE", "The gate is offline. Contact reception.");
  }

  // The relay has already fired: the member is walking through a turnstile
  // that is physically open. An occupancy write that fails here must not turn
  // that into a 500 with no audit record — worse, on exit a failed markOutside
  // would leave the member flagged inside and refused re-entry for hours.
  let autoExitedGymId: string | null = null;
  try {
    if (direction === "out") {
      await markOutside(gymId, user.id);
    } else {
      // A member is inside at most one gym: entering here closes any record
      // elsewhere, and an implausible hop between the two gyms is a sharing
      // signal (the entry itself is not refused).
      const closed = await closeInsideRecordsElsewhere(user.id, gymId);
      await markInside(gymId, user.id);
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
            user,
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
      const ended = await endFreeze(new ObjectId(user.id), {
        reason: "gate-scan",
        endedBy: user.id,
        lockWaitMs: GATE_FREEZE_END_WAIT_MS,
      });
      if (ended.status === "ended") {
        unfrozen = true;
        await logMemberAudit(
          user,
          "subscription-unfrozen",
          new ObjectId(user.id),
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
  await record({
    gymId,
    autoExitedGymId,
    deviceId,
    deviceName,
    userId: user.id,
    memberName: user.name,
    allowed: true,
    reason: null,
    at: new Date(),
    direction,
    distanceM,
  });

  return {
    ok: true,
    body: {
      ok: true,
      deviceName,
      direction,
      openMs: GATE_OPEN_MS,
      ...(unfrozen ? { unfrozen: true } : {}),
    },
  };
}
