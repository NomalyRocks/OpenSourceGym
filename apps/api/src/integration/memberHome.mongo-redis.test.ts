/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of ad-hoc HTTP calls in a test */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "live member home: per-gym windows, presence and busy hours",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_memberhome_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/6";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "member-home-integration-test-secret-at-least-32-characters";
    process.env.REPORTS_TIME_ZONE = "Europe/Istanbul";
    delete process.env.SMTP_HOST;

    const [
      { default: express },
      { createServer },
      { auth },
      { db, mongoClient },
      { connectRedis, redis },
      { ensureIndexes },
      { meRouter },
      { zonedDayHour },
      { ObjectId },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("../auth.js"),
      import("../db.js"),
      import("../redis.js"),
      import("../indexes.js"),
      import("../routes/me.js"),
      import("../busyHours.js"),
      import("mongodb"),
    ]);

    const app = express();
    app.use(express.json());
    app.use("/api/me", meRouter);
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    let counter = 0;
    async function createUser(
      first: string,
    ): Promise<{ id: string; cookie: string }> {
      counter += 1;
      const email = `user${counter}-${randomUUID()}@example.com`;
      const signedUp = await auth.api.signUpEmail({
        body: {
          email,
          password: "test-password-1234",
          name: `${first} Tester`,
          firstName: first,
          lastName: "Tester",
          phone: `53${counter}1234567`.slice(0, 10),
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      const id = signedUp.user.id;
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: "member", emailVerified: true } },
        );
      const signedIn = await auth.api.signInEmail({
        body: { email, password: "test-password-1234" },
        returnHeaders: true,
      });
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return { id, cookie };
    }

    async function get(
      cookie: string,
      path: string,
    ): Promise<{ status: number; body: any }> {
      const response = await fetch(`${base}/api/me${path}`, {
        headers: { cookie },
      });
      return { status: response.status, body: await response.json() };
    }

    const DAY = 86_400_000;
    const HOUR = 3_600_000;
    const t0 = Date.now();

    async function addSub(
      userId: string,
      from: number,
      to: number,
      gymIds: InstanceType<typeof ObjectId>[],
    ): Promise<Date> {
      const endsAt = new Date(t0 + to * DAY);
      await db.collection("subscriptions").insertOne({
        userId: new ObjectId(userId),
        startsAt: new Date(t0 + from * DAY),
        endsAt,
        gymIds,
        note: null,
        createdBy: "test",
        createdAt: new Date(),
      });
      return endsAt;
    }

    async function addEntry(
      userId: string,
      gymId: string,
      at: Date,
      extra: Record<string, unknown> = {},
    ): Promise<void> {
      await db.collection("entry_events").insertOne({
        userId,
        gymId,
        deviceId: "device-in",
        direction: "in",
        allowed: true,
        at,
        ...extra,
      });
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();
      await ensureIndexes();

      const gymA = new ObjectId();
      const gymB = new ObjectId();
      for (const [_id, name] of [
        [gymA, "Gym A"],
        [gymB, "Gym B"],
      ] as const) {
        await db.collection("gyms").insertOne({
          _id,
          name,
          active: true,
          autoExitHours: 4,
          capacity: null,
          createdAt: new Date(t0 - 60 * DAY),
        });
      }
      const A = gymA.toHexString();
      const B = gymB.toHexString();

      // --- GET /subscription: each gym carries its own contiguous window ---
      const multi = await createUser("Multi");
      const sharedEnd = await addSub(multi.id, -10, 20, [gymA, gymB]);
      const aOnlyEnd = await addSub(multi.id, 20, 50, [gymA]);

      const sub = await get(multi.cookie, "/subscription");
      assert.equal(sub.status, 200);
      assert.equal(sub.body.active, true);
      assert.equal(sub.body.endsAt, aOnlyEnd.toISOString());
      const gymRow = (id: string) =>
        sub.body.gyms.find((gym: any) => gym.id === id);
      assert.equal(gymRow(A).endsAt, aOnlyEnd.toISOString());
      assert.equal(gymRow(A).remainingDays, 50);
      assert.equal(gymRow(B).endsAt, sharedEnd.toISOString());
      assert.equal(gymRow(B).remainingDays, 20);
      assert.equal(gymRow(A).startsAt, gymRow(B).startsAt);

      // A frozen member sees the window they would resume with.
      const frozen = await createUser("Frozen");
      const frozenEnd = await addSub(frozen.id, -10, 20, [gymA]);
      await db.collection("subscription_freezes").insertOne({
        userId: new ObjectId(frozen.id),
        startedAt: new Date(t0 - 5 * DAY),
        startedBy: "test",
        maxDays: 30,
        endedAt: null,
      });
      const frozenSub = await get(frozen.cookie, "/subscription");
      assert.equal(frozenSub.status, 200);
      assert.ok(frozenSub.body.freeze);
      const frozenGym = frozenSub.body.gyms.find((gym: any) => gym.id === A);
      assert.ok(frozenGym);
      const previewedEnd = Date.parse(frozenGym.endsAt);
      assert.ok(previewedEnd >= frozenEnd.getTime() + 5 * DAY - 60_000);
      assert.ok(frozenGym.remainingDays >= 25 && frozenGym.remainingDays <= 26);
      assert.equal(frozenGym.endsAt, frozenSub.body.endsAt);

      // --- GET /presence ---
      const inside = await createUser("Inside");
      await addSub(inside.id, -1, 30, [gymA]);
      await redis.hSet(`og:inside:${A}`, inside.id, String(t0 - 30 * 60_000));
      const lastAllowed = new Date(t0 - 30 * 60_000);
      await addEntry(inside.id, A, new Date(t0 - 2 * DAY));
      await addEntry(inside.id, A, lastAllowed);
      // Neither a later refusal nor a later exit counts as the last entry.
      await addEntry(inside.id, B, new Date(t0 - 10 * 60_000), {
        allowed: false,
        reason: "NOT_ALLOWED_AT_GYM",
      });
      await addEntry(inside.id, A, new Date(t0 - 5 * 60_000), {
        deviceId: "device-out",
        direction: "out",
      });

      const presence = await get(inside.cookie, "/presence");
      assert.equal(presence.status, 200);
      assert.equal(presence.body.inside.gymId, A);
      assert.equal(presence.body.inside.gymName, "Gym A");
      assert.deepEqual(presence.body.lastEntry, {
        gymId: A,
        gymName: "Gym A",
        at: lastAllowed.toISOString(),
      });

      // A record past autoExitHours no longer counts as inside.
      const stale = await createUser("Stale");
      await redis.hSet(`og:inside:${A}`, stale.id, String(t0 - 5 * HOUR));
      const stalePresence = await get(stale.cookie, "/presence");
      assert.equal(stalePresence.status, 200);
      assert.deepEqual(stalePresence.body, { inside: null, lastEntry: null });

      // --- GET /gyms/:gymId/busy-hours ---
      const member = await createUser("Busy");
      await addSub(member.id, -1, 30, [gymA]);
      const nobody = await createUser("Nobody");

      for (const [cookie, gymId] of [
        [member.cookie, B], // gym outside the subscription
        [member.cookie, new ObjectId().toHexString()], // unknown gym
        [member.cookie, "not-an-id"], // malformed id
        [nobody.cookie, A], // no subscription at all
      ] as const) {
        const refused = await get(cookie, `/gyms/${gymId}/busy-hours`);
        assert.equal(refused.status, 403);
        assert.equal(refused.body.code, "GYM_OUT_OF_SCOPE");
      }

      const timeZone = "Europe/Istanbul";
      const weekAgo = new Date(t0 - 7 * DAY);
      const twoWeeksAgo = new Date(t0 - 14 * DAY);
      const sampleHour = zonedDayHour(weekAgo, timeZone).hour;
      await addEntry(multi.id, A, weekAgo);
      await addEntry(inside.id, A, weekAgo);
      await addEntry(frozen.id, A, twoWeeksAgo);
      await addEntry(member.id, A, twoWeeksAgo);
      // Ignored: refusals, exits, other gyms and days that are not sampled.
      await addEntry(member.id, A, weekAgo, { allowed: false });
      await addEntry(member.id, A, weekAgo, {
        deviceId: "device-out",
        direction: "out",
      });
      await addEntry(member.id, B, weekAgo);
      await addEntry(member.id, A, new Date(t0 - 8 * DAY));

      const busy = await get(member.cookie, `/gyms/${A}/busy-hours`);
      assert.equal(busy.status, 200);
      assert.equal(busy.body.gymId, A);
      assert.equal(busy.body.timeZone, timeZone);
      assert.equal(busy.body.sampleDays, 4);
      assert.equal(busy.body.hours.length, 24);
      // Four same-weekday entries across four sample days average to 1.
      // The "inside" member's earlier presence-test entries were 2 days and
      // ~30 min ago, so neither falls on a sampled day.
      for (const row of busy.body.hours) {
        assert.equal(row.avgEntries, row.hour === sampleHour ? 1 : 0);
      }

      // The profile is cached per gym and local day for one hour.
      const today = zonedDayHour(new Date(), timeZone).day;
      const ttl = await redis.ttl(`og:busyhours:v2:${A}:${today}`);
      assert.ok(ttl > 0 && ttl <= 3600);
      await addEntry(member.id, A, weekAgo);
      const cached = await get(member.cookie, `/gyms/${A}/busy-hours`);
      assert.deepEqual(cached.body, busy.body);

      // A frozen member whose raw period ended during the freeze keeps the
      // gym GET /subscription lists, and busy hours follow the same scope.
      const lapsedFrozen = await createUser("LapsedFrozen");
      await addSub(lapsedFrozen.id, -10, -2, [gymA]);
      await db.collection("subscription_freezes").insertOne({
        userId: new ObjectId(lapsedFrozen.id),
        startedAt: new Date(t0 - 5 * DAY),
        startedBy: "test",
        maxDays: 30,
        endedAt: null,
      });
      const lapsedSub = await get(lapsedFrozen.cookie, "/subscription");
      assert.equal(lapsedSub.status, 200);
      assert.deepEqual(lapsedSub.body.gymIds, [A]);
      const lapsedBusy = await get(
        lapsedFrozen.cookie,
        `/gyms/${A}/busy-hours`,
      );
      assert.equal(lapsedBusy.status, 200);
      assert.equal(lapsedBusy.body.gymId, A);
    } finally {
      await db.dropDatabase().catch(() => undefined);
      await redis.flushDb().catch(() => undefined);
      server.close();
      await redis.quit().catch(() => undefined);
      await mongoClient.close();
    }
  },
);
