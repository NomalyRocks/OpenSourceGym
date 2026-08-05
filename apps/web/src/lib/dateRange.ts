/**
 * Conversion between `<input type="date">` values and the ISO timestamps expected
 * by the API. It is centralized because two rules must be applied consistently at
 * every call site, and both are easy to miss when implemented manually:
 *
 * 1. Interpret the date as LOCAL. `new Date("2026-07-29")` returns UTC midnight;
 *    if the gym is in UTC+3, that instant falls on July 28, not July 29.
 * 2. Pin the end to the END of the day. Sending 00:00 makes the `$lte` filter
 *    exclude the selected final day entirely and returns an empty one-day range.
 */

/** `<input type="date">` format (YYYY-MM-DD), based on the browser's local day. */
export function dateInputValue(at: Date): string {
  const offset = at.getTimezoneOffset() * 60 * 1000;
  return new Date(at.getTime() - offset).toISOString().slice(0, 10);
}

function isoAt(day: string, time: string): string | null {
  if (!day) return null;
  const at = new Date(`${day}T${time}`);
  // The user can clear the date input; calling toISOString() on Invalid Date
  // would throw a RangeError and crash the entire page.
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/** Start of the local day (00:00:00.000). Null for empty/invalid input. */
export function dayStartIso(day: string): string | null {
  return isoAt(day, "00:00:00.000");
}

/** End of the local day (23:59:59.999). Null for empty/invalid input. */
export function dayEndIso(day: string): string | null {
  return isoAt(day, "23:59:59.999");
}

/** For queries requiring both bounds; returns null if either is invalid. */
export function rangeBounds(
  from: string,
  to: string,
): { from: string; to: string } | null {
  const start = dayStartIso(from);
  const end = dayEndIso(to);
  return start && end ? { from: start, to: end } : null;
}
