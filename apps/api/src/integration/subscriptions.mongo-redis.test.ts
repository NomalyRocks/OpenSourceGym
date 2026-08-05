import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "legacy subscription repair preserves durations and does not rerun after the marker",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    // The shared Redis client in subscriptions is created at import time, so
    // set the test address before the dynamic import.
    process.env.REDIS_URL = redisUri!;
    const [
      { createSequentialSubscription, repairLegacySubscriptionOverlaps },
      { redis },
    ] = await Promise.all([
      import("../subscriptions.js"),
      import("../redis.js"),
    ]);

    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_subscriptions_${randomUUID().replaceAll("-", "")}`,
    );
    const subscriptions = database.collection("subscriptions");
    const userOne = new ObjectId();
    const userTwo = new ObjectId();
    const firstId = new ObjectId();
    const secondId = new ObjectId();
    const thirdId = new ObjectId();
    const otherUserId = new ObjectId();
    const secondDurationMs =
      new Date("2025-02-15T00:00:00.000Z").getTime() -
      new Date("2025-01-15T00:00:00.000Z").getTime();
    const thirdDurationMs =
      new Date("2025-04-20T00:00:00.000Z").getTime() -
      new Date("2025-01-20T00:00:00.000Z").getTime();

    try {
      await client.connect();
      await redis.connect();
      await subscriptions.insertMany([
        {
          _id: firstId,
          userId: userOne,
          startsAt: new Date("2025-01-01T00:00:00.000Z"),
          endsAt: new Date("2025-02-01T00:00:00.000Z"),
          note: null,
          createdBy: "staff-1",
          createdAt: new Date("2025-01-01T10:00:00.000Z"),
        },
        {
          _id: secondId,
          userId: userOne,
          startsAt: new Date("2025-01-15T00:00:00.000Z"),
          endsAt: new Date("2025-02-15T00:00:00.000Z"),
          note: null,
          createdBy: "staff-1",
          createdAt: new Date("2025-01-02T10:00:00.000Z"),
        },
        {
          _id: thirdId,
          userId: userOne,
          startsAt: new Date("2025-01-20T00:00:00.000Z"),
          endsAt: new Date("2025-04-20T00:00:00.000Z"),
          note: null,
          createdBy: "staff-1",
          createdAt: new Date("2025-01-03T10:00:00.000Z"),
        },
        {
          _id: otherUserId,
          userId: userTwo,
          startsAt: new Date("2025-01-15T00:00:00.000Z"),
          endsAt: new Date("2025-02-15T00:00:00.000Z"),
          note: null,
          createdBy: "staff-1",
          createdAt: new Date("2025-01-04T10:00:00.000Z"),
        },
      ]);

      const firstReport = await repairLegacySubscriptionOverlaps(database);
      assert.deepEqual(firstReport, {
        skipped: false,
        scannedCount: 4,
        repairedCount: 2,
        invalidCount: 0,
      });

      const repaired = await subscriptions
        .find({ userId: userOne })
        .sort({ createdAt: 1 })
        .toArray();
      assert.equal(repaired.length, 3);
      assert.equal(
        repaired[0]?.startsAt.toISOString(),
        "2025-01-01T00:00:00.000Z",
      );
      assert.equal(
        repaired[0]?.endsAt.toISOString(),
        "2025-02-01T00:00:00.000Z",
      );
      assert.equal(
        repaired[1]?.startsAt.getTime(),
        repaired[0]?.endsAt.getTime(),
      );
      assert.equal(
        repaired[1]!.endsAt.getTime() - repaired[1]!.startsAt.getTime(),
        secondDurationMs,
      );
      assert.equal(
        repaired[2]?.startsAt.getTime(),
        repaired[1]?.endsAt.getTime(),
      );
      assert.equal(
        repaired[2]!.endsAt.getTime() - repaired[2]!.startsAt.getTime(),
        thirdDurationMs,
      );

      const marker = await database.collection("migration_markers").findOne({});
      assert.ok(marker?.completedAt instanceof Date);
      assert.equal(
        await database.collection("migration_markers").countDocuments(),
        1,
      );

      const firstSnapshot = repaired.map((doc) => ({
        id: doc._id.toHexString(),
        startsAt: doc.startsAt.getTime(),
        endsAt: doc.endsAt.getTime(),
      }));
      const secondReport = await repairLegacySubscriptionOverlaps(database);
      assert.deepEqual(secondReport, {
        skipped: true,
        scannedCount: 4,
        repairedCount: 2,
        invalidCount: 0,
      });
      const secondSnapshot = (
        await subscriptions
          .find({ userId: userOne })
          .sort({ createdAt: 1 })
          .toArray()
      ).map((doc) => ({
        id: doc._id.toHexString(),
        startsAt: doc.startsAt.getTime(),
        endsAt: doc.endsAt.getTime(),
      }));
      assert.deepEqual(secondSnapshot, firstSnapshot);
      assert.equal(
        await database.collection("migration_markers").countDocuments(),
        1,
      );

      const sequentialUser = new ObjectId();
      await subscriptions.insertOne({
        userId: sequentialUser,
        startsAt: new Date("2098-01-31T10:00:00.000Z"),
        endsAt: new Date("2099-01-31T10:00:00.000Z"),
        note: null,
        createdBy: "staff-1",
        createdAt: new Date("2098-01-31T10:00:00.000Z"),
      });
      await Promise.all([
        createSequentialSubscription(
          {
            userId: sequentialUser,
            months: 1,
            note: null,
            createdBy: "staff-1",
          },
          database,
        ),
        createSequentialSubscription(
          {
            userId: sequentialUser,
            months: 1,
            note: null,
            createdBy: "staff-2",
          },
          database,
        ),
      ]);
      const sequential = await subscriptions
        .find({ userId: sequentialUser })
        .sort({ startsAt: 1 })
        .toArray();
      assert.equal(sequential.length, 3);
      assert.equal(
        sequential[1]?.startsAt.toISOString(),
        "2099-01-31T10:00:00.000Z",
      );
      assert.equal(
        sequential[1]?.endsAt.toISOString(),
        "2099-02-28T10:00:00.000Z",
      );
      assert.equal(
        sequential[2]?.startsAt.getTime(),
        sequential[1]?.endsAt.getTime(),
      );
      assert.equal(
        sequential[2]?.endsAt.toISOString(),
        "2099-03-28T10:00:00.000Z",
      );
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close();
      if (redis.isOpen) await redis.quit();
    }
  },
);
