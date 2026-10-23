import assert from "node:assert/strict";
import test from "node:test";
import { occupancyLevel } from "./occupancy";

test("unknown without a ratio", () => {
  assert.deepEqual(occupancyLevel(null), {
    percent: null,
    tone: "neutral",
    label: "Unknown",
  });
  assert.equal(occupancyLevel(undefined).label, "Unknown");
});

test("thresholds: quiet below 70, moderate 70-90, busy above 90", () => {
  assert.equal(occupancyLevel(0.69).label, "Quiet");
  assert.equal(occupancyLevel(0.7).label, "Moderate");
  assert.equal(occupancyLevel(0.9).label, "Moderate");
  assert.equal(occupancyLevel(0.91).label, "Busy");
});

test("percent is rounded and clamped", () => {
  assert.equal(occupancyLevel(1.4).percent, 100);
  assert.equal(occupancyLevel(-0.2).percent, 0);
  assert.equal(occupancyLevel(0.325).percent, 33);
});
