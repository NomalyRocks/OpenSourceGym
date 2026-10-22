import assert from "node:assert/strict";
import test from "node:test";
import { insideCutoffs, selectPresence } from "./occupancy.js";

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** Hours between an entry at `NOW - hours` and the given cutoff. */
function hoursBefore(cutoff: number): number {
  return (NOW - cutoff) / HOUR;
}

test("entry record cutoffs", async (t) => {
  await t.test("counts within autoExitHours", () => {
    const { count } = insideCutoffs(4, NOW);
    assert.equal(hoursBefore(count), 4);
  });

  await t.test("falls back to the default when unset", () => {
    assert.equal(hoursBefore(insideCutoffs(undefined, NOW).count), 4);
  });

  await t.test("ignores a corrupt stored value", () => {
    assert.equal(hoursBefore(insideCutoffs(Number.NaN, NOW).count), 4);
  });

  await t.test("retains far longer than it counts", () => {
    const { count, drop } = insideCutoffs(4, NOW);
    assert.equal(hoursBefore(count), 4);
    assert.equal(hoursBefore(drop), 24);
  });

  // The settings schema accepts autoExitHours up to 48. A fixed 24-hour
  // retention would then reap records the occupancy window still counts —
  // dropping the member from the figure, silently disabling strict
  // anti-passback for them, and refusing the EXIT turnstile to someone who is
  // genuinely in the building.
  await t.test("never drops a record it still counts", () => {
    for (const hours of [1, 4, 23, 24, 25, 36, 48]) {
      const { count, drop } = insideCutoffs(hours, NOW);
      assert.ok(
        drop <= count,
        `retention must not precede the counting window at autoExitHours=${hours}`,
      );
    }
  });

  await t.test("stretches retention to match a long counting window", () => {
    assert.equal(hoursBefore(insideCutoffs(36, NOW).drop), 36);
    assert.equal(hoursBefore(insideCutoffs(48, NOW).drop), 48);
  });

  await t.test("keeps the 24-hour floor for short windows", () => {
    assert.equal(hoursBefore(insideCutoffs(24, NOW).drop), 24);
    assert.equal(hoursBefore(insideCutoffs(1, NOW).drop), 24);
  });
});

test("selectPresence", async (t) => {
  const cutoffs = new Map([
    ["a", NOW - 4 * HOUR],
    ["b", NOW - 4 * HOUR],
  ]);
  const all = () => true;

  await t.test("drops records past the gym's count cutoff", () => {
    assert.equal(
      selectPresence([{ gymId: "a", enteredAt: NOW - 5 * HOUR }], cutoffs, all),
      null,
    );
    assert.deepEqual(
      selectPresence([{ gymId: "a", enteredAt: NOW - 4 * HOUR }], cutoffs, all),
      { gymId: "a", enteredAt: NOW - 4 * HOUR },
    );
  });

  await t.test("takes the latest of several stale records", () => {
    const picked = selectPresence(
      [
        { gymId: "a", enteredAt: NOW - 3 * HOUR },
        { gymId: "b", enteredAt: NOW - 1 * HOUR },
      ],
      cutoffs,
      all,
    );
    assert.equal(picked?.gymId, "b");
  });

  await t.test("hides a latest record outside the caller's scope", () => {
    const records = [
      { gymId: "a", enteredAt: NOW - 3 * HOUR },
      { gymId: "b", enteredAt: NOW - 1 * HOUR },
    ];
    assert.equal(
      selectPresence(records, cutoffs, (g) => g === "a"),
      null,
    );
    assert.equal(
      selectPresence(records, cutoffs, (g) => g === "b")?.gymId,
      "b",
    );
  });

  await t.test("ignores unknown gyms and non-finite entries", () => {
    assert.equal(
      selectPresence(
        [
          { gymId: "zzz", enteredAt: NOW },
          { gymId: "a", enteredAt: Number.NaN },
        ],
        cutoffs,
        all,
      ),
      null,
    );
  });
});
