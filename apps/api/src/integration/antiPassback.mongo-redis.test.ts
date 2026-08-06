import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

const skip =
  mongoUri && redisUri
    ? false
    : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined";

/**
 * Anti-passback depends on `isInside` expiring the same way occupancy does. If
 * it did not, a member who left a gym with no exit turnstile would stay
 * "inside" forever and be locked out of their own gym.
 */
test("isInside honours the autoExitHours expiry", { skip }, async () => {
  // The shared clients are created at import time, so the addresses must be set
  // before the dynamic import.
  process.env.MONGODB_URI = mongoUri!;
  process.env.REDIS_URL = redisUri!;

  const [{ isInside, hasInsideRecord, markInside, markOutside, getOccupancy }, { redis }, { db, mongoClient }] =
    await Promise.all([
      import("../occupancy.js"),
      import("../redis.js"),
      import("../db.js"),
    ]);

  const userId = `test-${randomUUID()}`;
  const staleUserId = `test-${randomUUID()}`;
  const INSIDE_KEY = "og:inside";

  try {
    await redis.connect();
    await mongoClient.connect();
    await db
      .collection("settings")
      .updateOne(
        { _id: "gym" as unknown as never },
        { $set: { autoExitHours: 4 } },
        { upsert: true },
      );

    assert.equal(await isInside(userId), false, "unknown member is not inside");

    await markInside(userId);
    assert.equal(await isInside(userId), true, "a fresh entry counts as inside");

    await markOutside(userId);
    assert.equal(
      await isInside(userId),
      false,
      "an exit scan clears the inside flag",
    );

    // Five hours ago, past the four-hour autoExitHours window.
    await redis.hSet(
      INSIDE_KEY,
      staleUserId,
      String(Date.now() - 5 * 60 * 60 * 1000),
    );
    assert.equal(
      await isInside(staleUserId),
      false,
      "an entry older than autoExitHours must not lock the member out",
    );

    // ...but the record itself must survive: that member may still be in the
    // building and has to be able to scan their way OUT.
    assert.equal(
      await hasInsideRecord(staleUserId),
      true,
      "a lapsed occupancy window must not revoke the right to exit",
    );
    await getOccupancy();
    assert.equal(
      await hasInsideRecord(staleUserId),
      true,
      "getOccupancy must not reap a record that is merely uncounted",
    );

    // Past the 24-hour retention the record is genuinely gone.
    await redis.hSet(
      INSIDE_KEY,
      staleUserId,
      String(Date.now() - 25 * 60 * 60 * 1000),
    );
    assert.equal(await hasInsideRecord(staleUserId), false);
    await getOccupancy();
    assert.equal(
      await redis.hGet(INSIDE_KEY, staleUserId),
      null,
      "getOccupancy reaps a record past the retention window",
    );

    // Someone who never entered has no claim on the exit turnstile.
    assert.equal(await hasInsideRecord(`test-${randomUUID()}`), false);

    // A non-numeric value must read as "outside" rather than throwing.
    await redis.hSet(INSIDE_KEY, staleUserId, "not-a-number");
    assert.equal(await isInside(staleUserId), false);
    assert.equal(await hasInsideRecord(staleUserId), false);
  } finally {
    await redis.hDel(INSIDE_KEY, [userId, staleUserId]).catch(() => {});
    await redis.quit().catch(() => {});
    await mongoClient.close().catch(() => {});
  }
});
