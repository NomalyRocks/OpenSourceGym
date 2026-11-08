import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  CancelSubscriptionResponse,
  PackageDuration,
} from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import { toObjectId, userCollection } from "../../core/db.js";
import { logAuditPerGym } from "../../core/audit.js";
import { authed, requireRole } from "../../core/middleware.js";
import { canAccessGym, validateSubscriptionGymIds } from "../gyms/gyms.js";
import { findPackage } from "../packages/packages.js";
import { getChainCurrency } from "../payments/money.js";
import {
  cancelScheduledSubscription,
  createSequentialSubscription,
  findSubscription,
  listUserSubscriptions,
  RequestIdConflictError,
  setSubscriptionGymIds,
  subscriptionCollection,
  SubscriptionLockTimeoutError,
  type SaleSnapshot,
} from "./subscriptions.js";
import {
  catalogPriceChanged,
  createSubscriptionSchema,
  mayChoosePrice,
} from "./sale.js";
import { toSubscriptionDtos } from "./subscriptionDto.js";

export const subscriptionsRouter: Router = Router();

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

// US-6: sell a period (catalog package or custom grant). Members are chain-wide,
// so the route is not gym-scoped; instead the caller must have access to EVERY
// gym listed.
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
    const body = parsed.data;
    // Staff sells at the catalog price: no override, no custom grant.
    if (!mayChoosePrice(req.user.role, body)) {
      sendApiError(
        res,
        403,
        "PRICE_OVERRIDE_FORBIDDEN",
        "Only an owner or admin can override the price or grant a custom period.",
      );
      return;
    }
    const gymCheck = await validateSubscriptionGymIds(body.gymIds, req.user);
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
      // A repeat of an earlier submit answers with that period even if the
      // package was deactivated or repriced in between.
      const earlier = await subscriptionCollection().findOne({
        requestId: body.requestId,
        userId: targetId,
      });
      if (earlier) {
        res.json({
          ok: true,
          id: earlier._id.toHexString(),
          startsAt: earlier.startsAt.toISOString(),
          endsAt: earlier.endsAt.toISOString(),
        });
        return;
      }

      const currency = await getChainCurrency();
      const nextPaymentDue = body.nextPaymentDue ?? null;
      let duration: PackageDuration;
      let sale: SaleSnapshot;
      let listPriceMinor: number | null = null;
      if ("custom" in body) {
        duration = { unit: "day", value: body.custom.days };
        sale = {
          packageId: null,
          packageName: body.custom.label ?? `${body.custom.days} days`,
          duration,
          listPriceMinor: null,
          priceMinor: body.custom.priceMinor,
          currency,
          nextPaymentDue,
        };
      } else {
        const pkg = await findPackage(body.packageId);
        if (!pkg) {
          sendApiError(res, 404, "PACKAGE_NOT_FOUND", "Package not found.");
          return;
        }
        if (!pkg.active) {
          sendApiError(
            res,
            409,
            "PACKAGE_INACTIVE",
            "This package is no longer on sale.",
          );
          return;
        }
        if (catalogPriceChanged(body, pkg.priceMinor)) {
          sendApiError(
            res,
            409,
            "PACKAGE_PRICE_CHANGED",
            "The catalog price has changed. Review the current price before selling.",
          );
          return;
        }
        const price = body.priceMinor ?? pkg.priceMinor;
        if (price === null) {
          sendApiError(
            res,
            409,
            "PACKAGE_PRICE_UNSET",
            "This package has no price yet. Set one in the catalog first.",
          );
          return;
        }
        duration = pkg.duration;
        listPriceMinor = pkg.priceMinor;
        sale = {
          packageId: pkg._id,
          packageName: pkg.name,
          duration,
          listPriceMinor,
          priceMinor: price,
          currency,
          nextPaymentDue,
        };
      }

      const created = await createSequentialSubscription({
        userId: targetId,
        duration,
        gymIds: gymCheck.ids,
        note: body.note || null,
        createdBy: req.user.id,
        sale,
        requestId: body.requestId,
      });
      if (!created.replayed) {
        const gymHexIds = gymCheck.ids.map((id) => id.toHexString());
        await logAuditPerGym(
          req.user,
          "subscription-created",
          body.userId,
          {
            package: sale.packageName,
            packageId: sale.packageId?.toHexString() ?? null,
            duration,
            listPriceMinor,
            priceMinor: sale.priceMinor,
            currency: sale.currency,
            custom: "custom" in body,
            startsAt: created.startsAt.toISOString(),
            endsAt: created.endsAt.toISOString(),
            subscriptionId: created.id.toHexString(),
            gymIds: gymHexIds,
          },
          gymHexIds,
        );
      }
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
      if (error instanceof RequestIdConflictError) {
        sendApiError(
          res,
          409,
          "REQUEST_ID_CONFLICT",
          "The request id was already used for a different record.",
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
    const [body] = await toSubscriptionDtos([updated], req.user);
    res.json(body);
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
        case "has-payments":
          sendApiError(
            res,
            409,
            "SUBSCRIPTION_HAS_PAYMENTS",
            "This subscription period has payments. Void them first, then cancel.",
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
        shifted: await toSubscriptionDtos(shifted, req.user),
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
  authed(async (req, res) => {
    const targetId = toObjectId(String(req.params.id ?? ""));
    if (!targetId) {
      sendApiError(res, 400, "INVALID_USER", "Invalid user.");
      return;
    }
    const docs = await listUserSubscriptions(targetId);
    res.json(await toSubscriptionDtos(docs, req.user));
  }),
);
