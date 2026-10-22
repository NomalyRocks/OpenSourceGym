import { Router } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  AdminStats,
  EntryEvent,
  Gym,
  GymInsideResponse,
  OccupancyResponse,
  Page,
} from "@opengym/shared";
import { sendApiError } from "../apiError.js";
import { logAudit } from "../audit.js";
import { db, gymCollection, toObjectId, userCollection } from "../db.js";
import { buildProfilePhotoUrl } from "../profilePhoto.js";
import {
  DEFAULT_AUTO_EXIT_HOURS,
  findGym,
  listGymsFor,
  toGym,
} from "../gyms.js";
import { getOccupancy, listInside } from "../occupancy.js";
import {
  GEOFENCE_RADIUS_M_DEFAULT,
  GEOFENCE_RADIUS_M_MAX,
  GEOFENCE_RADIUS_M_MIN,
} from "../geo.js";
import {
  authed,
  gymScoped,
  requireGymAccess,
  requireRole,
} from "../middleware.js";
import { dateRangeFilter, findPage, pageQuerySchema } from "../pagination.js";
import { countFrozenMembers } from "../frozenMembers.js";
import { countActiveMembers, countRenewalsDue } from "../reports.js";
import { devicesRouter } from "./devices.js";
import { gymReportsRouter } from "./reports.js";
import { toInvalidCursorResponse } from "./admin.js";

/**
 * Mounted at /api/admin/gyms. Gym CRUD is owner-only; everything under
 * `/:gymId/...` goes through requireGymAccess (owner, or admin/staff whose
 * re-read `gymIds` contain the gym).
 */
export const gymsRouter: Router = Router();

const sharingSchema = z.object({
  memberMaxSessions: z.number().int().min(1).max(10),
  staffMaxSessions: z.number().int().min(1).max(20),
  signalThreshold: z.number().int().min(1).max(20),
  signalWindowHours: z.number().int().min(1).max(168),
  qrBlockHours: z.number().int().min(1).max(168),
});

const reminderSchema = z.object({
  enabled: z.boolean(),
  // Thresholds are not deduplicated or sorted here; the sweep already chooses
  // the narrowest one. The upper bound is 90: reminders beyond it are pointless.
  daysBefore: z.array(z.number().int().min(0).max(90)).min(1).max(5),
});

const locationSchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  // Bounded, not merely positive. Consumer GPS is accurate to tens of metres
  // and worse indoors, so a radius below the minimum denies members who are
  // genuinely at the gate, and an unbounded one silently disables the check
  // that the static turnstile QR depends on.
  radiusM: z.coerce
    .number()
    .int()
    .min(GEOFENCE_RADIUS_M_MIN)
    .max(GEOFENCE_RADIUS_M_MAX)
    .default(GEOFENCE_RADIUS_M_DEFAULT),
});

const gymNameSchema = z.string().trim().min(1).max(100);
const capacitySchema = z.coerce.number().finite().positive();
const autoExitSchema = z.coerce.number().int().min(1).max(48);

const createGymSchema = z.object({
  name: gymNameSchema,
  location: locationSchema.nullish(),
  capacity: capacitySchema.nullish(),
  autoExitHours: autoExitSchema.nullish(),
});

const updateGymSchema = z.object({
  name: gymNameSchema.optional(),
  active: z.boolean().optional(),
});

const gymSettingsSchema = z.object({
  location: locationSchema.nullish(),
  capacity: capacitySchema.nullish(),
  autoExitHours: autoExitSchema.nullish(),
  // Updated only when present, so configured values are never silently reset.
  sharing: sharingSchema.optional(),
  reminders: reminderSchema.optional(),
});

function sendInvalidField(
  res: Parameters<typeof sendApiError>[0],
  field: string,
): void {
  switch (field) {
    case "location":
      sendApiError(
        res,
        400,
        "INVALID_LOCATION",
        "Invalid location information.",
      );
      return;
    case "capacity":
      sendApiError(res, 400, "INVALID_CAPACITY", "Invalid capacity.");
      return;
    case "autoExitHours":
      sendApiError(
        res,
        400,
        "INVALID_AUTO_EXIT",
        "Invalid automatic exit duration.",
      );
      return;
    case "sharing":
      sendApiError(
        res,
        400,
        "INVALID_SHARING_SETTINGS",
        "Invalid sharing detection settings.",
      );
      return;
    case "reminders":
      sendApiError(
        res,
        400,
        "INVALID_REMINDER_SETTINGS",
        "Invalid renewal reminder settings.",
      );
      return;
    default:
      sendApiError(res, 400, "GYM_NAME_REQUIRED", "Gym name is required.");
  }
}

