import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWeightForDay, type WeightEntry } from "./weightResolve";

describe("resolveWeightForDay", () => {
  const entries: WeightEntry[] = [
    { weightKg: 80, at: "2026-07-29T08:00:00.000Z" },
    { weightKg: 78, at: "2026-08-01T08:00:00.000Z" },
  ];

  it("carries the latest prior entry into a day without an entry", () => {
    // July 29 has an entry and July 30 does not—the July 29 value applies on July 30.
    assert.equal(resolveWeightForDay(entries, "2026-07-30"), 80);
  });

  it("returns the entry's own value on its exact day", () => {
    assert.equal(resolveWeightForDay(entries, "2026-07-29"), 80);
    assert.equal(resolveWeightForDay(entries, "2026-08-01"), 78);
  });

  it("does not carry a later entry backward", () => {
    // July 29 still applies on July 31, not the August 1 value.
    assert.equal(resolveWeightForDay(entries, "2026-07-31"), 80);
  });

  it("has no data for a day before the first entry", () => {
    assert.equal(resolveWeightForDay(entries, "2026-07-01"), null);
  });

  it("always returns null for empty history", () => {
    assert.equal(resolveWeightForDay([], "2026-08-02"), null);
  });
});
