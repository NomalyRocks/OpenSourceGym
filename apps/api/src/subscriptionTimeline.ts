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
