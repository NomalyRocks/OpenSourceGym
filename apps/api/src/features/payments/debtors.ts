import { ObjectId, type Db, type Document } from "mongodb";
import type { CurrencyCode, DebtorRow } from "@opengym/shared";
import { db } from "../../core/db.js";
import { InvalidCursorError } from "../../lib/pagination.js";

/** Sort position of a period with no promise date: after every dated one. */
const NO_DUE_MS = 8_640_000_000_000_000;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

interface DebtorCursor {
  dueMs: number;
  balanceMinor: number;
  id: ObjectId;
}

/**
 * Debtors sort by due date, then balance, then id, so the keyset cursor carries
 * all three. It stays opaque to clients like every other cursor.
 */
export function encodeDebtorCursor(cursor: DebtorCursor): string {
  return Buffer.from(
    `${cursor.dueMs}:${cursor.balanceMinor}:${cursor.id.toHexString()}`,
  ).toString("base64url");
}

export function decodeDebtorCursor(raw: string): DebtorCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [due, balance, hex, ...rest] = decoded.split(":");
  if (rest.length > 0 || due === undefined || balance === undefined) {
    return null;
  }
  const dueMs = Number(due);
  const balanceMinor = Number(balance);
  if (
    !Number.isSafeInteger(dueMs) ||
    !Number.isSafeInteger(balanceMinor) ||
    hex === undefined ||
    !OBJECT_ID_HEX.test(hex)
  ) {
    return null;
  }
  return { dueMs, balanceMinor, id: new ObjectId(hex) };
}

interface DebtorAggregateRow {
  _id: ObjectId;
  userId: ObjectId;
  startsAt: Date;
  endsAt: Date;
  sale: {
    packageName: string;
    priceMinor: number;
    currency: CurrencyCode;
    nextPaymentDue: Date | null;
  };
  paidMinor: number;
  balanceMinor: number;
  dueMs: number;
  user?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
}

export interface DebtorsPage {
  items: DebtorRow[];
  nextCursor: string | null;
}

/**
 * Periods listing the gym that were sold (have a `sale`) and still owe money.
 * Overdue first (a past `nextPaymentDue` sorts before a future one), then by
 * due date, then the larger balance first. Frozen and expired periods are
 * included: a debt does not lapse with the membership.
 */
export async function listDebtors(
  params: {
    gymId: string;
    limit: number;
    cursor?: string | undefined;
    now?: Date;
  },
  database: Db = db,
): Promise<DebtorsPage> {
  const now = params.now ?? new Date();
  const cursor = params.cursor ? decodeDebtorCursor(params.cursor) : null;
  if (params.cursor && !cursor) throw new InvalidCursorError();

  const afterCursor: Document[] = cursor
    ? [
        {
          $match: {
            $or: [
              { dueMs: { $gt: cursor.dueMs } },
              {
                dueMs: cursor.dueMs,
                balanceMinor: { $lt: cursor.balanceMinor },
              },
              {
                dueMs: cursor.dueMs,
                balanceMinor: cursor.balanceMinor,
                _id: { $gt: cursor.id },
              },
            ],
          },
        },
      ]
    : [];

  const rows = await database
    .collection("subscriptions")
    .aggregate<DebtorAggregateRow>([
      {
        $match: {
          gymIds: new ObjectId(params.gymId),
          "sale.priceMinor": { $gt: 0 },
        },
      },
      {
        $lookup: {
          from: "payments",
          let: { sid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$subscriptionId", "$$sid"] },
                    { $eq: [{ $ifNull: ["$void", null] }, null] },
                  ],
                },
              },
            },
            { $group: { _id: null, paid: { $sum: "$amountMinor" } } },
          ],
          as: "paidDocs",
        },
      },
      {
        $addFields: {
          paidMinor: { $ifNull: [{ $first: "$paidDocs.paid" }, 0] },
        },
      },
      {
        $addFields: {
          balanceMinor: { $subtract: ["$sale.priceMinor", "$paidMinor"] },
          dueMs: {
            $ifNull: [{ $toLong: "$sale.nextPaymentDue" }, NO_DUE_MS],
          },
        },
      },
      { $match: { balanceMinor: { $gt: 0 } } },
      ...afterCursor,
      { $sort: { dueMs: 1, balanceMinor: -1, _id: 1 } },
      // limit + 1: an extra row means another page exists.
      { $limit: params.limit + 1 },
      {
        $lookup: {
          from: "user",
          localField: "userId",
          foreignField: "_id",
          as: "userDocs",
        },
      },
      { $addFields: { user: { $first: "$userDocs" } } },
    ])
    .toArray();

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      subscriptionId: row._id.toHexString(),
      userId: row.userId.toHexString(),
      firstName: row.user?.firstName ?? "",
      lastName: row.user?.lastName ?? "",
      email: row.user?.email ?? "",
      phone: row.user?.phone ?? "",
      packageName: row.sale.packageName,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      priceMinor: row.sale.priceMinor,
      paidMinor: row.paidMinor,
      balanceMinor: row.balanceMinor,
      currency: row.sale.currency,
      nextPaymentDue: row.sale.nextPaymentDue?.toISOString() ?? null,
      overdue:
        row.sale.nextPaymentDue !== null &&
        row.sale.nextPaymentDue.getTime() < now.getTime(),
    })),
    nextCursor:
      hasMore && last
        ? encodeDebtorCursor({
            dueMs: last.dueMs,
            balanceMinor: last.balanceMinor,
            id: last._id,
          })
        : null,
  };
}
