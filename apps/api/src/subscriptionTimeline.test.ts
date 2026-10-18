import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addUtcCalendarMonthsClamped,
  calculateFreezeCreditMs,
  evaluateEntryAccess,
  evaluateEntryWithFreezeCredit,
  calculateSubscriptionPeriod,
  planFreezeCredit,
  planSubscriptionCancellation,
  planLegacySubscriptionRepairs,
  summarizeSubscriptionTimeline,
  type SubscriptionTimelineRecord,
} from "./subscriptionTimeline.js";

function timelineRecord(
  id: string,
  userId: string,
  startsAt: string,
  endsAt: string,
  createdAt: string,
): SubscriptionTimelineRecord {
  return {
    id,
    userId,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    createdAt: new Date(createdAt),
  };
}

describe("UTC subscription month calculation", () => {
  it("clamps an end-of-month day to the target month's last day", () => {
    assert.equal(
      addUtcCalendarMonthsClamped(
        new Date("2024-01-31T18:25:43.210Z"),
        1,
      ).toISOString(),
      "2024-02-29T18:25:43.210Z",
    );
    assert.equal(
      addUtcCalendarMonthsClamped(
        new Date("2025-01-31T18:25:43.210Z"),
        1,
      ).toISOString(),
      "2025-02-28T18:25:43.210Z",
    );
  });

  it("crosses a year boundary while preserving the UTC time", () => {
    assert.equal(
      addUtcCalendarMonthsClamped(
        new Date("2025-08-31T23:59:59.999Z"),
        6,
      ).toISOString(),
      "2026-02-28T23:59:59.999Z",
    );
  });

  it("starts after the last expiry for active subscriptions and now for expired ones", () => {
    const now = new Date("2025-01-15T10:00:00.000Z");
    const active = calculateSubscriptionPeriod(
      now,
      new Date("2026-01-31T10:00:00.000Z"),
      1,
    );
    assert.equal(active.startsAt.toISOString(), "2026-01-31T10:00:00.000Z");
    assert.equal(active.endsAt.toISOString(), "2026-02-28T10:00:00.000Z");

    const expired = calculateSubscriptionPeriod(
      now,
      new Date("2024-12-31T10:00:00.000Z"),
      3,
    );
    assert.equal(expired.startsAt.toISOString(), now.toISOString());
    assert.equal(expired.endsAt.toISOString(), "2025-04-15T10:00:00.000Z");
  });
});

describe("legacy subscription timeline repair", () => {
  it("keeps the first record by createdAt and preserves subsequent durations", () => {
    const first = timelineRecord(
      "a",
      "user-1",
      "2025-01-01T00:00:00.000Z",
      "2025-02-01T00:00:00.000Z",
      "2025-01-01T10:00:00.000Z",
    );
    const second = timelineRecord(
      "b",
      "user-1",
      "2025-01-15T00:00:00.000Z",
      "2025-02-15T00:00:00.000Z",
      "2025-01-02T10:00:00.000Z",
    );
    const third = timelineRecord(
      "c",
      "user-1",
      "2025-01-20T00:00:00.000Z",
      "2025-04-20T00:00:00.000Z",
      "2025-01-03T10:00:00.000Z",
    );

    // Input is deliberately reversed: createdAt, not array order, decides.
    const repairs = planLegacySubscriptionRepairs([third, second, first]);
    assert.deepEqual(
      repairs.map((repair) => repair.id),
      ["b", "c"],
    );
    assert.equal(repairs[0]?.startsAt.getTime(), first.endsAt.getTime());
    assert.equal(
      repairs[0]!.endsAt.getTime() - repairs[0]!.startsAt.getTime(),
      second.endsAt.getTime() - second.startsAt.getTime(),
    );
    assert.equal(repairs[1]?.startsAt.getTime(), repairs[0]?.endsAt.getTime());
    assert.equal(
      repairs[1]!.endsAt.getTime() - repairs[1]!.startsAt.getTime(),
      third.endsAt.getTime() - third.startsAt.getTime(),
    );
  });

  it("produces no changes on a second run over repaired records", () => {
    const records = [
      timelineRecord(
        "a",
        "user-1",
        "2025-01-01T00:00:00.000Z",
        "2025-02-01T00:00:00.000Z",
        "2025-01-01T10:00:00.000Z",
      ),
      timelineRecord(
        "b",
        "user-1",
        "2025-01-15T00:00:00.000Z",
        "2025-02-15T00:00:00.000Z",
        "2025-01-02T10:00:00.000Z",
      ),
    ];
    const firstPass = planLegacySubscriptionRepairs(records);
    const byId = new Map(firstPass.map((repair) => [repair.id, repair]));
    const repairedRecords = records.map((record) => ({
      ...record,
      startsAt: byId.get(record.id)?.startsAt ?? record.startsAt,
      endsAt: byId.get(record.id)?.endsAt ?? record.endsAt,
    }));

    assert.deepEqual(planLegacySubscriptionRepairs(repairedRecords), []);
  });

  it("does not mix timelines belonging to different users", () => {
    const records = [
      timelineRecord(
        "a",
        "user-1",
        "2025-01-01T00:00:00.000Z",
        "2025-12-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
      ),
      timelineRecord(
        "b",
        "user-2",
        "2025-02-01T00:00:00.000Z",
        "2025-03-01T00:00:00.000Z",
        "2025-01-02T00:00:00.000Z",
      ),
    ];
    assert.deepEqual(planLegacySubscriptionRepairs(records), []);
  });
});