// Gyms visible to the caller: every gym for the owner, the assigned ones for
// admin/staff (used by the panel's gym switcher).
gymsRouter.get(
  "/",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const gyms = await listGymsFor(req.user);
    const body: Gym[] = gyms.map(toGym);
    res.json(body);
  }),
);

gymsRouter.post(
  "/",
  requireRole("owner"),
  authed(async (req, res) => {
    const parsed = createGymSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendInvalidField(res, String(parsed.error.issues[0]?.path[0] ?? ""));
      return;
    }
    const { name, location, capacity, autoExitHours } = parsed.data;
    const doc = {
      name,
      location: location ?? null,
      capacity: capacity ?? null,
      autoExitHours: autoExitHours ?? DEFAULT_AUTO_EXIT_HOURS,
      active: true,
      createdBy: req.user.id,
      createdAt: new Date(),
    };
    const inserted = await gymCollection().insertOne(doc as never);
    const gymId = inserted.insertedId.toHexString();
    await logAudit(req.user, "gym-created", gymId, { name }, gymId);
    const created = await gymCollection().findOne({ _id: inserted.insertedId });
    res.status(201).json(toGym(created!));
  }),
);

gymsRouter.get(
  "/:gymId",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped((req, res) => {
    res.json(toGym(req.gym));
  }),
);

gymsRouter.put(
  "/:gymId",
  requireGymAccess("owner"),
  gymScoped(async (req, res) => {
    const parsed = updateGymSchema.safeParse(req.body ?? {});
    if (
      !parsed.success ||
      (parsed.data.name === undefined && parsed.data.active === undefined)
    ) {
      sendInvalidField(res, "name");
      return;
    }
    const { name, active } = parsed.data;
    const gymId = req.gym._id.toHexString();
    const setDoc: Record<string, unknown> = {};
    if (name !== undefined) setDoc.name = name;
    if (active !== undefined) setDoc.active = active;
    await gymCollection().updateOne({ _id: req.gym._id }, { $set: setDoc });
    // Gyms are deactivated, never deleted: entry history keeps its gymId.
    if (name !== undefined && name !== req.gym.name) {
      await logAudit(
        req.user,
        "gym-renamed",
        gymId,
        { previousName: req.gym.name, name },
        gymId,
      );
    }
    if (active !== undefined && active !== req.gym.active) {
      await logAudit(
        req.user,
        active ? "gym-activated" : "gym-deactivated",
        gymId,
        undefined,
        gymId,
      );
    }
    const updated = await findGym(gymId);
    res.json(toGym(updated!));
  }),
);

// Gym-specific settings (location, capacity, auto-exit, sharing, reminders).
// Returns the full Gym, a superset of GymSettings.
gymsRouter.get(
  "/:gymId/settings",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped((req, res) => {
    res.json(toGym(req.gym));
  }),
);

// Live occupancy of one gym (panel).
gymsRouter.get(
  "/:gymId/occupancy",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const gymId = req.gym._id.toHexString();
    const inside = await getOccupancy(gymId);
    const capacity = req.gym.capacity ?? null;
    const body: OccupancyResponse = {
      gymId,
      gymName: req.gym.name,
      inside,
      capacity,
      ratio: capacity ? Math.round((inside / capacity) * 100) / 100 : null,
    };
    res.json(body);
  }),
);

// Who is counted inside right now (panel), longest-staying first.
gymsRouter.get(
  "/:gymId/inside",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const gymId = req.gym._id.toHexString();
    const inside = await listInside(gymId);
    const users = await userCollection()
      .find(
        {
          _id: {
            $in: inside
              .map((e) => toObjectId(e.userId))
              .filter((id): id is ObjectId => id !== null),
          },
        },
        {
          projection: { name: 1, profilePhotoKey: 1, profilePhotoUpdatedAt: 1 },
        },
      )
      .toArray();
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    const body: GymInsideResponse = {
      gymId,
      members: inside.map((e) => {
        const user = byId.get(e.userId);
        return {
          userId: e.userId,
          name: user?.name ?? "",
          profilePhotoUrl: user
            ? buildProfilePhotoUrl(
                user.profilePhotoKey,
                user.profilePhotoUpdatedAt,
              )
            : null,
          enteredAt: new Date(e.enteredAt).toISOString(),
        };
      }),
    };
    res.json(body);
  }),
);

