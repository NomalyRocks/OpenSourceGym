/**
 * Calendar attendance layer.
 *
 * Source: `GET /api/me/entries`. It returns the signed-in member's `entry_events`
 * records grouped into days according to the gym time zone (`REPORTS_TIME_ZONE`).
 * Only allowed scans in the entry direction are counted.
 */

import type { MyEntriesResponse, MyEntryDay } from "@opengym/shared";
import { api } from "./api";

export type AttendanceDay = MyEntryDay;

export interface AttendanceRange {
  /** First day of the range (local), `YYYY-MM-DD`. */
  from: string;
  /** Last day of the range (local), `YYYY-MM-DD`. */
  to: string;
}

export interface AttendanceResult {
  /** Only days with at least one visit, sorted by ascending date. */
  days: AttendanceDay[];
  /** Gym time zone used to calculate the days. */
  timeZone: string;
}

export async function fetchAttendance(
  range: AttendanceRange,
): Promise<AttendanceResult> {
  const from = encodeURIComponent(range.from);
  const to = encodeURIComponent(range.to);
  return api<MyEntriesResponse>(`/api/me/entries?from=${from}&to=${to}`);
}
