import assert from "node:assert/strict";
import test from "node:test";
import { formatInsideDuration, msToNextMinute } from "./presence";

const min = 60_000;

test("under an hour shows whole minutes", () => {
  assert.equal(formatInsideDuration(0), "0 min");
  assert.equal(formatInsideDuration(59_000), "0 min");
  assert.equal(formatInsideDuration(59 * min), "59 min");
});

test("an hour or more shows H:MM", () => {
  assert.equal(formatInsideDuration(60 * min), "1:00");
  assert.equal(formatInsideDuration(119 * min), "1:59");
  assert.equal(formatInsideDuration(125 * min), "2:05");
});

test("negative clock skew reads as zero", () => {
  assert.equal(formatInsideDuration(-5 * min), "0 min");
});

test("minute label is injectable", () => {
  assert.equal(
    formatInsideDuration(3 * min, (n) => `${n} dk`),
    "3 dk",
  );
});

test("next minute boundary", () => {
  assert.equal(msToNextMinute(0, 10_000), 50_000);
  assert.equal(msToNextMinute(0, 60_000), 60_000);
  assert.equal(msToNextMinute(1_000, 0), 60_000);
});
