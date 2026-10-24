import assert from "node:assert/strict";
import test from "node:test";
import { weekStart, weekStreak, weeklyVisits } from "./activity";

// 2026-10-21 is a Wednesday.
const wednesday = new Date(2026, 9, 21);

test("week starts on Monday, Sunday belongs to the previous Monday", () => {
  assert.equal(weekStart(wednesday).getDate(), 19);
  assert.equal(weekStart(new Date(2026, 9, 25)).getDate(), 19); // Sunday
  assert.equal(weekStart(new Date(2026, 9, 26)).getDate(), 26); // Monday
});

test("weeklyVisits buckets entries by week, oldest first", () => {
  const counts = weeklyVisits(
    [
      { date: "2026-10-19", entries: 1 }, // this week (Mon)
      { date: "2026-10-21", entries: 2 },
      { date: "2026-10-18", entries: 1 }, // previous week (Sun)
      { date: "2026-09-01", entries: 5 }, // outside the window
    ],
    wednesday,
    4,
  );
  assert.deepEqual(counts, [0, 0, 1, 3]);
});

test("streak counts consecutive non-empty weeks", () => {
  assert.equal(weekStreak([0, 2, 1, 3]), 3);
});

test("an empty current week does not break the streak yet", () => {
  assert.equal(weekStreak([1, 2, 1, 0]), 3);
});

test("an empty earlier week breaks the streak", () => {
  assert.equal(weekStreak([1, 0, 1, 1]), 2);
  assert.equal(weekStreak([0, 0, 0, 0]), 0);
  assert.equal(weekStreak([]), 0);
});
