/**
 * Pure resolution logic for the calendar's weight layer—directly testable
 * because it has no dependency on `../lib/api` (and therefore react-native).
 *
 * If the selected day has no entry, the latest value entered on or before that
 * day applies (carry forward). A later entry remains invisible and is never
 * carried backward.
 */

import type { MyWeightEntry } from "@opengym/shared";
import { dayKey } from "./dateKeys";

export type WeightEntry = MyWeightEntry;

/**
 * `entries` must be sorted in ascending time order (the server returns them this
 * way). Finds the latest entry up to and including the target day; returns
 * `null` if none match.
 */
export function resolveWeightForDay(
  entries: WeightEntry[],
  targetDayKey: string,
): number | null {
  let result: number | null = null;
  for (const entry of entries) {
    if (dayKey(new Date(entry.at)) > targetDayKey) break;
    result = entry.weightKg;
  }
  return result;
}