describe("mobile subscription summary", () => {
  it("extends from the active range through adjacent future packages", () => {
    const summary = summarizeSubscriptionTimeline(
      [
        {
          startsAt: new Date("2025-01-01T00:00:00.000Z"),
          endsAt: new Date("2025-02-01T00:00:00.000Z"),
        },
        {
          startsAt: new Date("2025-02-01T00:00:00.000Z"),
          endsAt: new Date("2025-03-01T00:00:00.000Z"),
        },
        {
          startsAt: new Date("2025-03-01T00:00:00.000Z"),
          endsAt: new Date("2025-04-01T00:00:00.000Z"),
        },
        {
          startsAt: new Date("2025-04-02T00:00:00.000Z"),
          endsAt: new Date("2025-05-02T00:00:00.000Z"),
        },
      ],
      new Date("2025-01-15T00:00:00.000Z"),
    );

    assert.equal(summary.active, true);
    assert.equal(summary.startsAt?.toISOString(), "2025-01-01T00:00:00.000Z");
    assert.equal(summary.endsAt?.toISOString(), "2025-04-01T00:00:00.000Z");
    assert.equal(summary.remainingDays, 76);
  });

  it("does not report active when only a future package exists", () => {
    assert.deepEqual(
      summarizeSubscriptionTimeline(
        [
          {
            startsAt: new Date("2025-02-01T00:00:00.000Z"),
            endsAt: new Date("2025-03-01T00:00:00.000Z"),
          },
        ],
        new Date("2025-01-15T00:00:00.000Z"),
      ),
      { active: false, startsAt: null, endsAt: null, remainingDays: 0 },
    );
  });
});

describe("subscription cancellation planning", () => {
  const period = (startsAt: string, endsAt: string) => ({
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
  });

  it("pulls later periods forward by the cancelled duration", () => {
    const cancelled = period(
      "2025-02-01T00:00:00.000Z",
      "2025-03-01T00:00:00.000Z",
    );
    const plan = planSubscriptionCancellation(cancelled, [
      {
        id: "c",
        ...period("2025-04-01T00:00:00.000Z", "2025-07-01T00:00:00.000Z"),
      },
      {
        id: "a",
        ...period("2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z"),
      },
      {
        id: "b",
        ...period("2025-03-01T00:00:00.000Z", "2025-04-01T00:00:00.000Z"),
      },
    ]);

    assert.deepEqual(
      plan.map((p) => [p.id, p.startsAt.toISOString(), p.endsAt.toISOString()]),
      [
        ["b", "2025-02-01T00:00:00.000Z", "2025-03-04T00:00:00.000Z"],
        ["c", "2025-03-04T00:00:00.000Z", "2025-06-03T00:00:00.000Z"],
      ],
    );
  });

  it("shifts nothing when the cancelled period is the last one", () => {
    const cancelled = period(
      "2025-03-01T00:00:00.000Z",
      "2025-04-01T00:00:00.000Z",
    );
    const plan = planSubscriptionCancellation(cancelled, [
      {
        id: "a",
        ...period("2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z"),
      },
      {
        id: "b",
        ...period("2025-02-01T00:00:00.000Z", "2025-03-01T00:00:00.000Z"),
      },
    ]);

    assert.deepEqual(plan, []);
  });

  it("shifts nothing when the cancelled period is the only one", () => {
    const cancelled = period(
      "2025-03-01T00:00:00.000Z",
      "2025-04-01T00:00:00.000Z",
    );
    assert.deepEqual(planSubscriptionCancellation(cancelled, []), []);
  });

  it("rejects an empty cancelled period", () => {
    const at = "2025-03-01T00:00:00.000Z";
    assert.throws(
      () => planSubscriptionCancellation(period(at, at), []),
      RangeError,
    );
  });
});

