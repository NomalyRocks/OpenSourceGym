import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addUtcCalendarMonthsClamped,
  calculateSubscriptionPeriod,
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
