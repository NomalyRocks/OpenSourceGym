import type { ObjectId } from "mongodb";
import { sumPaidBySubscription } from "../payments/paymentStore.js";
import { canSeeSale, type SaleViewer } from "./subscriptionDto.js";
import {
  listUserSubscriptions,
  subscriptionCollection,
  type SubscriptionDocument,
} from "./subscriptions.js";

/** Keep recent history and every older period the caller can still collect on. */
export async function listSubscriptionsWithDebt(
  userId: ObjectId,
  viewer: SaleViewer,
): Promise<SubscriptionDocument[]> {
  const recent = await listUserSubscriptions(userId);
  const older = await subscriptionCollection()
    .find({
      userId,
      _id: { $nin: recent.map((doc) => doc._id) },
      "sale.priceMinor": { $gt: 0 },
    })
    .toArray();
  const visible = older.filter((doc) => canSeeSale(viewer, doc.gymIds ?? []));
  const paid = await sumPaidBySubscription(visible.map((doc) => doc._id));
  const outstanding = visible.filter(
    (doc) =>
      doc.sale &&
      doc.sale.priceMinor - (paid.get(doc._id.toHexString()) ?? 0) > 0,
  );
  return [...recent, ...outstanding].sort(
    (a, b) =>
      b.endsAt.getTime() - a.endsAt.getTime() ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      b._id.toHexString().localeCompare(a._id.toHexString()),
  );
}
