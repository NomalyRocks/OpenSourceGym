/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of ad-hoc HTTP calls in a test */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "an open freeze shows as frozen in directory, detail and status filter, and blocks promotion",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_frozen_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/11";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "frozen-status-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { default: express },
      { createServer },
      { auth },
      { db, mongoClient },
      { connectRedis, redis },
      { ensureIndexes },
      { adminRouter },
      { memberControlsRouter },
      { ObjectId },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("../auth.js"),
      import("../db.js"),
      import("../redis.js"),
      import("../indexes.js"),
      import("../routes/admin.js"),
      import("../routes/memberControls.js"),
      import("mongodb"),
    ]);

    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
    app.use("/api/admin", memberControlsRouter);
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    let counter = 0;
    async function createUser(
      first: string,
      extra: Record<string, unknown> = {},
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
          { $set: { role: "member", emailVerified: true, ...extra } },
        );
      const signedIn = await auth.api.signInEmail({
        body: { email, password: "test-password-1234" },
        returnHeaders: true,
      });
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return { id, cookie };
    }

    async function get(cookie: string, path: string): Promise<any> {
      const response = await fetch(`${base}/api/admin${path}`, {
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      return response.json();
    }

    const DAY = 86_400_000;
    const gymA = new ObjectId();
    const gymB = new ObjectId();
    async function addSub(
      userId: string,
      from: number,
      to: number,
      gym = gymA,
    ) {
      await db.collection("subscriptions").insertOne({
        userId: new ObjectId(userId),
        startsAt: new Date(Date.now() + from * DAY),
        endsAt: new Date(Date.now() + to * DAY),
        gymIds: [gym],
        note: null,
        createdBy: "test",
        createdAt: new Date(),
      });
    }
    async function openFreeze(userId: string) {
      return db.collection("subscription_freezes").insertOne({
        userId: new ObjectId(userId),
        startedAt: new Date(Date.now() - DAY),
        startedBy: "test",
        maxDays: 30,
        endedAt: null,
      });
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();
      await ensureIndexes();

      const owner = await createUser("Olga", { role: "owner" });
      const adminA = await createUser("Adem", {
        role: "admin",
        gymIds: [gymA.toHexString()],
      });
      const adminB = await createUser("Bora", {
        role: "admin",
        gymIds: [gymB.toHexString()],
      });
      const frozenActive = await createUser("FrozenActive");
      const frozenLapsed = await createUser("FrozenLapsed");
      const plain = await createUser("Plain");
      await addSub(frozenActive.id, -10, 20);
      await addSub(frozenLapsed.id, -30, -2);
      await addSub(plain.id, -10, 20);
      await openFreeze(frozenActive.id);
      const lapsedFreeze = await openFreeze(frozenLapsed.id);

      const dir = await get(owner.cookie, "/users/directory?pageSize=100");
      const row = (rows: any[], id: string) => rows.find((r) => r.id === id);
      assert.equal(
        row(dir.items, frozenActive.id).subscriptionStatus,
        "frozen",
      );
      // Frozen wins over expired: the nominal end passed during the freeze.
      assert.equal(
        row(dir.items, frozenLapsed.id).subscriptionStatus,
        "frozen",
      );
      assert.equal(row(dir.items, plain.id).subscriptionStatus, "active");
      assert.deepEqual(row(dir.items, frozenLapsed.id).subscriptionGymIds, [
        gymA.toHexString(),
      ]);

      const filtered = await get(
        owner.cookie,
        "/users/directory?status=frozen",
      );
      assert.deepEqual(
        filtered.items.map((r: any) => r.id).sort(),
        [frozenActive.id, frozenLapsed.id].sort(),
      );
      // The gym filter still finds a frozen member whose period lapsed.
      const byGym = await get(
        adminA.cookie,
        `/users/directory?status=frozen&gymId=${gymA.toHexString()}`,
      );
      assert.equal(byGym.total, 2);
      const otherGym = await get(
        adminB.cookie,
        `/users/directory?status=frozen&gymId=${gymB.toHexString()}`,
      );
      assert.equal(otherGym.total, 0);

      const detail = await get(owner.cookie, `/users/${frozenLapsed.id}`);
      assert.equal(detail.user.subscriptionStatus, "frozen");

      // Ending the freeze brings the status back.
      await db
        .collection("subscription_freezes")
        .updateOne(
          { _id: lapsedFreeze.insertedId },
          { $set: { endedAt: new Date() } },
        );
      const after = await get(owner.cookie, `/users/${frozenLapsed.id}`);
      assert.equal(after.user.subscriptionStatus, "expired");

      // A banned or frozen member cannot be promoted: unban and resume accept
      // members only, so the promoted account could not be fixed afterwards.
      async function promote(userId: string, role: string) {
        const response = await fetch(`${base}/api/admin/users/${userId}/role`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: owner.cookie },
          body: JSON.stringify({ role }),
        });
        return {
          status: response.status,
          body: (await response.json()) as any,
        };
      }
      const roleOf = async (userId: string) =>
        (await db.collection("user").findOne({ _id: new ObjectId(userId) }))
          ?.role;
      const frozenPromotion = await promote(frozenActive.id, "staff");
      assert.equal(frozenPromotion.status, 409);
      assert.equal(frozenPromotion.body.code, "MEMBER_FROZEN");
      assert.equal(await roleOf(frozenActive.id), "member");

      const plainUser = { _id: new ObjectId(plain.id) };
      await db.collection("user").updateOne(plainUser, {
        $set: {
          ban: { reason: "test", bannedAt: new Date(), bannedBy: owner.id },
        },
      });
      const bannedPromotion = await promote(plain.id, "admin");
      assert.equal(bannedPromotion.status, 409);
      assert.equal(bannedPromotion.body.code, "MEMBER_BANNED");
      assert.equal(await roleOf(plain.id), "member");

      await db.collection("user").updateOne(plainUser, { $set: { ban: null } });
      assert.equal((await promote(plain.id, "staff")).status, 200);
      assert.equal(await roleOf(plain.id), "staff");
    } finally {
      await db.dropDatabase().catch(() => undefined);
      await redis.flushDb().catch(() => undefined);
      server.close();
      await redis.quit().catch(() => undefined);
      await mongoClient.close();
    }
  },
);
