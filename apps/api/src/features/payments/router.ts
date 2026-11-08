import { Router, type Response } from "express";
import { z } from "zod";
import type { Payment, PaymentResult, Subscription } from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import { logAudit, logAuditPerGym } from "../../core/audit.js";
import { db, toObjectId } from "../../core/db.js";
import { authed, requireRole } from "../../core/middleware.js";
import { canAccessGym } from "../gyms/gyms.js";
import {
  findSubscription,
  subscriptionCollection,
  SubscriptionLockTimeoutError,
} from "../subscriptions/subscriptions.js";
import {
  canSeeSale,
  toSubscriptionDtos,
} from "../subscriptions/subscriptionDto.js";
import { amountMinorSchema } from "./money.js";
import {
  findPayment,
  recordPayment,
  toPayment,
  toPayments,
  loadUserNames,
  voidPayment,
} from "./payments.js";
import { paymentCollection } from "./paymentStore.js";

export const paymentsRouter: Router = Router();

const MAX_PAYMENTS_PER_PERIOD = 200;

export const recordPaymentSchema = z
  .object({
    amountMinor: amountMinorSchema,
    method: z.enum(["cash", "card", "transfer", "other"]),
    gymId: z.string().min(1).max(64),
    note: z.string().trim().max(200).optional(),
    requestId: z.string().uuid(),
  })
  .strict();

export const voidPaymentSchema = z
  .object({ reason: z.string().trim().min(3).max(200) })
  .strict();

export const updateSaleSchema = z
  .object({
    nextPaymentDue: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date")
      .transform((value) => new Date(value))
      .nullable(),
  })
  .strict();

function sendBusy(res: Response): void {
  sendApiError(
    res,
    503,
    "SUBSCRIPTION_BUSY",
    "A subscription operation is in progress. Please try again.",
  );
}

function sendSubscriptionNotFound(res: Response): void {
  sendApiError(res, 404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found.");
}

// Payments of one period, voided ones included and marked. Visible to a
// non-owner only when the period lists a gym in their scope.
paymentsRouter.get(
  "/subscriptions/:id/payments",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const id = toObjectId(String(req.params.id ?? ""));
    const subscription = id ? await findSubscription(id) : null;
    if (!id || !subscription) {
      sendSubscriptionNotFound(res);
      return;
    }
    if (!canSeeSale(req.user, subscription.gymIds ?? [])) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "This subscription is outside your gym scope.",
      );
      return;
    }
    const docs = await paymentCollection()
      .find({ subscriptionId: id })
      .sort({ paidAt: -1, _id: -1 })
      .limit(MAX_PAYMENTS_PER_PERIOD)
      .toArray();
    const body: Payment[] = await toPayments(docs);
    res.json(body);
  }),
);

paymentsRouter.post(
  "/subscriptions/:id/payments",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const id = toObjectId(String(req.params.id ?? ""));
    const parsed = recordPaymentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_PAYMENT", "Enter a valid payment.");
      return;
    }
    if (!id) {
      sendSubscriptionNotFound(res);
      return;
    }
    const gymId = parsed.data.gymId.toLowerCase();
    if (!canAccessGym(req.user, gymId)) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "The selected gym is outside your scope.",
      );
      return;
    }
    try {
      const result = await recordPayment({
        subscriptionId: id,
        amountMinor: parsed.data.amountMinor,
        method: parsed.data.method,
        gymId,
        note: parsed.data.note || null,
        requestId: parsed.data.requestId,
        recordedBy: req.user.id,
      });
      switch (result.status) {
        case "not-found":
          sendSubscriptionNotFound(res);
          return;
        case "unpriced":
          sendApiError(
            res,
            409,
            "SUBSCRIPTION_UNPRICED",
            "This subscription period has no price and cannot take payments.",
          );
          return;
        case "gym-not-on-period":
          sendApiError(
            res,
            409,
            "PAYMENT_GYM_NOT_ON_PERIOD",
            "The selected gym is not on this subscription period.",
          );
          return;
        case "request-conflict":
          sendApiError(
            res,
            409,
            "REQUEST_ID_CONFLICT",
            "The request id was already used for a different record.",
          );
          return;
        case "exceeds-balance":
          sendApiError(
            res,
            409,
            "PAYMENT_EXCEEDS_BALANCE",
            "The payment is larger than the outstanding balance.",
          );
          return;
      }
      if (result.status === "recorded") {
        await logAudit(
          req.user,
          "payment-recorded",
          result.payment.userId ?? undefined,
          {
            paymentId: result.payment._id.toHexString(),
            subscriptionId: id.toHexString(),
            amountMinor: result.payment.amountMinor,
            currency: result.payment.currency,
            method: result.payment.method,
            packageName: result.payment.packageName,
            balanceMinor: result.standing.balanceMinor,
          },
          result.payment.gymId,
        );
      }
      const names = await loadUserNames([result.payment.recordedBy]);
      const body: PaymentResult = {
        payment: toPayment(result.payment, names),
        paidMinor: result.standing.paidMinor,
        balanceMinor: result.standing.balanceMinor,
      };
      res.json(body);
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendBusy(res);
        return;
      }
      throw error;
    }
  }),
);

