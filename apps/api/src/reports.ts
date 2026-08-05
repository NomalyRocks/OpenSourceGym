import type {
  EntryTrend,
  EntryTrendPoint,
  ReportSummary,
} from "@opengym/shared";
import type { Db, Document } from "mongodb";
import { db } from "./db.js";
import { env } from "./env.js";

/** Maximum report range—limits the number of chart buckets. */
export const MAX_REPORT_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWAL_WINDOW_DAYS = 7;

/**
 * Returns an instant's calendar day in the given time zone as `YYYY-MM-DD`.
 * `en-CA` produces exactly this format, avoiding manual component assembly.
 */
export function localDayLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Produces labels for the local days covered by the range, in order.
 *
 * Step through the label itself, not the timestamp: "add 24 hours" skips or
 * repeats a day across daylight-saving transitions. Advancing by calendar day
 * is independent of time-zone rules.
 */
export function dayLabels(from: Date, to: Date, timeZone: string): string[] {
  const labels: string[] = [];
  const last = localDayLabel(to, timeZone);
  let current = localDayLabel(from, timeZone);

  // A malformed range must not become an infinite loop; cap it at the bucket limit.
  for (let guard = 0; guard <= MAX_REPORT_RANGE_DAYS; guard++) {
    labels.push(current);
    if (current >= last) break;
    current = nextDayLabel(current);
  }
  return labels;
}

function nextDayLabel(label: string): string {
  const [year, month, day] = label.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

async function countFrom(
  database: Db,
  collection: string,
  pipeline: Document[],
): Promise<number> {
  const [result] = await database
    .collection(collection)
    .aggregate<{ n: number }>([...pipeline, { $count: "n" }])
    .toArray();
  return result?.n ?? 0;
}

/**
 * Looks at the end of the member's LATEST subscription. Counting "any active
 * subscription" with `distinct` would mislead: a member with a newer package
 * appended would still appear as "renewal approaching."
 */
function latestEndPipeline(match: Document): Document[] {
  return [
    { $group: { _id: "$userId", latestEnd: { $max: "$endsAt" } } },
    { $match: { latestEnd: match } },
  ];
}

/** Number of unique members whose subscription ends within the next seven days. */
export async function countRenewalsDue(
  database: Db = db,
  now = new Date(),
): Promise<number> {
  return countFrom(
    database,
    "subscriptions",
    latestEndPipeline({
      $gte: now,
      $lte: new Date(now.getTime() + RENEWAL_WINDOW_DAYS * DAY_MS),
    }),
  );
}

/** Number of unique members with an active subscription now. */
export async function countActiveMembers(
  database: Db = db,
  now = new Date(),
): Promise<number> {
  return countFrom(database, "subscriptions", [
    { $match: { startsAt: { $lte: now }, endsAt: { $gte: now } } },
    { $group: { _id: "$userId" } },
  ]);
}

export interface ReportRangeInput {
  from: Date;
  to: Date;
}

export async function buildReportSummary(
  { from, to }: ReportRangeInput,
  database: Db = db,
  now = new Date(),
): Promise<ReportSummary> {
  const [
    activeMembers,
    renewalsDue,
    newMembers,
    newSubscriptions,
    lapsedMembers,
    entries,
  ] = await Promise.all([
    countActiveMembers(database, now),
    countRenewalsDue(database, now),
    database
      .collection("user")
      .countDocuments({ role: "member", createdAt: { $gte: from, $lte: to } }),
    database
      .collection("subscriptions")
      .countDocuments({ createdAt: { $gte: from, $lte: to } }),
    // Members ending in the range AND not renewed by range end: if the latest
    // end remains within the range, the member is unsubscribed at range end.
    countFrom(
      database,
      "subscriptions",
      latestEndPipeline({ $gte: from, $lte: to }),
    ),
    aggregateEntryTotals(database, from, to),
  ]);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    timeZone: env.reportsTimeZone,
    activeMembers,
    newMembers,
    newSubscriptions,
    lapsedMembers,
    renewalsDue,
    entries,
  };
}

interface EntryTotals {
  total: number;
  allowed: number;
  denied: number;
  uniqueMembers: number;
}

/**
 * Totals and unique-member count are collected in one pass. Unique members are
 * not accumulated with `$addToSet`: the array could hit the document-size limit,
 * while a separate `$group` plus `$count` branch uses constant memory.
 */
async function aggregateEntryTotals(
  database: Db,
  from: Date,
  to: Date,
): Promise<EntryTotals> {
  const [result] = await database
    .collection("entry_events")
    .aggregate<{
      totals: { total: number; allowed: number }[];
      members: { n: number }[];
    }>([
      { $match: { at: { $gte: from, $lte: to } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                allowed: {
                  $sum: { $cond: [{ $eq: ["$allowed", true] }, 1, 0] },
                },
              },
            },
          ],
          members: [
            { $match: { userId: { $ne: null } } },
            { $group: { _id: "$userId" } },
            { $count: "n" },
          ],
        },
      },
    ])
    .toArray();

  const total = result?.totals[0]?.total ?? 0;
  const allowed = result?.totals[0]?.allowed ?? 0;
  return {
    total,
    allowed,
    denied: total - allowed,
    uniqueMembers: result?.members[0]?.n ?? 0,
  };
}

export async function buildEntryTrend(
  { from, to }: ReportRangeInput,
  database: Db = db,
): Promise<EntryTrend> {
  const timeZone = env.reportsTimeZone;
  const rows = await database
    .collection("entry_events")
    .aggregate<{ _id: string; total: number; allowed: number }>([
      { $match: { at: { $gte: from, $lte: to } } },
      {
        $group: {
          // The bucket boundary is the gym's local day: grouping by UTC would
          // move events near midnight to an adjacent day.
          _id: {
            $dateToString: {
              date: "$at",
              format: "%Y-%m-%d",
              timezone: timeZone,
            },
          },
          total: { $sum: 1 },
          allowed: { $sum: { $cond: [{ $eq: ["$allowed", true] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  const byDay = new Map(rows.map((row) => [row._id, row]));
  // Empty days also become points: missing buckets read as "no data" rather
  // than "nobody attended that day" and distort the chart trend.
  const points: EntryTrendPoint[] = dayLabels(from, to, timeZone).map(
    (date) => {
      const row = byDay.get(date);
      const total = row?.total ?? 0;
      const allowed = row?.allowed ?? 0;
      return { date, total, allowed, denied: total - allowed };
    },
  );

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    timeZone,
    points,
  };
}
