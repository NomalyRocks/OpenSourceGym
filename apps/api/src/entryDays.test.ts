import assert from "node:assert/strict";
import { test } from "node:test";
import { dayLabelSpan, entryQueryWindow, toEntryDays } from "./entryDays.js";

test("dayLabelSpan returns the difference in days", () => {
  assert.equal(dayLabelSpan("2026-08-01", "2026-08-31"), 30);
  assert.equal(dayLabelSpan("2026-08-01", "2026-08-01"), 0);
  assert.equal(dayLabelSpan("2026-08-31", "2026-08-01"), -30);
});

test("dayLabelSpan does not skip daylight-saving transitions", () => {
  // Europe moves its clocks forward on 2026-03-29; because label arithmetic
  // uses UTC, the 31-day month of March must have a 30-day difference.
  assert.equal(dayLabelSpan("2026-03-01", "2026-03-31"), 30);
});

test("entryQueryWindow expands the range by the time-zone offset", () => {
  const { start, end } = entryQueryWindow("2026-08-01", "2026-08-31");
  // Local August 1 in UTC+14 begins at 10:00 on July 31 in UTC.
  assert.equal(start.toISOString(), "2026-07-31T10:00:00.000Z");
  // Local August 31 in UTC-12 ends at 14:00 on September 1 in UTC.
  assert.equal(end.toISOString(), "2026-09-01T14:00:00.000Z");
});

test("toEntryDays filters out days outside the window and sorts the rest", () => {
  const days = toEntryDays(
    [
      { _id: "2026-08-15", entries: 2 },
      { _id: "2026-09-01", entries: 1 },
      { _id: "2026-07-31", entries: 3 },
      { _id: "2026-08-02", entries: 1 },
    ],
    "2026-08-01",
    "2026-08-31",
  );
  assert.deepEqual(days, [
    { date: "2026-08-02", entries: 1 },
    { date: "2026-08-15", entries: 2 },
  ]);
});

test("toEntryDays omits empty days from the response", () => {
  assert.deepEqual(
    toEntryDays(
      [{ _id: "2026-08-10", entries: 0 }],
      "2026-08-01",
      "2026-08-31",
    ),
    [],
  );
});
