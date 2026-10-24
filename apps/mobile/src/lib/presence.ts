const MINUTE_MS = 60_000;

/**
 * Elapsed time inside a gym: whole minutes below an hour ("0 min", "59 min"),
 * then a language-neutral `H:MM` clock ("1:00", "2:05"). Negative durations
 * (clock skew) read as zero.
 */
export function formatInsideDuration(
  ms: number,
  minuteLabel: (minutes: number) => string = (n) => `${n} min`,
): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return minuteLabel(minutes);
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Milliseconds until the next whole minute of elapsed time since `startMs`. */
export function msToNextMinute(startMs: number, nowMs: number): number {
  const elapsed = Math.max(0, nowMs - startMs);
  return MINUTE_MS - (elapsed % MINUTE_MS);
}
