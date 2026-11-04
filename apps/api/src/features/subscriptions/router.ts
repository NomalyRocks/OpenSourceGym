import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { CancelSubscriptionResponse } from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import { toObjectId, userCollection } from "../../core/db.js";
import { logAuditPerGym } from "../../core/audit.js";
import { authed, requireRole } from "../../core/middleware.js";
import { canAccessGym, validateSubscriptionGymIds } from "../gyms/gyms.js";
import {
  cancelScheduledSubscription,
  createSequentialSubscription,
  findSubscription,
  listUserSubscriptions,
  setSubscriptionGymIds,
  SubscriptionLockTimeoutError,
} from "./subscriptions.js";

export const subscriptionsRouter: Router = Router();

const createSubscriptionSchema = z
  .object({
    userId: z.string(),
    months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
    gymIds: z.array(z.string().min(1).max(64)).max(200),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

type GymCheckFailure = Extract<
  Awaited<ReturnType<typeof validateSubscriptionGymIds>>,
  { ok: false }
>["reason"];

function sendGymCheckError(res: Response, reason: GymCheckFailure): void {
  switch (reason) {
    case "out-of-scope":
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "A selected gym is outside your scope.",
      );
      break;
    case "not-found":
      sendApiError(res, 404, "GYM_NOT_FOUND", "A selected gym does not exist.");
      break;
    case "inactive":
      sendApiError(res, 400, "GYM_INACTIVE", "A selected gym is inactive.");
      break;
    default:
      sendApiError(res, 400, "INVALID_GYMS", "Select at least one active gym.");
  }
}

// US-6: create or extend a subscription. Members are chain-wide, so the route
// is not gym-scoped; instead the caller must have access to EVERY gym listed.
subscriptionsRouter.post(
  "/subscriptions",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const parsed = createSubscriptionSchema.safeParse(req.body ?? {});
    const targetId = parsed.success ? toObjectId(parsed.data.userId) : null;
    if (!parsed.success || !targetId) {
      sendApiError(
        res,
        400,
        "INVALID_SUBSCRIPTION",
        "Enter a valid user and subscription plan.",
      );
      return;
    }
    const gymCheck = await validateSubscriptionGymIds(
      parsed.data.gymIds,
      req.user,
    );
    if (!gymCheck.ok) {
      sendGymCheckError(res, gymCheck.reason);
      return;
    }
    const target = await userCollection().findOne({ _id: targetId });
    if (!target) {
      sendApiError(res, 404, "USER_NOT_FOUND", "User not found.");
      return;
    }
    try {
      const created = await createSequentialSubscription({
        userId: targetId,
        months: parsed.data.months,
        gymIds: gymCheck.ids,
        note: parsed.data.note || null,
        createdBy: req.user.id,
      });
      const gymHexIds = gymCheck.ids.map((id) => id.toHexString());
      await logAuditPerGym(
        req.user,
        "subscription-created",
        parsed.data.userId,
        {
          months: parsed.data.months,
          startsAt: created.startsAt.toISOString(),
          endsAt: created.endsAt.toISOString(),
          subscriptionId: created.id.toHexString(),
          gymIds: gymHexIds,
        },
        gymHexIds,
      );
      res.json({
        ok: true,
        id: created.id.toHexString(),
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendApiError(
          res,
          503,
          "SUBSCRIPTION_BUSY",
          "A subscription operation is in progress. Please try again.",
        );
        return;
      }
      throw error;
    }
  }),
);

const setSubscriptionGymsSchema = z
  .object({ gymIds: z.array(z.string().min(1).max(64)).max(200) })
  .strict();

