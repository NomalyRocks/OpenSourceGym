import { WEEK_START, dayKey } from "./dateKeys";

/** Local-time Monday (per `WEEK_START`) of the week containing `reference`. */
export function weekStart(reference: Date): Date {
  const diff = (reference.getDay() - WEEK_START + 7) % 7;
  return new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() - diff,
  );
}

/**
 * Visits per week for the last `weeks` weeks, oldest first; the last entry is
 * the week containing `today`. `days` are `YYYY-MM-DD` keys with entry counts.
 */
export function weeklyVisits(
  days: ReadonlyArray<{ date: string; entries: number }>,
  today: Date,
  weeks: number,
): number[] {
  const current = weekStart(today);
  const startKeys = Array.from({ length: weeks }, (_, index) => {
    const start = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() - 7 * (weeks - 1 - index),
    );
    return dayKey(start);
  });
  const counts = new Array<number>(weeks).fill(0);
  for (const day of days) {
    if (day.entries <= 0) continue;
    const [y, m, d] = day.date.split("-").map(Number);
    if (!y || !m || !d) continue;
    const key = dayKey(weekStart(new Date(y, m - 1, d)));
    const index = startKeys.indexOf(key);
    if (index >= 0) counts[index] = (counts[index] ?? 0) + day.entries;
  }
  return counts;
}

/**
 * Consecutive weeks with at least one visit, counting back from the newest.
 * An empty current week does not break the streak yet: the member still has
 * the rest of the week to visit.
 */
export function weekStreak(counts: readonly number[]): number {
  let index = counts.length - 1;
  if (index >= 0 && (counts[index] ?? 0) === 0) index -= 1;
  let streak = 0;
  while (index >= 0 && (counts[index] ?? 0) > 0) {
    streak += 1;
    index -= 1;
  }
  return streak;
}
