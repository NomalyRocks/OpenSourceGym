import assert from "node:assert/strict";
import { test } from "node:test";
import { reportDayRange } from "./reportDayRange";

test("cash exports use report time zone and include the complete day", () => {
  assert.deepEqual(reportDayRange("2026-11-08", "Europe/Istanbul"), {
    from: "2026-11-07T21:00:00.000Z",
    to: "2026-11-08T20:59:59.999Z",
  });
});
test("cash export ranges follow 23-hour and 25-hour DST days", () => {
  for (const [day, hours] of [
    ["2026-03-08", 23],
    ["2026-11-01", 25],
  ] as const) {
    const range = reportDayRange(day, "America/New_York");
    assert.equal(
      Date.parse(range.to) - Date.parse(range.from) + 1,
      hours * 3600000,
    );
  }
});
