import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ObjectId } from "mongodb";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;
const DAY = 86_400_000;

test(
  "an interrupted freeze credit is settled before create/cancel plan and gate entry, and never applied twice",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_freezecredit_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/8";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "freeze-credit-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { db, mongoClient },
      { connectRedis, redis },
      {
        createSequentialSubscription,
        cancelScheduledSubscription,
        checkEntrySubscription,
        getSubscriptionSummary,
      },
      { settlePendingCredit, reapExpiredFreezes },
    ] = await Promise.all([
      import("../db.js"),
      import("../redis.js"),
      import("../subscriptions.js"),
      import("../freeze.js"),
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

      // gate: the nominal end passed during the freeze, so only the settled
      // credit keeps the member entitled
      const gateUser = new ObjectId();
      const gateRunning = periodOf(gateUser, -28, -1);
      await subscriptions.insertOne(gateRunning);
      await interruptedFreeze(gateUser, gateRunning._id, 9, -28);
      const gate = gymId.toHexString();
      assert.equal(
        await checkEntrySubscription(gateUser.toHexString(), gate),
        "none",
      );
      await settlePendingCredit(gateUser);
      assert.equal(
        days((await subscriptions.findOne({ _id: gateRunning._id }))!.endsAt),
        9,
      );
      assert.equal(
        (await freezes.findOne({ userId: gateUser }))!.creditApplied,
        true,
      );
      assert.equal(
        await checkEntrySubscription(gateUser.toHexString(), gate),
        "ok",
      );
      // nothing pending: a no-op that takes no lock
      await settlePendingCredit(new ObjectId());

      /** An open freeze, as startFreeze writes it. */
      const openFreeze = (userId: ObjectId, startedDays: number) =>
        freezes.insertOne({
          userId,
          startedAt: at(startedDays),
          startedBy: "staff",
          maxDays: 30,
          endedAt: null,
          endedBy: null,
          endReason: null,
          creditedMs: null,
          plan: null,
          creditApplied: false,
        });

      // summary: while frozen, the dates are those of resuming now
      const pausedUser = new ObjectId();
      await subscriptions.insertOne(periodOf(pausedUser, -10, 20));
      await openFreeze(pausedUser, -4);
      const paused = await getSubscriptionSummary(pausedUser.toHexString());
      assert.equal(paused.active, true);
      assert.equal(paused.remainingDays, 24, "20 days left + 4 frozen");
      assert.ok(paused.freeze);
      // the nominal end passed during the freeze: still entitled, not "none"
      const lapsedUser = new ObjectId();
      await subscriptions.insertOne(periodOf(lapsedUser, -30, -2));
      await openFreeze(lapsedUser, -5);
      const lapsed = await getSubscriptionSummary(lapsedUser.toHexString());
      assert.equal(lapsed.active, true);
      assert.equal(lapsed.remainingDays, 3);
      assert.ok(lapsed.endsAt);

      // reaper: a freeze past maxDays ends with exactly maxDays credited, and
      // the change is audited like a manual end
      const reapUser = new ObjectId();
      const reapRunning = periodOf(reapUser, -50, 10);
      await subscriptions.insertOne(reapRunning);
      await openFreeze(reapUser, -40);
      assert.ok((await reapExpiredFreezes()) >= 1);
      assert.equal(
        days((await subscriptions.findOne({ _id: reapRunning._id }))!.endsAt),
        40,
      );
      const reapAudit = await db
        .collection("audit_logs")
        .find({
          action: "subscription-unfrozen",
          targetId: reapUser.toHexString(),
        })
        .toArray();
      assert.equal(reapAudit.length, 1);
      assert.equal(reapAudit[0]?.actorId, "system");
      assert.equal(reapAudit[0]?.gymId, gymId.toHexString());
      assert.equal(reapAudit[0]?.details.reason, "max-days");
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
