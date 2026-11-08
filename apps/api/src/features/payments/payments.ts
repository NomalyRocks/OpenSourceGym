import type { Db, ObjectId } from "mongodb";
import { ObjectId as Oid } from "mongodb";
import type { Payment, PaymentMethod } from "@opengym/shared";
import { db, isDuplicateKeyError, userCollection } from "../../core/db.js";
import {
  subscriptionCollection,
  subscriptionUserLockKey,
  USER_LOCK_LEASE_MS,
  USER_LOCK_WAIT_MS,
  withRedisLock,
} from "../subscriptions/subscriptions.js";
import { balanceFromPaid, fitsBalance } from "./balance.js";
import {
  paymentCollection,
  sumPaidBySubscription,
  type PaymentDocument,
} from "./paymentStore.js";

export interface RecordPaymentInput {
  subscriptionId: ObjectId;
  amountMinor: number;
  method: PaymentMethod;
  /** Hex id of the gym where the money was taken (scope already checked) */
  gymId: string;
  note: string | null;
  requestId: string;
  recordedBy: string;
}

export interface Standing {
  paidMinor: number;
  balanceMinor: number;
}

export type RecordPaymentResult =
  | { status: "not-found" }
  /** The period predates pricing */
  | { status: "unpriced" }
  | { status: "gym-not-on-period" }
  | { status: "request-conflict" }
  | { status: "exceeds-balance"; balanceMinor: number }
  | {
      status: "recorded" | "replayed";
      payment: PaymentDocument;
      standing: Standing;
    };

/** Paid and outstanding amounts of one period, from the payments collection. */
export async function standingOf(
  subscriptionId: ObjectId,
  priceMinor: number,
  database: Db = db,
): Promise<Standing> {
  const paid = await sumPaidBySubscription([subscriptionId], database);
  return balanceFromPaid(
    priceMinor,
    paid.get(subscriptionId.toHexString()) ?? 0,
  );
}

/**
 * Records a payment against one sold period. The whole check-and-insert runs
 * under the member's subscription lock (the one cancel and freeze take), and the
 * balance is recomputed from the payments collection inside it, so a double
 * click or two concurrent requests can never overpay. A repeated `requestId`
 * returns the existing payment.
 */
export async function recordPayment(
  input: RecordPaymentInput,
  database: Db = db,
): Promise<RecordPaymentResult> {
  const subscriptions = subscriptionCollection(database);
  const payments = paymentCollection(database);
  // The lock is per member, so the owner must be known before locking.
  const preview = await subscriptions.findOne(
    { _id: input.subscriptionId },
    { projection: { userId: 1 } },
  );
  if (!preview) return { status: "not-found" };

  return withRedisLock(
    subscriptionUserLockKey(preview.userId.toHexString()),
    USER_LOCK_LEASE_MS,
    USER_LOCK_WAIT_MS,
    async (assertOwned): Promise<RecordPaymentResult> => {
      const subscription = await subscriptions.findOne({
        _id: input.subscriptionId,
      });
      if (
        !subscription ||
        !subscription.userId.equals(preview.userId) ||
        !(await userCollection(database).findOne(
          { _id: subscription.userId },
          { projection: { _id: 1 } },
        ))
      ) {
        return { status: "not-found" };
      }
      const replay = async (): Promise<RecordPaymentResult | null> => {
        const existing = await payments.findOne({ requestId: input.requestId });
        if (!existing) return null;
        // The router checks access to input.gymId before calling us. Requiring
        // the same gym on replay preserves that check for the existing row.
        if (
          !existing.subscriptionId.equals(input.subscriptionId) ||
          existing.gymId !== input.gymId ||
          existing.amountMinor !== input.amountMinor ||
          existing.method !== input.method
        ) {
          return { status: "request-conflict" };
        }
        return {
          status: "replayed",
          payment: existing,
          standing: await standingOf(
            input.subscriptionId,
            subscription.sale?.priceMinor ?? 0,
            database,
          ),
        };
      };
      const replayed = await replay();
      if (replayed) return replayed;

      const sale = subscription.sale;
      if (!sale) return { status: "unpriced" };
      if (
        !(subscription.gymIds ?? []).some(
          (id) => id.toHexString() === input.gymId,
        )
      ) {
        return { status: "gym-not-on-period" };
      }

      const before = await standingOf(
        input.subscriptionId,
        sale.priceMinor,
        database,
      );
      if (!fitsBalance(input.amountMinor, before.balanceMinor)) {
        return { status: "exceeds-balance", balanceMinor: before.balanceMinor };
      }

      const doc = {
        subscriptionId: input.subscriptionId,
        userId: subscription.userId.toHexString(),
        gymId: input.gymId,
        amountMinor: input.amountMinor,
        // A payment is always in its period's sale currency.
        currency: sale.currency,
        method: input.method,
        paidAt: new Date(),
        note: input.note,
        recordedBy: input.recordedBy,
        packageName: sale.packageName,
        requestId: input.requestId,
        void: null,
      };
      await assertOwned();
      try {
        const inserted = await payments.insertOne(doc);
        return {
          status: "recorded",
          payment: { ...doc, _id: inserted.insertedId },
          standing: balanceFromPaid(
            sale.priceMinor,
            before.paidMinor + input.amountMinor,
          ),
        };
      } catch (error) {
        // The unique index catches a requestId that slipped past the read.
        if (isDuplicateKeyError(error)) {
          return (await replay()) ?? { status: "request-conflict" };
        }
        throw error;
      }
    },
  );
}

