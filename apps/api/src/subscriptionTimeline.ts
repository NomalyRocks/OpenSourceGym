import type { SubscriptionMonths } from "@opengym/shared";

const DAY_MS = 86_400_000;

export interface SubscriptionTimelineRecord {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

export interface SubscriptionTimelineRepair {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

export interface SubscriptionPeriod {
  startsAt: Date;
  endsAt: Date;
}

export interface SubscriptionSummary {
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  remainingDays: number;
}

/**
 * Adds UTC calendar months to a date. If the source day does not exist in the
 * target month, clamps it to the month's final day (January 31 + 1 month =
 * February 28/29).
 */
export function addUtcCalendarMonthsClamped(
  date: Date,
  months: SubscriptionMonths,
): Date {
  const targetMonthIndex = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();

  const result = new Date(date.getTime());
  result.setUTCFullYear(
    targetYear,
    targetMonth,
    Math.min(date.getUTCDate(), lastDayOfTargetMonth),
  );
  return result;
}

/** Starts a new package after the latest subscription, or now if it has ended. */
export function calculateSubscriptionPeriod(
  now: Date,
  latestEndsAt: Date | null,
  months: SubscriptionMonths,
): SubscriptionPeriod {
  const startsAt = new Date(
    Math.max(
      now.getTime(),
      latestEndsAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    ),
  );
  return {
    startsAt,
    endsAt: addUtcCalendarMonthsClamped(startsAt, months),
  };
}

/**
 * Arranges legacy records into a single timeline in creation order. The first
 * record is preserved; if a later record overlaps the previous one, it moves to
 * the previous record's end without changing its millisecond duration.
 */
export function planLegacySubscriptionRepairs(
  records: readonly SubscriptionTimelineRecord[],
): SubscriptionTimelineRepair[] {
  const sorted = [...records].sort((left, right) => {
    const userOrder = left.userId.localeCompare(right.userId);
    if (userOrder !== 0) return userOrder;
    const createdOrder = left.createdAt.getTime() - right.createdAt.getTime();
    return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
  });

  const repairs: SubscriptionTimelineRepair[] = [];
  let previousUserId: string | null = null;
  let previousEndsAt: Date | null = null;

  for (const record of sorted) {
    const durationMs = record.endsAt.getTime() - record.startsAt.getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RangeError(`Invalid subscription duration: ${record.id}`);
    }

    if (record.userId !== previousUserId) {
      previousUserId = record.userId;
      previousEndsAt = new Date(record.endsAt.getTime());
      continue;
    }

    if (record.startsAt.getTime() < previousEndsAt!.getTime()) {
      const startsAt: Date = new Date(previousEndsAt!.getTime());
      const endsAt: Date = new Date(startsAt.getTime() + durationMs);
      repairs.push({ id: record.id, startsAt, endsAt });
      previousEndsAt = endsAt;
      continue;
    }

    previousEndsAt = new Date(record.endsAt.getTime());
  }

  return repairs;
}

/**
 * Plans the timeline change for cancelling a not-yet-started period: every
 * other period that starts at or after the cancelled period's end moves earlier
 * by the cancelled duration (keeping its own duration), so no gap is left.
 * Periods before the cancelled one are untouched. Returned in start order.
 */
export function planSubscriptionCancellation(
  cancelled: SubscriptionPeriod,
  others: readonly (SubscriptionPeriod & { id: string })[],
): SubscriptionTimelineRepair[] {
  const durationMs = cancelled.endsAt.getTime() - cancelled.startsAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError("Invalid cancelled subscription duration");
  }
  return others
    .filter((record) => record.startsAt.getTime() >= cancelled.endsAt.getTime())
    .sort(
      (left, right) =>
        left.startsAt.getTime() - right.startsAt.getTime() ||
        left.endsAt.getTime() - right.endsAt.getTime(),
    )
    .map((record) => ({
      id: record.id,
      startsAt: new Date(record.startsAt.getTime() - durationMs),
      endsAt: new Date(record.endsAt.getTime() - durationMs),
    }));
}

/**
 * Credit a finished freeze gives back, in ms: the time actually frozen, capped
 * at `maxDays`. Never negative, so a clock hiccup cannot pull periods earlier.
 */
export function calculateFreezeCreditMs(
  startedAt: Date,
  endedAt: Date,
  maxDays: number,
): number {
  const frozenMs = endedAt.getTime() - startedAt.getTime();
  return Math.max(0, Math.min(frozenMs, maxDays * DAY_MS));
}

/**
 * Plans the timeline change when a freeze that began at `startedAt` ends with
 * `creditMs` to give back. Only periods with `endsAt > startedAt` are touched,
 * in start order, and the timeline is repacked:
 *
 * - the period running at `startedAt` keeps its start and gets a later end;
 * - every later period keeps its own duration and starts at the later of its
 *   original start and the previous period's new end.
 *
 * Repacking (instead of sliding everything by the credit) matters when a period
 * was added during the freeze: it already starts right after the old end, so a
 * blind slide would leave the member uncovered between the extended period and
 * the pushed one. Returns every affected period, changed or not.
 */
