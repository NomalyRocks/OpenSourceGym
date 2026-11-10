import { Router } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  ApiErrorCode,
  DeviceMode,
  GateDeviceSummary,
} from "@opengym/shared";
import { db, userCollection } from "../../core/db.js";
import { isGateOpenRateLimited } from "./locks.js";
import { sendApiError } from "../../core/apiError.js";
import { logAudit } from "../../core/audit.js";
import { gymScoped, requireGymAccess } from "../../core/middleware.js";
import { isDeviceOnline } from "../devices/gateway.js";
import { passGate, type PassingUser, type PassageEvent } from "./pass.js";

export const receptionRouter: Router = Router({ mergeParams: true });

export const gateOpenSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  deviceId: z.string().regex(/^[a-f\d]{24}$/i),
  direction: z.enum(["in", "out"]),
  reason: z.string().trim().min(3).max(200),
});

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
    const parsed = gateOpenSchema.safeParse(req.body ?? {});
    let deviceName = "";
    let memberName: string | null = null;
    // Invalid requests still have an event and audit trail; retain only validated fields.
    const identity = z.object({
      userId: gateOpenSchema.shape.userId.optional().catch(undefined),
      deviceId: gateOpenSchema.shape.deviceId.optional().catch(undefined),
      direction: gateOpenSchema.shape.direction.optional().catch(undefined),
      reason: gateOpenSchema.shape.reason.optional().catch(undefined),
    });
    const fields = parsed.success
      ? parsed.data
      : identity.partial().safeParse(req.body).data;
    async function record(
      allowed: boolean,
      code: ApiErrorCode | null,
      event?: PassageEvent,
    ) {
      await db.collection("entry_events").insertOne({
        gymId,
        deviceId: fields?.deviceId ?? "",
        deviceName,
        userId: fields?.userId ?? null,
        memberName,
        direction: fields?.direction ?? "in",
        distanceM: null,
        at: new Date(),
        ...event,
        allowed,
        // Validation errors are API codes; only passage refusals belong in reason.
        reason: event?.reason ?? (code === "RATE_LIMITED" ? code : null),
        source: "reception",
        actorId: req.user.id,
        actorName: req.user.name,
        staffReason: fields?.reason ?? null,
      });
      await logAudit(
        req.user,
        allowed ? "gate-opened-by-staff" : "gate-open-refused",
        fields?.userId,
        {
          deviceId: fields?.deviceId ?? null,
          direction: fields?.direction ?? null,
          staffReason: fields?.reason ?? null,
          code,
        },
        gymId,
      );
    }
    async function refuse(status: number, code: ApiErrorCode, message: string) {
      await record(false, code);
      sendApiError(res, status, code, message);
    }
    // Count every scoped request, including invalid requests and repeated refusals.
    if (await isGateOpenRateLimited(req.user.id)) {
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
    const target = await userCollection().findOne({
      _id: new ObjectId(userId),
    });
    if (!target) {
      await refuse(404, "USER_NOT_FOUND", "The user was not found.");
      return;
    }
    memberName = target.name;
    const role = target.role ?? "member";
    const user: PassingUser = {
      id: userId,
      name: target.name,
      email: target.email,
      role,
      gymIds: role === "admin" || role === "staff" ? (target.gymIds ?? []) : [],
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
  }),
);
