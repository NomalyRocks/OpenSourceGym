import { Router } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  MyBusyHours,
  MyEntriesResponse,
  MyPresence,
  MyOccupancyResponse,
  MySubscription,
  OccupancyResponse,
} from "@opengym/shared";
import { db } from "../../core/db.js";
import { env } from "../../core/env.js";
import {
  DAY_LABEL_PATTERN,
  dayLabelSpan,
  entryQueryWindow,
  MAX_ENTRY_RANGE_DAYS,
  toEntryDays,
} from "./entryDays.js";
import { sendApiError } from "../../core/apiError.js";
import { redis } from "../../core/redis.js";
import { authed, requireRole } from "../../core/middleware.js";
import { getFreezeAllowance } from "../freeze/freeze.js";
import {
  getSubscriptionSummary,
  listUsableSubscriptionGymIds,
} from "../subscriptions/subscriptions.js";
import {
  findGym,
  findGymsByIds,
  listActiveGyms,
  type GymDoc,
} from "../gyms/gyms.js";
import { getOccupancy, loadMemberPresence } from "../gyms/occupancy.js";
import {
  buildBusyHours,
  busyHoursQueryRange,
  zonedDayHour,
} from "./busyHours.js";

export const activityRouter: Router = Router();

// US-4: member's own subscription status (mobile home screen)
activityRouter.get(
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
 * Match fragment for allowed entry-direction scans (no exits, no refusals).
 * Direction is persisted on current records; legacy records without it are
 * judged by the current out-device ids.
 */
async function inboundEntryMatch(): Promise<Record<string, unknown>> {
  const outDevices = await db
    .collection("devices")
    .find({ direction: "out" }, { projection: { _id: 1 } })
    .toArray();
  const outDeviceIds = outDevices.map((device) => device._id.toString());
  return {
    allowed: true,
    $or: [
      { direction: "in" },
      {
        direction: { $exists: false },
        ...(outDeviceIds.length > 0
          ? { deviceId: { $nin: outDeviceIds } }
          : {}),
      },
    ],
  };
}

/**
 * Attendance layer for the mobile calendar: the member's OWN entry days.
 *
 * Only allowed scans in the entry direction count; otherwise an exit-gate scan
 * would look like a second entry on the same day. Direction is now persisted as
 * `entry_events.direction` at scan time, so history remains classified even if
 * the device is later deleted. Legacy records written BEFORE this field lack
 * `direction`; as a one-time compatibility fallback, use current device ids.
 */
activityRouter.get(
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

    const inboundMatch = await inboundEntryMatch();

    const rows = await db
      .collection("entry_events")
      .aggregate<{ _id: string; entries: number }>([
        {
          $match: {
            userId: req.user.id,
            at: { $gte: start, $lte: end },
            ...inboundMatch,
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

// Own "am I inside" state plus the latest allowed entry, for the mobile home.
activityRouter.get(
  "/presence",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    // The caller is looking at themselves, so no gym scope applies.
    const presence = await loadMemberPresence([req.user.id], {
      role: "owner",
      gymIds: [],
    });
    const last = await db
      .collection("entry_events")
      .find({ userId: req.user.id, ...(await inboundEntryMatch()) })
      .sort({ at: -1, _id: -1 })
      .limit(1)
      .next();
    let lastEntry: MyPresence["lastEntry"] = null;
    if (last && typeof last.gymId === "string") {
      const gym = await findGym(last.gymId);
      lastEntry = {
        gymId: last.gymId,
        gymName: gym?.name ?? "",
        at: new Date(last.at).toISOString(),
      };
    }
    const body: MyPresence = {
      inside: presence.get(req.user.id) ?? null,
      lastEntry,
    };
    res.json(body);
  }),
);

// Typical hourly traffic at a gym the member currently has access to — the
// gyms GET /subscription lists, so a frozen member keeps theirs.
activityRouter.get(
  "/gyms/:gymId/busy-hours",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const gymId = String(req.params.gymId);
    const allowed = (await listUsableSubscriptionGymIds(req.user.id)).some(
      (id) => id.toHexString() === gymId,
    );
    const gym = allowed ? await findGym(gymId) : null;
    // Unknown, malformed and out-of-subscription ids answer identically.
    if (!gym) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "This gym is outside your scope.",
      );
      return;
    }
    const timeZone = env.reportsTimeZone;
    const now = new Date();
    const today = zonedDayHour(now, timeZone).day;
    const cacheKey = `og:busyhours:v2:${gymId}:${today}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.json(JSON.parse(cached) as MyBusyHours);
      return;
    }
    const { start, end } = busyHoursQueryRange(today);
    const events = await db
      .collection("entry_events")
      .find(
        {
          gymId,
          at: { $gte: start, $lte: end },
          ...(await inboundEntryMatch()),
        },
        { projection: { at: 1 } },
      )
      .toArray();
    const body = buildBusyHours({
      gymId,
      timeZone,
      now,
      gymCreatedAt: gym.createdAt,
      entryTimes: events.map((event) => new Date(event.at)),
    });
    await redis.set(cacheKey, JSON.stringify(body), {
      expiration: { type: "EX", value: 3600 },
    });
    res.json(body);
  }),
);

// Phase 5 — US-4: live occupancy of every active gym the caller may enter:
// the gyms on a member's active subscription, an admin/staff account's own
// gyms, or (owner) every active gym.
activityRouter.get(
  "/occupancy",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    let gyms: GymDoc[];
    if (req.user.role === "owner") {
      gyms = await listActiveGyms();
    } else if (req.user.role === "member") {
      const ids = await listUsableSubscriptionGymIds(req.user.id);
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
