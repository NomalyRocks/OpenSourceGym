/**
 * Takvimin geliş katmanı.
 *
 * Kaynak `GET /api/me/entries`: oturumdaki üyenin `entry_events` kayıtları,
 * salonun saat dilimine (`REPORTS_TIME_ZONE`) göre günlere indirgenmiş halde
 * döner. Yalnızca izin verilen ve giriş yönündeki taramalar sayılır.
 */

import type { MyEntriesResponse, MyEntryDay } from "@opengym/shared";
import { api } from "./api";

export type AttendanceDay = MyEntryDay;

export interface AttendanceRange {
  /** Aralığın ilk günü (yerel), `YYYY-MM-DD`. */
  from: string;
  /** Aralığın son günü (yerel), `YYYY-MM-DD`. */
  to: string;
}

export interface AttendanceResult {
  /** Yalnızca en az bir geliş olan günler; tarihe göre artan sırada. */
  days: AttendanceDay[];
  /** Günlerin hesaplandığı salon saat dilimi. */
  timeZone: string;
}

export async function fetchAttendance(
  range: AttendanceRange,
): Promise<AttendanceResult> {
  const from = encodeURIComponent(range.from);
  const to = encodeURIComponent(range.to);
  return api<MyEntriesResponse>(`/api/me/entries?from=${from}&to=${to}`);
}
