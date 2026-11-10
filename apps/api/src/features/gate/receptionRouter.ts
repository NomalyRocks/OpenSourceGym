import { Router } from "express";
import { ObjectId } from "mongodb";
import type {
  ApiErrorCode,
  DeviceMode,
  GateDeviceSummary,
} from "@opengym/shared";
import { db, userCollection } from "../../core/db.js";
import { isGateOpenRateLimited, withGateUserLifecycleLock } from "./locks.js";
import { gateOpenIdentitySchema, gateOpenSchema } from "./receptionInput.js";
import { SubscriptionLockTimeoutError } from "../subscriptions/subscriptions.js";
import { sendApiError } from "../../core/apiError.js";
import { logAudit } from "../../core/audit.js";
import { gymScoped, requireGymAccess } from "../../core/middleware.js";
import { isDeviceOnline } from "../devices/gateway.js";
import { passGate, type PassingUser, type PassageEvent } from "./pass.js";

export const receptionRouter: Router = Router({ mergeParams: true });

receptionRouter.get(
  "/gate-devices",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const devices = await db
      .collection("devices")
      .find(
        { gymId: req.gym._id.toHexString() },
        { projection: { _id: 1, name: 1, direction: 1 } },
      )
      .toArray();
    const body: GateDeviceSummary[] = devices.map((device) => ({
      id: device._id.toHexString(),
      name: device.name as string,
      direction: (device.direction as DeviceMode | undefined) ?? "in",
      online: isDeviceOnline(device._id.toHexString()),
    }));
    res.json(body);
  }),
);

receptionRouter.post(
  "/gate-open",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const gymId = req.gym._id.toHexString();
    const actor = { ...req.user, id: new ObjectId(req.user.id).toHexString() };
    const parsed = gateOpenSchema.safeParse(req.body ?? {});
    let deviceName = "";
    let memberName: string | null = null;
    // Valid IDs are already canonical, including on otherwise malformed requests.
    const fields = parsed.success
      ? parsed.data
      : gateOpenIdentitySchema.safeParse(req.body).data;
    let targetExists = false;
    let assertLifecycleOwned: (() => Promise<void>) | null = null;
    async function record(
      allowed: boolean,
      code: ApiErrorCode | null,
      event?: PassageEvent,
    ) {
      // Outside the lifecycle lock (including timeouts), never retain target PII.
      const retainTarget = targetExists && assertLifecycleOwned !== null;
      await assertLifecycleOwned?.();
      await db.collection("entry_events").insertOne({
        gymId,
        deviceId: fields?.deviceId ?? "",
        deviceName,
        direction: fields?.direction ?? "in",
        distanceM: null,
        at: new Date(),
        ...event,
        allowed,
        // Validation errors are API codes; only passage refusals belong in reason.
        reason: event?.reason ?? (code === "RATE_LIMITED" ? code : null),
        source: "reception",
        actorId: actor.id,
        actorName: actor.name,
        userId: retainTarget ? fields!.userId : null,
        memberName: retainTarget ? memberName : null,
        staffReason: retainTarget ? (fields?.reason ?? null) : null,
      });
      await logAudit(
        actor,
        allowed ? "gate-opened-by-staff" : "gate-open-refused",
        retainTarget ? fields?.userId : undefined,
        {
          deviceId: fields?.deviceId ?? null,
          direction: fields?.direction ?? null,
          staffReason: retainTarget ? (fields?.reason ?? null) : null,
          code,
        },
        gymId,
      );
    }
    async function refuse(status: number, code: ApiErrorCode, message: string) {
      await record(false, code);
      sendApiError(res, status, code, message);
    }
    // Count malformed and refused requests too; their logging still obeys lifecycle serialization.
    const limited = await isGateOpenRateLimited(actor.id);
    async function attempt() {
      const target = fields?.userId
        ? await userCollection().findOne({ _id: new ObjectId(fields.userId) })
        : null;
      targetExists =
        target !== null &&
        typeof target.name === "string" &&
        typeof target.email === "string";
      memberName = targetExists ? target!.name : null;
      if (limited) {
        await refuse(
          429,
          "RATE_LIMITED",
          "Too many requests. Please wait a moment.",
        );
        return;
      }
      if (!parsed.success) {
        await refuse(400, "INVALID_REQUEST", "Invalid request.");
        return;
      }
      if (!target || !targetExists) {
        await refuse(404, "USER_NOT_FOUND", "The user was not found.");
        return;
      }
      const { userId, deviceId, direction } = parsed.data;
      const device = await db
        .collection("devices")
        .findOne({ _id: new ObjectId(deviceId), gymId });
      if (!device) {
        await refuse(404, "DEVICE_NOT_FOUND", "The device was not found.");
        return;
      }
      deviceName = device.name as string;
      const mode = (device.direction as DeviceMode | undefined) ?? "in";
      if (mode !== "both" && mode !== direction) {
        await refuse(
          400,
          "INVALID_DIRECTION",
          "The device does not support this direction.",
        );
        return;
      }
      memberName = target.name;
      const role = target.role ?? "member";
      const user: PassingUser = {
        id: userId,
        name: target.name,
        email: target.email,
        role,
        gymIds:
          role === "admin" || role === "staff" ? (target.gymIds ?? []) : [],
        ban: target.ban
          ? {
              reason: target.ban.reason,
              bannedAt: target.ban.bannedAt.toISOString(),
            }
          : null,
      };
      const result = await passGate({
        user,
        gym: req.gym,
        deviceId,
        deviceName,
        direction,
        distanceM: null,
        record: (event) => record(event.allowed, event.reason, event),
      });
      if (result.ok) res.json(result.body);
      else
        sendApiError(
          res,
          result.failure.status ?? 403,
          result.failure.code,
          result.failure.message,
        );
    }
    if (!fields?.userId) {
      await attempt();
      return;
    }
    try {
      await withGateUserLifecycleLock(fields.userId, async (assertOwned) => {
        assertLifecycleOwned = assertOwned;
        await assertOwned();
        await attempt();
      });
    } catch (error) {
      if (!(error instanceof SubscriptionLockTimeoutError)) throw error;
      assertLifecycleOwned = null;
      targetExists = false;
      await refuse(
        503,
        "SUBSCRIPTION_BUSY",
        "A member operation is in progress. Please try again.",
      );
    }
  }),
);
