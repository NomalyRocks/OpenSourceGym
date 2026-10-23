import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBusyHours,
  sameWeekdayLabels,
  zonedDayHour,
} from "./busyHours.js";

const TZ = "Europe/Istanbul"; // UTC+3, no DST
// Friday 2026-01-30 12:00 local
const now = new Date("2026-01-30T09:00:00Z");
const old = new Date("2020-01-01T00:00:00Z");

describe("busy hours", () => {
  it("picks the four previous same weekdays and excludes today", () => {
    assert.deepEqual(sameWeekdayLabels("2026-01-30"), [
      "2026-01-23",
      "2026-01-16",
      "2026-01-09",
      "2026-01-02",
    ]);
  });

  it("buckets hours in the zone, across midnight", () => {
    // 21:30Z is 00:30 next local day
    assert.deepEqual(zonedDayHour(new Date("2026-01-22T21:30:00Z"), TZ), {
      day: "2026-01-23",
      hour: 0,
    });
  });

  it("is DST safe: America/New_York hours follow local wall clock", () => {
    const ny = "America/New_York";
    assert.equal(zonedDayHour(new Date("2026-03-07T17:00:00Z"), ny).hour, 12);
    assert.equal(zonedDayHour(new Date("2026-03-09T16:00:00Z"), ny).hour, 12);
  });

  it("averages to one decimal and always returns 24 rows", () => {
    const entries = [
      new Date("2026-01-23T07:05:00Z"), // 10:05 local
      new Date("2026-01-16T07:10:00Z"),
      new Date("2026-01-09T07:20:00Z"),
      new Date("2026-01-30T07:00:00Z"), // today, ignored
      new Date("2026-01-24T07:00:00Z"), // other weekday, ignored
    ];
    const result = buildBusyHours({
      gymId: "g",
      timeZone: TZ,
      now,
      gymCreatedAt: old,
      entryTimes: entries,
    });
    assert.equal(result.hours.length, 24);
    assert.equal(result.sampleDays, 4);
    assert.equal(result.weekday, 5);
    assert.equal(result.hours[10]?.avgEntries, 0.8);
    assert.equal(result.hours[11]?.avgEntries, 0);
  });

  it("counts fewer sample days for a new gym", () => {
    const result = buildBusyHours({
      gymId: "g",
      timeZone: TZ,
      now,
      gymCreatedAt: new Date("2026-01-12T00:00:00Z"),
      entryTimes: [new Date("2026-01-23T07:00:00Z")],
    });
    assert.equal(result.sampleDays, 2);
    assert.equal(result.hours[10]?.avgEntries, 0.5);
  });

  it("returns zeros and sampleDays 0 with no history", () => {
    const result = buildBusyHours({
      gymId: "g",
      timeZone: TZ,
      now,
      gymCreatedAt: now,
      entryTimes: [],
    });
    assert.equal(result.sampleDays, 0);
    assert.ok(result.hours.every((h) => h.avgEntries === 0));
  });
});
