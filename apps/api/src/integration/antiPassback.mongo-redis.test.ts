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

  const [
    {
      isInside,
      hasInsideRecord,
      markInside,
      markOutside,
      getOccupancy,
      reapExpiredInsideRecords,
      startOccupancyReaper,
    },
    { redis },
    { db, mongoClient },
  ] = await Promise.all([
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
    assert.equal(
      await isInside(userId),
      true,
      "a fresh entry counts as inside",
    );

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

    // An autoExitHours longer than the 24-hour retention floor must stretch the
    // retention with it. Otherwise the reap deletes a record the occupancy
    // window still counts, and the member — genuinely inside — is refused at the
    // EXIT turnstile.
    await db
      .collection("settings")
      .updateOne(
        { _id: "gym" as unknown as never },
        { $set: { autoExitHours: 36 } },
        { upsert: true },
      );
    await redis.hSet(
      INSIDE_KEY,
      staleUserId,
      String(Date.now() - 30 * 60 * 60 * 1000),
    );
    assert.equal(
      await isInside(staleUserId),
      true,
      "30 hours in is still counted when autoExitHours is 36",
    );
    assert.equal(
      await hasInsideRecord(staleUserId),
      true,
      "a counted record must never be past its retention window",
    );
    assert.equal(
      await reapExpiredInsideRecords(),
      0,
      "the reap must not delete a record the occupancy window still counts",
    );

    // Past that stretched window it goes.
    await redis.hSet(
      INSIDE_KEY,
      staleUserId,
      String(Date.now() - 37 * 60 * 60 * 1000),
    );
    assert.equal(await reapExpiredInsideRecords(), 1);
    assert.equal(await redis.hGet(INSIDE_KEY, staleUserId), null);

    // The scheduler wrapper is the same sweep; it must also survive being
    // stopped without a tick having fired.
    await redis.hSet(
      INSIDE_KEY,
      staleUserId,
      String(Date.now() - 40 * 60 * 60 * 1000),
    );
    const reaper = startOccupancyReaper();
    assert.equal(await reaper.runOnce(), 1);
    await reaper.stop();
    assert.equal(await redis.hGet(INSIDE_KEY, staleUserId), null);
  } finally {
    // Leave autoExitHours as the earlier assertions expect it, so a repeat run
    // on the same database starts from the same configuration.
    await db
      .collection("settings")
      .updateOne(
        { _id: "gym" as unknown as never },
        { $set: { autoExitHours: 4 } },
      )
      .catch(() => {});
    await redis.hDel(INSIDE_KEY, [userId, staleUserId]).catch(() => {});
    await redis.quit().catch(() => {});
    await mongoClient.close().catch(() => {});
  }
});
