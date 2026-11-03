import { Router } from "express";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { MyBodyMetrics, MyWeightHistoryResponse } from "@opengym/shared";
import { userCollection } from "../../core/db.js";
import {
  AGE_RANGE,
  buildBodyMetricsUpdate,
  HEIGHT_CM_RANGE,
  WEIGHT_KG_RANGE,
} from "./bodyMetrics.js";
import {
  listWeightHistory,
  recordWeightHistoryIfChanged,
} from "./weightHistory.js";
import { sendApiError } from "../../core/apiError.js";
import { acquireLock, redis, releaseLock } from "../../core/redis.js";
import { authed, requireRole } from "../../core/middleware.js";
import { logAudit } from "../../core/audit.js";

export const bodyRouter: Router = Router();

// Weight layer for the mobile calendar: history appended whenever weightKg changes.
bodyRouter.get(
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

bodyRouter.patch(
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
