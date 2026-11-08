import type { Db, ObjectId } from "mongodb";
import type { CurrencyCode, PaymentMethod } from "@opengym/shared";
import { db } from "../../core/db.js";

/**
 * Payment rows are append-only: never deleted or edited, only voided. Kept free
 * of subscription imports so the subscription module can read it (cancel guard)
 * without an import cycle.
 */
export interface PaymentFields {
  subscriptionId: ObjectId;
  /** Hex user id; null after account deletion */
  userId: string | null;
  /** Hex gym id where the money was taken */
  gymId: string;
  amountMinor: number;
  currency: CurrencyCode;
  method: PaymentMethod;
  paidAt: Date;
  note: string | null;
  /** Staff user id */
  recordedBy: string;
  /** Package name snapshot; survives deletion of the period */
  packageName: string;
  /** Client UUID, unique */
  requestId: string;
  void: { at: Date; by: string; reason: string | null } | null;
}

export type PaymentDocument = PaymentFields & { _id: ObjectId };

export function paymentCollection(database: Db = db) {
  return database.collection<PaymentFields>("payments");
}

/** Non-voided payments of one period exist (cancel is refused while they do). */
export async function hasLivePayments(
  subscriptionId: ObjectId,
  database: Db = db,
): Promise<boolean> {
  const found = await paymentCollection(database).findOne(
    { subscriptionId, void: null },
    { projection: { _id: 1 } },
  );
  return found !== null;
}

/** Sum of non-voided payments per period (hex id -> minor units). */
export async function sumPaidBySubscription(
  subscriptionIds: readonly ObjectId[],
  database: Db = db,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (subscriptionIds.length === 0) return result;
  const rows = await paymentCollection(database)
    .aggregate<{ _id: ObjectId; paid: number }>([
      { $match: { subscriptionId: { $in: [...subscriptionIds] }, void: null } },
      { $group: { _id: "$subscriptionId", paid: { $sum: "$amountMinor" } } },
    ])
    .toArray();
  for (const row of rows) result.set(row._id.toHexString(), row.paid);
  return result;
}