export function planFreezeCredit(
  periods: readonly (SubscriptionPeriod & { id: string })[],
  startedAt: Date,
  creditMs: number,
): SubscriptionTimelineRepair[] {
  if (!Number.isFinite(creditMs) || creditMs <= 0) return [];
  const affected = periods
    .filter((period) => period.endsAt.getTime() > startedAt.getTime())
    .sort(
      (left, right) =>
        left.startsAt.getTime() - right.startsAt.getTime() ||
        left.endsAt.getTime() - right.endsAt.getTime(),
    );

  const plan: SubscriptionTimelineRepair[] = [];
  let previousEnd: number | null = null;
  for (const period of affected) {
    const durationMs = period.endsAt.getTime() - period.startsAt.getTime();
    let startMs = period.startsAt.getTime();
    let endMs: number;
    if (startMs <= startedAt.getTime()) {
      endMs = period.endsAt.getTime() + creditMs;
    } else {
      if (previousEnd !== null) startMs = Math.max(startMs, previousEnd);
      endMs = startMs + durationMs;
    }
    previousEnd = endMs;
    plan.push({
      id: period.id,
      startsAt: new Date(startMs),
      endsAt: new Date(endMs),
    });
  }
  return plan;
}

export type EntryAccess = "ok" | "none" | "other-gym";

/** Entry decision against a set of periods: covering now, and listing the gym. */
export function evaluateEntryAccess(
  periods: readonly (SubscriptionPeriod & { gymIds: readonly string[] })[],
  now: Date,
  gymId: string,
): EntryAccess {
  const covering = periods.filter(
    (period) =>
      period.startsAt.getTime() <= now.getTime() &&
      period.endsAt.getTime() >= now.getTime(),
  );
  if (covering.length === 0) return "none";
  return covering.some((period) => period.gymIds.includes(gymId))
    ? "ok"
    : "other-gym";
}

/**
 * The periods as they would stand if the freeze that began at `freeze.startedAt`
 * ended at `now`: the credit is the frozen time so far, capped at `maxDays`, and
 * it is repacked with {@link planFreezeCredit}. Periods the plan does not touch
 * come back unchanged. Nothing is written; the summary and the entry dry run
 * both read the timeline through this, so they agree on one answer.
 */
export function previewFreezeCredit<
  T extends SubscriptionPeriod & { id: string },
>(
  periods: readonly T[],
  freeze: { startedAt: Date; maxDays: number },
  now: Date,
): T[] {
  const creditMs = calculateFreezeCreditMs(
    freeze.startedAt,
    now,
    freeze.maxDays,
  );
  const planned = new Map(
    planFreezeCredit(periods, freeze.startedAt, creditMs).map((change) => [
      change.id,
      change,
    ]),
  );
  return periods.map((period) => {
    const change = planned.get(period.id);
    return change
      ? { ...period, startsAt: change.startsAt, endsAt: change.endsAt }
      : period;
  });
}

/**
 * Dry run of ending a freeze right now: would the member be let in at `gymId`
 * once the credit is applied? The gate uses this to decide an entry scan
 * without ending the freeze, which happens only after the turnstile opened, so
 * a refused scan never unfreezes anyone.
 */
export function evaluateEntryWithFreezeCredit(
  periods: readonly (SubscriptionPeriod & {
    id: string;
    gymIds: readonly string[];
  })[],
  freeze: { startedAt: Date; maxDays: number },
  now: Date,
  gymId: string,
): EntryAccess {
  return evaluateEntryAccess(
    previewFreezeCredit(periods, freeze, now),
    now,
    gymId,
  );
}

/** Combines the active interval and contiguous future packages into one end. */
export function summarizeSubscriptionTimeline(
  records: readonly Pick<SubscriptionTimelineRecord, "startsAt" | "endsAt">[],
  now: Date,
): SubscriptionSummary {
  const sorted = [...records].sort(
    (left, right) =>
      left.startsAt.getTime() - right.startsAt.getTime() ||
      left.endsAt.getTime() - right.endsAt.getTime(),
  );
  let entitlementStartsAt: Date | null = null;
  let entitlementEndsAt: Date | null = null;

  for (const record of sorted) {
    if (entitlementEndsAt === null) {
      if (record.startsAt <= now && record.endsAt >= now) {
        entitlementStartsAt = new Date(record.startsAt.getTime());
        entitlementEndsAt = new Date(record.endsAt.getTime());
      }
      continue;
    }

    if (record.startsAt.getTime() > entitlementEndsAt.getTime()) break;
    if (record.endsAt.getTime() > entitlementEndsAt.getTime()) {
      entitlementEndsAt = new Date(record.endsAt.getTime());
    }
  }

  if (entitlementEndsAt === null) {
    return { active: false, startsAt: null, endsAt: null, remainingDays: 0 };
  }

  return {
    active: true,
    startsAt: entitlementStartsAt,
    endsAt: entitlementEndsAt,
    remainingDays: Math.max(
      0,
      Math.ceil((entitlementEndsAt.getTime() - now.getTime()) / DAY_MS),
    ),
  };
}
