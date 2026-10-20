import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { excludeFrozenStages, frozenMemberGymIds } from "./frozenMembers.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const A = new ObjectId();
const B = new ObjectId();

test("frozen member gyms", async (t) => {
  await t.test("use the active periods when one is still running", () => {
    assert.deepEqual(
      frozenMemberGymIds(
        [
          { endsAt: new Date(NOW.getTime() - 20 * DAY), gymIds: [B] },
          { endsAt: new Date(NOW.getTime() + 5 * DAY), gymIds: [A] },
        ],
        NOW,
      ),
      [A.toHexString()],
    );
  });

  await t.test("fall back to the latest period when the end passed", () => {
    assert.deepEqual(
      frozenMemberGymIds(
        [
          { endsAt: new Date(NOW.getTime() - 20 * DAY), gymIds: [B] },
          { endsAt: new Date(NOW.getTime() - 2 * DAY), gymIds: [A] },
        ],
        NOW,
      ),
      [A.toHexString()],
    );
  });

  await t.test("are empty without any started period", () => {
    assert.deepEqual(frozenMemberGymIds([], NOW), []);
  });
});

test("excludeFrozenStages is a no-op without frozen members", () => {
  assert.deepEqual(excludeFrozenStages([]), []);
  assert.deepEqual(excludeFrozenStages([A]), [
    { $match: { userId: { $nin: [A] } } },
  ]);
});
