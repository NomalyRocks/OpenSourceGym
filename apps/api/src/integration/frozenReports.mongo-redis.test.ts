import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ObjectId } from "mongodb";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;
const DAY = 86_400_000;

test(
  "frozen members are excluded from renewals, reminders, active and lapsed counts",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_frozenrep_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/9";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "frozen-reports-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { db, mongoClient },
      { connectRedis, redis },
      reports,
      renewals,
      reminders,
    ] = await Promise.all([
      import("../db.js"),
      import("../redis.js"),
      import("../reports.js"),
      import("../renewals.js"),
      import("../renewalReminders.js"),
    ]);

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();

      const now = new Date();
      const at = (days: number) => new Date(now.getTime() + days * DAY);
      const gymA = new ObjectId();
      const gymB = new ObjectId();
      await db.collection("gyms").insertMany([
        {
          _id: gymA,
          name: "Gym A",
          active: true,
          autoExitHours: 4,
          reminders: { enabled: true, daysBefore: [7, 1] },
          createdAt: now,
        },
        { _id: gymB, name: "Gym B", active: true, createdAt: now },
      ] as never);

      const mk = async (
        email: string,
        from: number,
        to: number,
        gym: ObjectId,
      ) => {
        const userId = new ObjectId();
        await db.collection("user").insertOne({
          _id: userId,
          email,
          firstName: email,
          lastName: "T",
          role: "member",
          createdAt: now,
        } as never);
        await db.collection("subscriptions").insertOne({
          userId,
          gymIds: [gym],
          startsAt: at(from),
          endsAt: at(to),
          note: null,
          createdBy: "t",
          createdAt: now,
        });
        return userId;
      };
      const freeze = (userId: ObjectId) =>
        db.collection("subscription_freezes").insertOne({
          userId,
          startedAt: at(-1),
          startedBy: "t",
          maxDays: 30,
          endedAt: null,
        });

      const plain = await mk("plain@example.com", -20, 3, gymA);
      const frozenSoon = await mk("frozen-soon@example.com", -20, 3, gymA);
      const frozenLapsed = await mk("frozen-lapsed@example.com", -20, -1, gymA);
      const frozenB = await mk("frozen-b@example.com", -20, 10, gymB);
      await freeze(frozenSoon);
      await freeze(frozenLapsed);
      await freeze(frozenB);
      const A = gymA.toHexString();
      const B = gymB.toHexString();

      assert.equal(await reports.countActiveMembers(db, now, A), 1);
      assert.equal(await reports.countRenewalsDue(db, now, A), 1);

      const summary = await reports.buildReportSummary(
        { from: at(-5), to: now },
        A,
        db,
        now,
      );
      assert.equal(summary.activeMembers, 1);
      assert.equal(summary.frozenMembers, 2);
      assert.equal(summary.renewalsDue, 1);
      assert.equal(summary.lapsedMembers, 0, "paused, not lapsed");

      const gyms = await db.collection("gyms").find({}).toArray();
      const chain = await reports.buildChainSummary(
        { from: at(-5), to: now },
        gyms as never,
        db,
        now,
      );
      assert.equal(chain.activeMembers, 1);
      assert.equal(chain.frozenMembers, 3);
      const rowOf = (id: string) => chain.gyms.find((g) => g.gymId === id)!;
      assert.equal(rowOf(A).frozenMembers, 2);
      assert.equal(rowOf(B).frozenMembers, 1);
      assert.equal(rowOf(B).activeMembers, 0);

      const due = await renewals.listRenewalsDue(
        { gymId: A, withinDays: 7, limit: 50, now },
        db,
      );
      assert.deepEqual(
        due.items.map((i) => i.email),
        ["plain@example.com"],
      );
      assert.ok(await renewals.findRenewalTarget(plain, A, db));
      assert.equal(await renewals.findRenewalTarget(frozenSoon, A, db), null);

      const report = await reminders.runRenewalReminderSweep(db, now);
      assert.equal(report.scanned, 1, "only the non-frozen member is scanned");
    } finally {
      await db.dropDatabase().catch(() => undefined);
      await redis.flushDb().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await mongoClient.close();
    }
  },
);
