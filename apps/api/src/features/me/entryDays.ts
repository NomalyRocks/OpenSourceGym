import type { MyEntryDay } from "@opengym/shared";

/**
 * Day-label (`YYYY-MM-DD`) helpers for the calendar's attendance layer.
 *
 * The day boundary is the gym's local day (`REPORTS_TIME_ZONE`): grouping by
 * UTC would move entries near midnight to an adjacent day.
 */

/** Day-label format accepted in query parameters. */
export const DAY_LABEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Maximum days requested at once—the calendar fetches one month. */
export const MAX_ENTRY_RANGE_DAYS = 92;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum offset of a local day boundary from UTC (UTC-12 … UTC+14).
 * The query window is widened by this amount; extra days included in the
 * window are removed by label after grouping.
 */
const MAX_TZ_OFFSET_MS = 14 * 60 * 60 * 1000;

function labelToUtc(label: string): number {
  return Date.parse(`${label}T00:00:00Z`);
}

/** Day difference between two day labels; negative when `to` is earlier. */
export function dayLabelSpan(from: string, to: string): number {
  return (labelToUtc(to) - labelToUtc(from)) / DAY_MS;
}

/**
 * UTC window used to scan the range by `at`. It is widened by the time-zone
 * offset: the first entry of the local `from` day may fall on the previous UTC
 * day, and the last entry of the local `to` day may fall on the next one.
 */
export function entryQueryWindow(
  from: string,
  to: string,
): { start: Date; end: Date } {
  return {
    start: new Date(labelToUtc(from) - MAX_TZ_OFFSET_MS),
    end: new Date(labelToUtc(to) + DAY_MS + MAX_TZ_OFFSET_MS),
  };
}

/**
 * Reduces the grouping result to the response shape: days outside the window
 * are removed and the rest are sorted by date. Empty days are omitted—the
 * client interprets a missing key as "no attendance."
 */
export function toEntryDays(
  rows: { _id: string; entries: number }[],
  from: string,
  to: string,
): MyEntryDay[] {
  return rows
    .filter((row) => row._id >= from && row._id <= to && row.entries > 0)
    .map((row) => ({ date: row._id, entries: row.entries }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