paymentsRouter.post(
  "/payments/:id/void",
  requireRole("owner", "admin"),
  authed(async (req, res) => {
    const id = toObjectId(String(req.params.id ?? ""));
    const parsed = voidPaymentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "INVALID_PAYMENT",
        "Enter a reason of 3 to 200 characters.",
      );
      return;
    }
    const payment = id ? await findPayment(id) : null;
    if (!id || !payment) {
      sendApiError(res, 404, "PAYMENT_NOT_FOUND", "Payment not found.");
      return;
    }
    if (!canAccessGym(req.user, payment.gymId)) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "This payment belongs to a gym outside your scope.",
      );
      return;
    }
    let result: Awaited<ReturnType<typeof voidPayment>>;
    try {
      result = await voidPayment(
        id,
        req.user.id,
        parsed.data.reason,
        db,
        async (voided) => {
          await logAudit(
            req.user,
            "payment-voided",
            voided.userId ?? undefined,
            {
              paymentId: id.toHexString(),
              subscriptionId: voided.subscriptionId.toHexString(),
              amountMinor: voided.amountMinor,
              currency: voided.currency,
              reason: parsed.data.reason,
            },
            voided.gymId,
          );
        },
      );
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendBusy(res);
        return;
      }
      throw error;
    }
    if (result.status === "not-found") {
      sendApiError(res, 404, "PAYMENT_NOT_FOUND", "Payment not found.");
      return;
    }
    if (result.status === "already-voided") {
      sendApiError(
        res,
        409,
        "PAYMENT_ALREADY_VOIDED",
        "This payment has already been voided.",
      );
      return;
    }
    const names = await loadUserNames([
      result.payment.recordedBy,
      ...(result.payment.void ? [result.payment.void.by] : []),
    ]);
    const body: PaymentResult = {
      payment: toPayment(result.payment, names),
      paidMinor: result.standing.paidMinor,
      balanceMinor: result.standing.balanceMinor,
    };
    res.json(body);
  }),
);

// Moves the promise date for the remainder; the price and the payments are
// untouched. A non-owner needs a gym of the period in their scope.
paymentsRouter.patch(
  "/subscriptions/:id/sale",
  requireRole("owner", "admin"),
  authed(async (req, res) => {
    const id = toObjectId(String(req.params.id ?? ""));
    const parsed = updateSaleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "INVALID_SUBSCRIPTION",
        "Enter a valid payment due date.",
      );
      return;
    }
    const subscription = id ? await findSubscription(id) : null;
    if (!id || !subscription) {
      sendSubscriptionNotFound(res);
      return;
    }
    if (!canSeeSale(req.user, subscription.gymIds ?? [])) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "This subscription is outside your gym scope.",
      );
      return;
    }
    if (!subscription.sale) {
      sendApiError(
        res,
        409,
        "SUBSCRIPTION_UNPRICED",
        "This subscription period has no price.",
      );
      return;
    }
    const updated = await subscriptionCollection().findOneAndUpdate(
      { _id: id, sale: { $exists: true } },
      { $set: { "sale.nextPaymentDue": parsed.data.nextPaymentDue } },
      { returnDocument: "after" },
    );
    if (!updated) {
      sendSubscriptionNotFound(res);
      return;
    }
    const gymHexIds = (updated.gymIds ?? []).map((gym) => gym.toHexString());
    await logAuditPerGym(
      req.user,
      "subscription-sale-updated",
      updated.userId.toHexString(),
      {
        subscriptionId: id.toHexString(),
        before: subscription.sale.nextPaymentDue?.toISOString() ?? null,
        after: parsed.data.nextPaymentDue?.toISOString() ?? null,
      },
      gymHexIds,
    );
    const [body]: Subscription[] = await toSubscriptionDtos(
      [updated],
      req.user,
    );
    res.json(body);
  }),
);
