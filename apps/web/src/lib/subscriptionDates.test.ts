import assert from "node:assert/strict";
import { test } from "node:test";
import { addUtcMonthsClamped } from "./subscriptionDates";

test("clamps month-end dates and preserves UTC time across years", () => {
  assert.equal(
    addUtcMonthsClamped(new Date("2024-01-31T12:30:00Z"), 1).toISOString(),
    "2024-02-29T12:30:00.000Z",
  );
  assert.equal(
    addUtcMonthsClamped(new Date("2025-12-31T12:30:00Z"), 2).toISOString(),
    "2026-02-28T12:30:00.000Z",
  );
  assert.equal(
    addUtcMonthsClamped(new Date("2025-01-31T12:30:00Z"), 24).toISOString(),
    "2027-01-31T12:30:00.000Z",
  );
});
