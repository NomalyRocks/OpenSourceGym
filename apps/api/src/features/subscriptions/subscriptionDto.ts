import type { ObjectId } from "mongodb";
import type { Role, Subscription } from "@opengym/shared";
import { canAccessGym } from "../gyms/gyms.js";
import { sumPaidBySubscription } from "../payments/paymentStore.js";
import { balanceFromPaid } from "../payments/balance.js";
import type { SubscriptionDocument } from "./subscriptions.js";

export interface SaleViewer {
  role: Role;
  gymIds: readonly string[];
}

/**
 * Sale, balance and payments are shown to a non-owner only for periods with a
 * gym in their scope; owners see every period.
 */
export function canSeeSale(
  viewer: SaleViewer,
  gymIds: readonly ObjectId[],
): boolean {
  if (viewer.role === "owner") return true;
  return gymIds.some((id) => canAccessGym(viewer, id.toHexString()));
}

/** Maps periods to the API shape with their sale and balance (one paid-sum query). */
export async function toSubscriptionDtos(
  docs: readonly SubscriptionDocument[],
  viewer: SaleViewer,
): Promise<Subscription[]> {
  const visible = docs.filter(
    (doc) => doc.sale && canSeeSale(viewer, doc.gymIds ?? []),
  );
  const paid = await sumPaidBySubscription(visible.map((doc) => doc._id));
  return docs.map((doc) => {
    const sale =
      doc.sale && canSeeSale(viewer, doc.gymIds ?? []) ? doc.sale : null;
    const standing = sale
      ? balanceFromPaid(sale.priceMinor, paid.get(doc._id.toHexString()) ?? 0)
      : null;
    return {
      id: doc._id.toHexString(),
      userId: doc.userId.toHexString(),
      startsAt: doc.startsAt.toISOString(),
      endsAt: doc.endsAt.toISOString(),
      note: doc.note ?? undefined,
      gymIds: (doc.gymIds ?? []).map((id) => id.toHexString()),
      createdBy: doc.createdBy,
      createdAt: doc.createdAt.toISOString(),
      sale: sale
        ? {
            packageId: sale.packageId?.toHexString() ?? null,
            packageName: sale.packageName,
            duration: sale.duration,
            listPriceMinor: sale.listPriceMinor,
            priceMinor: sale.priceMinor,
            currency: sale.currency,
            nextPaymentDue: sale.nextPaymentDue?.toISOString() ?? null,
          }
        : null,
      paidMinor: standing?.paidMinor ?? null,
      balanceMinor: standing?.balanceMinor ?? null,
    };
  });
}