// Changes which gyms a current or future period covers, without touching its
// dates — adding a gym must not sell a new period. Non-owners may only add or
// remove gyms in their own scope; gyms outside it stay on the period.
subscriptionsRouter.put(
  "/subscriptions/:id/gyms",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const subscriptionId = toObjectId(String(req.params.id ?? ""));
    const parsed = setSubscriptionGymsSchema.safeParse(req.body ?? {});
    if (!subscriptionId || !parsed.success) {
      sendApiError(res, 400, "INVALID_GYMS", "Select at least one active gym.");
      return;
    }
    const subscription = await findSubscription(subscriptionId);
    if (!subscription) {
      sendApiError(
        res,
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription not found.",
      );
      return;
    }
    if (subscription.endsAt.getTime() <= Date.now()) {
      sendApiError(
        res,
        409,
        "SUBSCRIPTION_ENDED",
        "This subscription period has already ended.",
      );
      return;
    }
    const before = (subscription.gymIds ?? []).map((id) => id.toHexString());
    const requested = [
      ...new Set(parsed.data.gymIds.map((id) => id.toLowerCase())),
    ];
    if (requested.length === 0) {
      sendApiError(res, 400, "INVALID_GYMS", "Select at least one active gym.");
      return;
    }
    const added = requested.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !requested.includes(id));
    if (removed.some((id) => !canAccessGym(req.user, id))) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "A selected gym is outside your scope.",
      );
      return;
    }
    // Only newly added gyms must be active and in scope; gyms already on the
    // period are kept even if one has since been deactivated.
    if (added.length > 0) {
      const gymCheck = await validateSubscriptionGymIds(added, req.user);
      if (!gymCheck.ok) {
        sendGymCheckError(res, gymCheck.reason);
        return;
      }
    }
    const kept = (subscription.gymIds ?? []).filter((id) =>
      requested.includes(id.toHexString()),
    );
    const next = [...kept, ...added.map((id) => new ObjectId(id))];
    const updated = await setSubscriptionGymIds(subscriptionId, next);
    if (!updated) {
      sendApiError(
        res,
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription not found.",
      );
      return;
    }
    const after = next.map((id) => id.toHexString());
    // One row per gym whose membership changed, so each gym's admins see it.
    await logAuditPerGym(
      req.user,
      "subscription-gyms-updated",
      updated.userId.toHexString(),
      { subscriptionId: subscriptionId.toHexString(), before, after },
      [...added, ...removed],
    );
    res.json({
      id: updated._id.toHexString(),
      userId: updated.userId.toHexString(),
      startsAt: updated.startsAt.toISOString(),
      endsAt: updated.endsAt.toISOString(),
      note: updated.note ?? undefined,
      gymIds: after,
      createdBy: updated.createdBy,
      createdAt: updated.createdAt.toISOString(),
    });
  }),
);

// Undo for a period granted by mistake. Only periods that have not started can
// be cancelled; later periods move earlier so the timeline keeps no gap.
subscriptionsRouter.delete(
  "/subscriptions/:id",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const subscriptionId = toObjectId(String(req.params.id ?? ""));
    if (!subscriptionId) {
      sendApiError(
        res,
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription not found.",
      );
      return;
    }
    try {
      const result = await cancelScheduledSubscription(
        subscriptionId,
        (gymIds) => gymIds.every((gymId) => canAccessGym(req.user, gymId)),
      );
      switch (result.status) {
        case "not-found":
          sendApiError(
            res,
            404,
            "SUBSCRIPTION_NOT_FOUND",
            "Subscription not found.",
          );
          return;
        case "started":
          sendApiError(
            res,
            409,
            "SUBSCRIPTION_STARTED",
            "This subscription period has already started and cannot be cancelled.",
          );
          return;
        case "out-of-scope":
          sendApiError(
            res,
            403,
            "GYM_OUT_OF_SCOPE",
            "A gym on this subscription is outside your scope.",
          );
          return;
      }
      const { cancelled, shifted } = result;
      const gymHexIds = (cancelled.gymIds ?? []).map((id) => id.toHexString());
      await logAuditPerGym(
        req.user,
        "subscription-cancelled",
        cancelled.userId.toHexString(),
        {
          subscriptionId: cancelled._id.toHexString(),
          startsAt: cancelled.startsAt.toISOString(),
          endsAt: cancelled.endsAt.toISOString(),
          gymIds: gymHexIds,
          shifted: shifted.map((doc) => ({
            id: doc._id.toHexString(),
            startsAt: doc.startsAt.toISOString(),
            endsAt: doc.endsAt.toISOString(),
          })),
        },
        gymHexIds,
      );
      const body: CancelSubscriptionResponse = {
        ok: true,
        shifted: shifted.map((doc) => ({
          id: doc._id.toHexString(),
          userId: doc.userId.toHexString(),
          startsAt: doc.startsAt.toISOString(),
          endsAt: doc.endsAt.toISOString(),
          note: doc.note ?? undefined,
          gymIds: (doc.gymIds ?? []).map((id) => id.toHexString()),
          createdBy: doc.createdBy,
          createdAt: doc.createdAt.toISOString(),
        })),
      };
      res.json(body);
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendApiError(
          res,
          503,
          "SUBSCRIPTION_BUSY",
          "A subscription operation is in progress. Please try again.",
        );
        return;
      }
      throw error;
    }
  }),
);

subscriptionsRouter.get(
  "/users/:id/subscriptions",
  requireRole("owner", "admin", "staff"),
  async (req, res) => {
    const targetId = toObjectId(String(req.params.id ?? ""));
    if (!targetId) {
      sendApiError(res, 400, "INVALID_USER", "Invalid user.");
      return;
    }
    const docs = await listUserSubscriptions(targetId);
    res.json(
      docs.map((d) => ({
        id: d._id.toString(),
        userId: d.userId.toString(),
        startsAt: d.startsAt.toISOString(),
        endsAt: d.endsAt.toISOString(),
        note: d.note ?? undefined,
        gymIds: (d.gymIds ?? []).map((id) => id.toHexString()),
        createdBy: d.createdBy,
        createdAt: d.createdAt.toISOString(),
      })),
    );
  },
);