gymsRouter.put(
  "/:gymId/settings",
  requireGymAccess("owner", "admin"),
  gymScoped(async (req, res) => {
    const parsed = gymSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendInvalidField(res, String(parsed.error.issues[0]?.path[0] ?? ""));
      return;
    }
    const { location, capacity, autoExitHours, sharing, reminders } =
      parsed.data;
    const setDoc: Record<string, unknown> = {
      location: location ?? null,
      capacity: capacity ?? null,
      autoExitHours: autoExitHours ?? DEFAULT_AUTO_EXIT_HOURS,
    };
    if (sharing !== undefined) setDoc.sharing = sharing;
    if (reminders !== undefined) setDoc.reminders = reminders;

    const gymId = req.gym._id.toHexString();
    await gymCollection().updateOne({ _id: req.gym._id }, { $set: setDoc });
    await logAudit(
      req.user,
      "gym-settings-updated",
      gymId,
      {
        // Location (incl. radiusM) is the geofence the static turnstile QR
        // depends on, and capacity drives occupancy figures: record both the
        // previous and the new value.
        previousLocation: req.gym.location ?? null,
        location: setDoc.location,
        previousCapacity: req.gym.capacity ?? null,
        capacity: setDoc.capacity,
        previousAutoExitHours: req.gym.autoExitHours,
        autoExitHours: setDoc.autoExitHours,
        ...(sharing !== undefined ? { sharing } : {}),
        // Enabling or disabling reminders determines whether members receive
        // email, so it must appear in the audit log.
        ...(reminders !== undefined ? { reminders } : {}),
      },
      gymId,
    );
    res.json({ ok: true });
  }),
);

// Overview dashboard KPIs for one gym (staff + admin + owner). Counts use the
// same helpers as the reports module so the overview and the reports page agree.
gymsRouter.get(
  "/:gymId/stats",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const now = new Date();
    const gymId = req.gym._id.toHexString();
    const [activeMembers, renewalsDue, frozen] = await Promise.all([
      countActiveMembers(db, now, gymId),
      countRenewalsDue(db, now, gymId),
      countFrozenMembers(db, now),
    ]);
    const body: AdminStats = {
      activeMembers,
      frozenMembers: frozen.byGym.get(gymId) ?? 0,
      renewalsDue,
    };
    res.json(body);
  }),
);

const entryEventQuerySchema = pageQuerySchema.extend({
  deviceId: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
  // Query parameters always arrive as strings; z.coerce.boolean() also turns
  // "false" into true, so use an explicit enum.
  allowed: z.enum(["true", "false"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Gate entry events (allow/deny) of one gym — cursor pagination + filters
gymsRouter.get(
  "/:gymId/entry-events",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const query = entryEventQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }
    const { cursor, limit, deviceId, userId, allowed, from, to } = query.data;

    const filters: Record<string, unknown>[] = [
      { gymId: req.gym._id.toHexString() },
    ];
    if (deviceId) filters.push({ deviceId });
    if (userId) filters.push({ userId });
    if (allowed) filters.push({ allowed: allowed === "true" });
    const range = dateRangeFilter("at", from, to);
    if (Object.keys(range).length > 0) filters.push(range);

    const page = await findPage(db.collection("entry_events"), {
      timeField: "at",
      filter: { $and: filters },
      cursor,
      limit,
    }).catch(toInvalidCursorResponse(res));
    if (!page) return;

    const body: Page<EntryEvent> = {
      items: page.docs.map((d) => ({
        id: d._id.toString(),
        gymId: d.gymId ?? null,
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        userId: d.userId ?? null,
        memberName: d.memberName ?? null,
        allowed: d.allowed,
        reason: d.reason ?? null,
        at: (d.at as Date).toISOString(),
        // Absent on events recorded before distance was tracked.
        distanceM: typeof d.distanceM === "number" ? d.distanceM : null,
      })),
      nextCursor: page.nextCursor,
    };
    res.json(body);
  }),
);

gymsRouter.use("/:gymId/devices", devicesRouter);
gymsRouter.use("/:gymId/reports", gymReportsRouter);
