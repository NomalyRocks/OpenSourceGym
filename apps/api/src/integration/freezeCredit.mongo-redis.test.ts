import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ObjectId } from "mongodb";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;
const DAY = 86_400_000;

test(
  "an interrupted freeze credit is settled before create/cancel plan, and never applied twice",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_freezecredit_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/13";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "freeze-credit-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { db, mongoClient },
      { connectRedis, redis },
      { createSequentialSubscription, cancelScheduledSubscription },
    ] = await Promise.all([
      import("../db.js"),
      import("../redis.js"),
      import("../subscriptions.js"),
    ]);

    try {
      await mongoClient.connect();
      await connectRedis();
      const subscriptions = db.collection("subscriptions");
      const freezes = db.collection("subscription_freezes");
      const now = Date.now();
      const at = (days: number) => new Date(now + days * DAY);
      const gymId = new ObjectId();
      const periodOf = (userId: ObjectId, from: number, to: number) => ({
        _id: new ObjectId(),
        userId,
        startsAt: at(from),
        endsAt: at(to),
        gymIds: [gymId],
        note: null,
        createdBy: "test",
        createdAt: new Date(),
      });
      /** A freeze that closed but whose period write never happened. */
      const interruptedFreeze = (
        userId: ObjectId,
        periodId: ObjectId,
        newEndDays: number,
        startsDays: number,
      ) =>
        freezes.insertOne({
          userId,
          startedAt: at(-10),
          startedBy: "staff",
          maxDays: 30,
          endedAt: at(0),
          endedBy: "staff",
          endReason: "resumed",
          creditedMs: 10 * DAY,
          plan: [
            {
              subscriptionId: periodId,
              startsAt: at(startsDays),
              endsAt: at(newEndDays),
            },
          ],
          creditApplied: false,
        });
      const days = (date: Date) => Math.round((date.getTime() - now) / DAY);

      // create: the new period must start behind the CREDITED end, not the stale one
      const createUser = new ObjectId();
      const running = periodOf(createUser, -28, 2);
      await subscriptions.insertOne(running);
      await interruptedFreeze(createUser, running._id, 12, -28);

      const created = await createSequentialSubscription({
        userId: createUser,
        months: 1,
        gymIds: [gymId],
        note: null,
        createdBy: "staff",
      });
      const shifted = await subscriptions.findOne({ _id: running._id });
      assert.equal(days(shifted!.endsAt), 12);
      assert.equal(days(created.startsAt), 12, "no overlap with the credit");
      assert.equal(
        (await freezes.findOne({ userId: createUser }))!.creditApplied,
        true,
      );

      // replay: marking it unapplied again must not credit the period twice
      await freezes.updateOne(
        { userId: createUser },
        { $set: { creditApplied: false } },
      );
      await createSequentialSubscription({
        userId: createUser,
        months: 1,
        gymIds: [gymId],
        note: null,
        createdBy: "staff",
      });
      assert.equal(
        days((await subscriptions.findOne({ _id: running._id }))!.endsAt),
        12,
        "a replayed plan is a no-op",
      );

      // cancel: the credit settles before the shift is planned
      const cancelUser = new ObjectId();
      const cancelRunning = periodOf(cancelUser, -28, 2);
      const scheduled = periodOf(cancelUser, 40, 70);
      await subscriptions.insertMany([cancelRunning, scheduled]);
      await interruptedFreeze(cancelUser, cancelRunning._id, 12, -28);

      const result = await cancelScheduledSubscription(
        scheduled._id,
        () => true,
      );
      assert.equal(result.status, "cancelled");
      assert.equal(
        days((await subscriptions.findOne({ _id: cancelRunning._id }))!.endsAt),
        12,
      );
      assert.equal(
        (await freezes.findOne({ userId: cancelUser }))!.creditApplied,
        true,
      );
    } finally {
      await db.dropDatabase().catch(() => undefined);
      if (redis.isOpen) {
        await redis.flushDb().catch(() => undefined);
        await redis.quit();
      }
      await mongoClient.close();
    }
  },
);
