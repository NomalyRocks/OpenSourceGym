import type { MyBusyHours } from "@opengym/shared";

/** How many past same-weekday days the profile averages. */
export const BUSY_HOURS_SAMPLE_DAYS = 4;

/**
 * Hour buckets with fewer raw entries than this over all sample days report 0.
 * At a small gym an off-peak 0.25 means "one person comes at this hour on this
 * weekday", which can confirm a regular's routine (KVKK).
 */
export const BUSY_HOURS_MIN_COUNT = 3;

const DAY_MS = 86_400_000;

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
}

/** Local calendar day (`YYYY-MM-DD`) and hour (0..23) of an instant in a zone. */
export function zonedDayHour(
  at: Date,
  timeZone: string,
): { day: string; hour: number } {
  const parts: Record<string, string> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(at)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
  };
}

function shiftDayLabel(label: string, days: number): string {
  return new Date(Date.parse(`${label}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Weekday of a day label, 0 = Sunday. */
export function dayLabelWeekday(label: string): number {
  return new Date(`${label}T00:00:00Z`).getUTCDay();
}

/** The previous `count` same-weekday day labels, nearest first, today excluded. */
export function sameWeekdayLabels(
  today: string,
  count = BUSY_HOURS_SAMPLE_DAYS,
): string[] {
  return Array.from({ length: count }, (_, i) =>
    shiftDayLabel(today, -7 * (i + 1)),
  );
}

/**
 * Average allowed entries per local hour over the recent same-weekday days.
 * A sample day counts only once the gym existed (its local creation day or
 * later); entries on other days are ignored. Fewer than four sample days, or
 * none, simply divide by what there is. Buckets below
 * {@link BUSY_HOURS_MIN_COUNT} are suppressed to 0.
 */
export function buildBusyHours(input: {
  gymId: string;
  timeZone: string;
  now: Date;
  gymCreatedAt: Date;
  entryTimes: readonly Date[];
}): MyBusyHours {
  const { gymId, timeZone, now, gymCreatedAt, entryTimes } = input;
  const today = zonedDayHour(now, timeZone).day;
  const createdDay = zonedDayHour(gymCreatedAt, timeZone).day;
  const sampled = new Set(
    sameWeekdayLabels(today).filter((label) => label >= createdDay),
  );
  const counts = new Array<number>(24).fill(0);
  for (const at of entryTimes) {
    const { day, hour } = zonedDayHour(at, timeZone);
    if (sampled.has(day)) counts[hour] = (counts[hour] ?? 0) + 1;
  }
  const sampleDays = sampled.size;
  return {
    gymId,
    timeZone,
    weekday: dayLabelWeekday(today),
    sampleDays,
    hours: counts.map((count, hour) => ({
      hour,
      avgEntries:
        sampleDays === 0 || count < BUSY_HOURS_MIN_COUNT
          ? 0
          : Math.round((count / sampleDays) * 10) / 10,
    })),
  };
}

/** UTC range wide enough to cover every sample day in any zone offset. */
export function busyHoursQueryRange(
  today: string,
  count = BUSY_HOURS_SAMPLE_DAYS,
): { start: Date; end: Date } {
  const margin = 14 * 3_600_000;
  const oldest = shiftDayLabel(today, -7 * count);
  return {
    start: new Date(Date.parse(`${oldest}T00:00:00Z`) - margin),
    end: new Date(Date.parse(`${today}T00:00:00Z`) + margin),
  };
}
