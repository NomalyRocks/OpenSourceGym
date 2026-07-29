import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Device, DeviceCreated, DeviceDirection } from "@opengym/shared";
import { db, toObjectId } from "../db.js";
import { sendApiError } from "../apiError.js";
import { logAudit } from "../audit.js";
import { authed, requireRole } from "../middleware.js";
import { disconnectDevice, isDeviceOnline } from "../gateway.js";
import { computeUptimes24h } from "../deviceStatus.js";
import { gateQrContent } from "../gateQr.js";

export const devicesRouter: Router = Router();

const createDeviceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  direction: z.enum(["in", "out"]).default("in"),
});

// Turnike cihazı kaydı — token yalnızca bu yanıtta bir kez görünür, sunucuda hash'i saklanır
devicesRouter.post(
  "/",
  requireRole("admin"),
  authed(async (req, res) => {
    const parsed = createDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_DEVICE_NAME", "Invalid device name.");
      return;
    }
    const { name, direction } = parsed.data;
    const token = `og_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const inserted = await db.collection("devices").insertOne({
      name,
      direction,
      tokenHash,
      createdAt: new Date(),
      createdBy: req.user.id,
      lastSeenAt: null,
    });
    await logAudit(req.user, "device-created", inserted.insertedId.toString(), {
      name,
      direction,
    });

    const body: DeviceCreated = {
      id: inserted.insertedId.toString(),
      name,
      direction,
      token,
      qrContent: gateQrContent(inserted.insertedId.toString()),
    };
    res.json(body);
  }),
);

// Cihaz listesi — anlık bağlantı durumu Device Gateway registry'sinden, KPI-4
// uptime yüzdesi device_status_log'dan okunur
devicesRouter.get("/", requireRole("admin", "staff"), async (_req, res) => {
  const docs = await db
    .collection("devices")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  const devices = docs.map((d) => {
    const deviceId = d._id.toString();
    return { deviceId, nowOnline: isDeviceOnline(deviceId) };
  });
  const uptimes = await computeUptimes24h(devices);
  const body: Device[] = docs.map((d, index) => {
    const { deviceId: id, nowOnline: online } = devices[index]!;
    return {
      id,
      name: d.name,
      direction: (d.direction as DeviceDirection | undefined) ?? "in",
      online,
      lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
      createdAt: d.createdAt.toISOString(),
      uptime24h: uptimes.get(id)!,
      qrContent: gateQrContent(id),
    };
  });
  res.json(body);
});

// Cihaz silme — kayıtlı bağlantı varsa Gateway'den de düşürülür
devicesRouter.delete(
  "/:id",
  requireRole("admin"),
  authed(async (req, res) => {
    const targetId = toObjectId(String(req.params.id ?? ""));
    if (!targetId) {
      sendApiError(res, 404, "DEVICE_NOT_FOUND", "Device not found.");
      return;
    }
    const result = await db.collection("devices").deleteOne({ _id: targetId });
    if (result.deletedCount === 0) {
      sendApiError(res, 404, "DEVICE_NOT_FOUND", "Device not found.");
      return;
    }
    disconnectDevice(targetId.toString());
    await logAudit(req.user, "device-deleted", targetId.toString());
    res.json({ ok: true });
  }),
);