export type VoidPaymentResult =
  | { status: "not-found" }
  | { status: "already-voided" }
  | { status: "voided"; payment: PaymentDocument; standing: Standing };

export function findPayment(
  id: ObjectId,
  database: Db = db,
): Promise<PaymentDocument | null> {
  return paymentCollection(database).findOne({ _id: id });
}

/**
 * Voids once under the member's subscription lock, shared with account erasure.
 * The optional audit callback runs before releasing the lock so erasure cannot
 * finish before a late audit row restores a personal reason.
 */
export async function voidPayment(
  id: ObjectId,
  by: string,
  reason: string,
  database: Db = db,
  onVoided?: (payment: PaymentDocument) => Promise<void>,
): Promise<VoidPaymentResult> {
  const payments = paymentCollection(database);
  const preview = await payments.findOne({ _id: id });
  if (!preview?.userId) return { status: "not-found" };

  return withRedisLock(
    subscriptionUserLockKey(preview.userId),
    USER_LOCK_LEASE_MS,
    USER_LOCK_WAIT_MS,
    async (assertOwned): Promise<VoidPaymentResult> => {
      const payment = await payments.findOne({ _id: id });
      if (
        !payment?.userId ||
        payment.userId !== preview.userId ||
        !(await userCollection(database).findOne(
          { _id: new Oid(payment.userId) },
          { projection: { _id: 1 } },
        ))
      )
        return { status: "not-found" };
      if (payment.void) return { status: "already-voided" };

      await assertOwned();
      const voided = await payments.findOneAndUpdate(
        { _id: id, userId: payment.userId, void: null },
        { $set: { void: { at: new Date(), by, reason } } },
        { returnDocument: "after" },
      );
      if (!voided) return { status: "not-found" };
      if (onVoided) await onVoided(voided);
      const subscription = await subscriptionCollection(database).findOne({
        _id: voided.subscriptionId,
      });
      return {
        status: "voided",
        payment: voided,
        standing: await standingOf(
          voided.subscriptionId,
          subscription?.sale?.priceMinor ?? 0,
          database,
        ),
      };
    },
  );
}

/** Display names of staff accounts (hex id -> name); deleted accounts are absent. */
export async function loadUserNames(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const oids = [...new Set(ids)]
    .filter((id) => /^[0-9a-f]{24}$/i.test(id))
    .map((id) => new Oid(id));
  const names = new Map<string, string>();
  if (oids.length === 0) return names;
  const users = await userCollection()
    .find(
      { _id: { $in: oids } },
      { projection: { firstName: 1, lastName: 1, name: 1 } },
    )
    .toArray();
  for (const user of users) {
    const full = [user.firstName, user.lastName].filter(Boolean).join(" ");
    names.set(user._id.toHexString(), full || user.name);
  }
  return names;
}

export function toPayment(
  doc: PaymentDocument,
  names: ReadonlyMap<string, string>,
): Payment {
  return {
    id: doc._id.toHexString(),
    subscriptionId: doc.subscriptionId.toHexString(),
    userId: doc.userId,
    gymId: doc.gymId,
    amountMinor: doc.amountMinor,
    currency: doc.currency,
    method: doc.method,
    paidAt: doc.paidAt.toISOString(),
    note: doc.note,
    recordedBy: doc.recordedBy,
    recordedByName: names.get(doc.recordedBy) ?? null,
    packageName: doc.packageName,
    void: doc.void
      ? {
          at: doc.void.at.toISOString(),
          by: doc.void.by,
          reason: doc.void.reason,
        }
      : null,
  };
}

/** Maps payment rows to the API shape, resolving recorder names in one query. */
export async function toPayments(
  docs: readonly PaymentDocument[],
): Promise<Payment[]> {
  const names = await loadUserNames(docs.map((doc) => doc.recordedBy));
  return docs.map((doc) => toPayment(doc, names));
}

/**
 * Account deletion: detaches a member's payments from the person. Amount,
 * currency, method, gym, date, recorder and package snapshot stay so past cash
 * reports keep adding up; the member link and free text go. One pipeline update
 * per row, so a row is never half anonymised.
 */
export async function anonymisePaymentsForUser(
  userId: string,
  database: Db = db,
): Promise<number> {
  const result = await paymentCollection(database).updateMany({ userId }, [
    {
      $set: {
        userId: null,
        note: null,
        void: {
          $cond: [
            { $eq: [{ $ifNull: ["$void", null] }, null] },
            null,
            { $mergeObjects: ["$void", { reason: null }] },
          ],
        },
      },
    },
  ]);
  return result.modifiedCount;
}