describe("freeze credit", () => {
  const DAY = 86_400_000;
  const at = (iso: string) => new Date(iso);
  const period = (id: string, startsAt: string, endsAt: string) => ({
    id,
    startsAt: at(startsAt),
    endsAt: at(endsAt),
  });

  it("credits the frozen time", () => {
    assert.equal(
      calculateFreezeCreditMs(
        at("2025-02-01T00:00:00.000Z"),
        at("2025-02-11T00:00:00.000Z"),
        30,
      ),
      10 * DAY,
    );
  });

  it("caps the credit at maxDays", () => {
    assert.equal(
      calculateFreezeCreditMs(
        at("2025-02-01T00:00:00.000Z"),
        at("2025-04-01T00:00:00.000Z"),
        30,
      ),
      30 * DAY,
    );
  });

  it("never credits a negative duration", () => {
    assert.equal(
      calculateFreezeCreditMs(
        at("2025-02-11T00:00:00.000Z"),
        at("2025-02-01T00:00:00.000Z"),
        30,
      ),
      0,
    );
  });

  it("extends only the end of the running period and slides later ones", () => {
    const plan = planFreezeCredit(
      [
        period("later", "2025-03-01T00:00:00.000Z", "2025-04-01T00:00:00.000Z"),
        period("past", "2024-12-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"),
        period(
          "running",
          "2025-01-01T00:00:00.000Z",
          "2025-03-01T00:00:00.000Z",
        ),
      ],
      at("2025-02-01T00:00:00.000Z"),
      10 * DAY,
    );

    assert.deepEqual(
      plan.map((p) => [p.id, p.startsAt.toISOString(), p.endsAt.toISOString()]),
      [
        ["running", "2025-01-01T00:00:00.000Z", "2025-03-11T00:00:00.000Z"],
        ["later", "2025-03-11T00:00:00.000Z", "2025-04-11T00:00:00.000Z"],
      ],
    );
  });

  it("extends just the running period when no period follows", () => {
    const plan = planFreezeCredit(
      [
        period(
          "running",
          "2025-01-01T00:00:00.000Z",
          "2025-03-01T00:00:00.000Z",
        ),
      ],
      at("2025-02-01T00:00:00.000Z"),
      30 * DAY,
    );

    assert.equal(plan.length, 1);
    assert.equal(plan[0]?.startsAt.toISOString(), "2025-01-01T00:00:00.000Z");
    assert.equal(plan[0]?.endsAt.toISOString(), "2025-03-31T00:00:00.000Z");
  });

  it("plans nothing for a zero credit", () => {
    assert.deepEqual(
      planFreezeCredit(
        [period("a", "2025-01-01T00:00:00.000Z", "2025-03-01T00:00:00.000Z")],
        at("2025-02-01T00:00:00.000Z"),
        0,
      ),
      [],
    );
  });
});

describe("freeze credit repacking", () => {
  const DAY = 86_400_000;
  const t = (days: number) => new Date(Date.UTC(2025, 0, 1) + days * DAY);
  const period = (id: string, from: number, to: number) => ({
    id,
    startsAt: t(from),
    endsAt: t(to),
  });
  const days = (plan: { startsAt: Date; endsAt: Date }[]) =>
    plan.map((p) => [
      (p.startsAt.getTime() - t(0).getTime()) / DAY,
      (p.endsAt.getTime() - t(0).getTime()) / DAY,
    ]);

  it("does not leave a gap when a period was added during the freeze", () => {
    // A runs to day 2, frozen from day 0, renewal N bought at day 10 starts
    // right after A's old end (day 10). Unfreezing at day 10 credits 10 days.
    const plan = planFreezeCredit(
      [period("A", -28, 2), period("N", 10, 40)],
      t(0),
      10 * DAY,
    );

    assert.deepEqual(days(plan), [
      [-28, 12],
      [12, 42],
    ]);
  });

  it("keeps a later period that already starts after the extended end", () => {
    const plan = planFreezeCredit(
      [period("A", -28, 2), period("B", 30, 60)],
      t(0),
      10 * DAY,
    );

    assert.deepEqual(days(plan), [
      [-28, 12],
      [30, 60],
    ]);
  });

  it("pushes a chain of back-to-back periods by the credit", () => {
    const plan = planFreezeCredit(
      [period("A", -28, 2), period("B", 2, 32), period("C", 32, 62)],
      t(0),
      10 * DAY,
    );

    assert.deepEqual(days(plan), [
      [-28, 12],
      [12, 42],
      [42, 72],
    ]);
  });

  it("decides entry from the credited timeline without applying it", () => {
    // The only period ended 8 days ago; a 10-day freeze started 20 days ago.
    const periods = [{ ...period("A", -50, -8), gymIds: ["gym-1"] }];
    const freeze = { startedAt: t(-20), maxDays: 30 };

    assert.equal(
      evaluateEntryWithFreezeCredit(periods, freeze, t(0), "gym-1"),
      "ok",
    );
    assert.equal(
      evaluateEntryWithFreezeCredit(periods, freeze, t(0), "gym-2"),
      "other-gym",
    );
    // Uncredited, the period is simply over.
    assert.equal(evaluateEntryAccess(periods, t(0), "gym-1"), "none");
  });

  it("refuses when even the capped credit does not reach today", () => {
    const periods = [{ ...period("A", -200, -150), gymIds: ["gym-1"] }];

    assert.equal(
      evaluateEntryWithFreezeCredit(
        periods,
        { startedAt: t(-160), maxDays: 10 },
        t(0),
        "gym-1",
      ),
      "none",
    );
  });
});
