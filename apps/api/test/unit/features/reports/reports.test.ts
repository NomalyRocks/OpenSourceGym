import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dayLabels,
  isDayLabel,
  localDayLabel,
  localDayRange,
} from "../../../../src/features/reports/reports.js";

describe("localDayLabel function", () => {
  it("returns the next local day for an instant at the Istanbul offset", () => {
    const result = localDayLabel(
      new Date("2026-03-01T21:30:00.000Z"),
      "Europe/Istanbul",
    );
    assert.strictEqual(result, "2026-03-02");
  });

  it("returns the correct local day for the same instant in UTC", () => {
    const result = localDayLabel(new Date("2026-03-01T21:30:00.000Z"), "UTC");
    assert.strictEqual(result, "2026-03-01");
  });
});

describe("dayLabels function", () => {
  it("returns exactly one label for a range within one local day", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-01T10:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], "2026-03-01");
  });

  it("returns the correct labels for a three-day range", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-03T23:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.deepStrictEqual(result, ["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("crosses a month boundary correctly", () => {
    const from = new Date("2026-01-30T00:00:00.000Z");
    const to = new Date("2026-02-02T00:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.deepStrictEqual(result, [
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("caps the result to guarantee termination", () => {
    const from = new Date("2025-01-01T00:00:00.000Z");
    const to = new Date("2026-02-05T00:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.strictEqual(result.length <= 367, true);
    assert.strictEqual(result[0], "2025-01-01");
  });
});

describe("localDayRange function", () => {
  const hours = (range: { from: Date; to: Date }) =>
    (range.to.getTime() - range.from.getTime()) / 3_600_000;

  it("cuts an ordinary day at local midnight (Istanbul, UTC+3)", () => {
    const range = localDayRange("2026-03-02", "Europe/Istanbul");
    assert.equal(range.from.toISOString(), "2026-03-01T21:00:00.000Z");
    assert.equal(range.to.toISOString(), "2026-03-02T21:00:00.000Z");
  });

  it("is 24 hours in UTC", () => {
    const range = localDayRange("2026-06-15", "UTC");
    assert.equal(range.from.toISOString(), "2026-06-15T00:00:00.000Z");
    assert.equal(hours(range), 24);
  });

  it("is 23 hours on the Berlin spring-forward day", () => {
    const range = localDayRange("2026-03-29", "Europe/Berlin");
    assert.equal(range.from.toISOString(), "2026-03-28T23:00:00.000Z");
    assert.equal(range.to.toISOString(), "2026-03-29T22:00:00.000Z");
    assert.equal(hours(range), 23);
  });

  it("is 25 hours on the Berlin fall-back day", () => {
    const range = localDayRange("2026-10-25", "Europe/Berlin");
    assert.equal(range.from.toISOString(), "2026-10-24T22:00:00.000Z");
    assert.equal(range.to.toISOString(), "2026-10-25T23:00:00.000Z");
    assert.equal(hours(range), 25);
  });

  it("keeps the days around a change adjacent and gap-free", () => {
    const before = localDayRange("2026-03-28", "Europe/Berlin");
    const during = localDayRange("2026-03-29", "Europe/Berlin");
    const after = localDayRange("2026-03-30", "Europe/Berlin");
    assert.equal(before.to.getTime(), during.from.getTime());
    assert.equal(during.to.getTime(), after.from.getTime());
  });

  it("puts a late-evening instant in the right local day", () => {
    const range = localDayRange("2026-03-02", "Europe/Istanbul");
    const at = new Date("2026-03-02T20:59:59.000Z");
    assert.ok(at >= range.from && at < range.to);
    assert.equal(localDayLabel(at, "Europe/Istanbul"), "2026-03-02");
    assert.ok(new Date("2026-03-02T21:00:00.000Z") >= range.to);
  });
});

describe("isDayLabel function", () => {
  it("accepts real calendar days only", () => {
    assert.equal(isDayLabel("2026-02-28"), true);
    assert.equal(isDayLabel("2024-02-29"), true);
    assert.equal(isDayLabel("2026-02-29"), false);
    assert.equal(isDayLabel("2026-13-01"), false);
    assert.equal(isDayLabel("26-01-01"), false);
    assert.equal(isDayLabel("2026-1-1"), false);
  });
});
