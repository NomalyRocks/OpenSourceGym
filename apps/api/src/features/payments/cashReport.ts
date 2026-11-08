import type { Db } from "mongodb";
import type {
  CashReport,
  CashReportPayment,
  CashTotals,
  CurrencyCode,
  PaymentMethod,
} from "@opengym/shared";
import { db } from "../../core/db.js";
import { localDayRange } from "../reports/reports.js";
import { loadUserNames, toPayment } from "./payments.js";
import { paymentCollection, type PaymentDocument } from "./paymentStore.js";

/** Cap only the displayed rows; totals always cover the whole day. */
const MAX_DAY_PAYMENTS = 5000;

type PaymentTotalRow = Pick<
  PaymentDocument,
  "amountMinor" | "currency" | "method" | "recordedBy"
> & { count?: number };

/**
 * Totals of non-voided payments, one entry per currency (the chain currency may
 * have changed). Pure so the arithmetic is testable without a database.
 */
export function totalPayments(
  payments: readonly PaymentTotalRow[],
  staffNames: ReadonlyMap<string, string> = new Map(),
): CashTotals[] {
  const byCurrency = new Map<
    CurrencyCode,
    {
      totalMinor: number;
      count: number;
      methods: Map<PaymentMethod, { totalMinor: number; count: number }>;
      staff: Map<string, { totalMinor: number; count: number }>;
    }
  >();
  for (const payment of payments) {
    let entry = byCurrency.get(payment.currency);
    if (!entry) {
      entry = {
        totalMinor: 0,
        count: 0,
        methods: new Map(),
        staff: new Map(),
      };
      byCurrency.set(payment.currency, entry);
    }
    entry.totalMinor += payment.amountMinor;
    const count = payment.count ?? 1;
    entry.count += count;
    const method = entry.methods.get(payment.method) ?? {
      totalMinor: 0,
      count: 0,
    };
    method.totalMinor += payment.amountMinor;
    method.count += count;
    entry.methods.set(payment.method, method);
    const staff = entry.staff.get(payment.recordedBy) ?? {
      totalMinor: 0,
      count: 0,
    };
    staff.totalMinor += payment.amountMinor;
    staff.count += count;
    entry.staff.set(payment.recordedBy, staff);
  }
  return [...byCurrency.entries()].map(([currency, entry]) => ({
    currency,
    totalMinor: entry.totalMinor,
    count: entry.count,
    byMethod: [...entry.methods.entries()]
      .map(([method, sums]) => ({ method, ...sums }))
      .sort((left, right) => right.totalMinor - left.totalMinor),
    byStaff: [...entry.staff.entries()]
      .map(([userId, sums]) => ({
        userId,
        name: staffNames.get(userId) ?? null,
        ...sums,
      }))
      .sort((left, right) => right.totalMinor - left.totalMinor),
  }));
}

/**
 * Daily cash report for one gym: payments recorded there during the local day,
 * voided ones listed apart and left out of the totals.
 */
export async function buildCashReport(
  gymId: string,
  day: string,
  timeZone: string,
  database: Db = db,
): Promise<CashReport> {
  const { from, to } = localDayRange(day, timeZone);
  const payments = paymentCollection(database);
  const filter = { gymId, paidAt: { $gte: from, $lt: to } };
  const [rows, totals] = await Promise.all([
    payments
      .find(filter)
      .sort({ paidAt: 1, _id: 1 })
      .limit(MAX_DAY_PAYMENTS + 1)
      .toArray(),
    payments
      .aggregate<PaymentTotalRow>([
        { $match: { ...filter, void: null } },
        {
          $group: {
            _id: {
              currency: "$currency",
              method: "$method",
              recordedBy: "$recordedBy",
            },
            amountMinor: { $sum: "$amountMinor" },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            currency: "$_id.currency",
            method: "$_id.method",
            recordedBy: "$_id.recordedBy",
            amountMinor: 1,
            count: 1,
          },
        },
      ])
      .toArray(),
  ]);
  const docs = rows.slice(0, MAX_DAY_PAYMENTS);

  const memberIds = docs.flatMap((doc) => (doc.userId ? [doc.userId] : []));
  const names = await loadUserNames([
    ...docs.map((doc) => doc.recordedBy),
    ...totals.map((total) => total.recordedBy),
    ...docs.flatMap((doc) => (doc.void ? [doc.void.by] : [])),
    ...memberIds,
  ]);
  const toRow = (doc: PaymentDocument): CashReportPayment => ({
    ...toPayment(doc, names),
    memberName: doc.userId ? (names.get(doc.userId) ?? null) : null,
  });

  const standing = docs.filter((doc) => !doc.void);
  return {
    day,
    timeZone,
    totals: totalPayments(totals, names),
    truncated: rows.length > MAX_DAY_PAYMENTS,
    payments: standing.map(toRow),
    voided: docs.filter((doc) => doc.void).map(toRow),
  };
}
