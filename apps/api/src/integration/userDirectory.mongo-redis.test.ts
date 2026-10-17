/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of ad-hoc HTTP calls in a test */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "user directory: filters, paging, total, sorting, scope and role gates",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_userdir_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/13";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "user-directory-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { default: express },
      { createServer },
      { auth },
      { db, mongoClient },
      { connectRedis, redis },
      { ensureIndexes },
      { adminRouter },
      { ObjectId },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("../auth.js"),
      import("../db.js"),
      import("../redis.js"),
      import("../indexes.js"),
      import("../routes/admin.js"),
      import("mongodb"),
    ]);

    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    let counter = 0;
    async function createUser(
      first: string,
      last: string,
      extra: Record<string, unknown> = {},
    ): Promise<{ id: string; cookie: string; email: string }> {
      counter += 1;
      const email = `user${counter}-${randomUUID()}@example.com`;
      const signedUp = await auth.api.signUpEmail({
        body: {
          email,
          password: "test-password-1234",
          name: `${first} ${last}`,
          firstName: first,
          lastName: last,
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
      return { id, cookie, email };
    }

    async function get(
      cookie: string,
      query: string,
    ): Promise<{ status: number; body: Record<string, any> }> {
      const response = await fetch(
        `${base}/api/admin/users/directory${query}`,
        {
          headers: { cookie },
        },
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    }

    const DAY = 86_400_000;
    async function addSub(
      userId: string,
      startOffsetDays: number,
      endOffsetDays: number,
      gymIds: string[],
    ) {
      await db.collection("subscriptions").insertOne({
        userId: new ObjectId(userId),
        startsAt: new Date(Date.now() + startOffsetDays * DAY),
        endsAt: new Date(Date.now() + endOffsetDays * DAY),
        gymIds: gymIds.map((id) => new ObjectId(id)),
        note: null,
        createdBy: "test",
        createdAt: new Date(),
      });
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();
      await ensureIndexes();

      const gymA = new ObjectId().toHexString();
      const gymB = new ObjectId().toHexString();

      const owner = await createUser("Olga", "Owner", { role: "owner" });
      const staffA = await createUser("Selin", "Staff", {
        role: "staff",
        gymIds: [gymA],
      });
      // Enabled after sign-in: with MFA on, sign-in returns no session cookie.
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(staffA.id) },
          { $set: { twoFactorEnabled: true } },
        );
      const adminB = await createUser("Adem", "Admin", {
        role: "admin",
        gymIds: [gymB],
      });
      const active = await createUser("Çağla", "Active");
      const expired = await createUser("Ahmet", "Expired");
      const none = await createUser("Zeynep", "None");
      const activeB = await createUser("Burak", "ActiveB");
      const futureOnly = await createUser("Fatma", "Future");

      await addSub(active.id, -10, 20, [gymA]);
      await addSub(expired.id, -60, -30, [gymA]);
      await addSub(activeB.id, -5, 25, [gymB]);
      // Sequential periods: an older expired one plus a current one.
      await addSub(activeB.id, -40, -5, [gymA]);
      await addSub(futureOnly.id, 10, 40, [gymA]);

      // --- role gates ---
      assert.equal((await get(active.cookie, "")).status, 403);
      assert.equal((await get("cookie=bogus", "")).status, 401);

      // --- defaults: everything, newest first, total matches ---
      const all = await get(owner.cookie, "");
      assert.equal(all.status, 200);
      assert.equal(all.body.total, 8);
      assert.equal(all.body.page, 1);
      assert.equal(all.body.pageSize, 25);
      assert.equal(all.body.items.length, 8);
      const created = all.body.items.map((i: any) => i.createdAt);
      assert.deepEqual([...created].sort().reverse(), created);
      for (const item of all.body.items) {
        assert.equal("phoneE164" in item, false);
        assert.equal("password" in item, false);
      }

      // --- derived status and endsAt ---
      const byEmail = (rows: any[], email: string) =>
        rows.find((r) => r.email === email);
      assert.equal(
        byEmail(all.body.items, active.email).subscriptionStatus,
        "active",
      );
      assert.equal(
        byEmail(all.body.items, expired.email).subscriptionStatus,
        "expired",
      );
      assert.equal(
        byEmail(all.body.items, none.email).subscriptionStatus,
        "none",
      );
      assert.equal(
        byEmail(all.body.items, none.email).subscriptionEndsAt,
        null,
      );
      assert.equal(
        byEmail(all.body.items, futureOnly.email).subscriptionStatus,
        "none",
      );
      const activeBRow = byEmail(all.body.items, activeB.email);
      assert.equal(activeBRow.subscriptionStatus, "active");
      assert.ok(
        Math.abs(
          new Date(activeBRow.subscriptionEndsAt).getTime() -
            (Date.now() + 25 * DAY),
        ) < 60_000,
        "active row reports the current period's end",
      );
      assert.deepEqual(
        byEmail(all.body.items, active.email).subscriptionGymIds,
        [gymA],
      );
      assert.deepEqual(
        byEmail(all.body.items, activeB.email).subscriptionGymIds,
        [gymB],
        "the expired gym A period does not count",
      );
      for (const e of [expired, none, futureOnly]) {
        assert.deepEqual(
          byEmail(all.body.items, e.email).subscriptionGymIds,
          [],
        );
      }
      assert.ok(
        new Date(byEmail(all.body.items, expired.email).subscriptionEndsAt) <
          new Date(),
      );

      // --- status filter (list) with total ---
      const statuses = await get(owner.cookie, "?status=active,expired");
      assert.equal(statuses.body.total, 3);
      assert.deepEqual(
        statuses.body.items.map((i: any) => i.subscriptionStatus).sort(),
        ["active", "active", "expired"],
      );

      // --- role and 2FA filters ---
      const staffOnly = await get(owner.cookie, "?role=staff,admin");
      assert.equal(staffOnly.body.total, 2);
      const mfaOn = await get(owner.cookie, "?twoFactor=on");
      assert.deepEqual(
        mfaOn.body.items.map((i: any) => i.email),
        [staffA.email],
      );
      assert.equal((await get(owner.cookie, "?twoFactor=off")).body.total, 7);

      // --- gym filter: members with a current period at the gym + staff scoped to it ---
      const atA = await get(owner.cookie, `?gymId=${gymA}`);
      assert.deepEqual(
        atA.body.items.map((i: any) => i.email).sort(),
        [active.email, staffA.email].sort(),
        "expired and future periods at gym A do not count",
      );
      assert.equal(atA.body.total, 2);
      const atBMembers = await get(owner.cookie, `?gymId=${gymB}&role=member`);
      assert.deepEqual(
        atBMembers.body.items.map((i: any) => i.email),
        [activeB.email],
      );
      assert.equal(
        (await get(owner.cookie, `?gymId=${gymA}&status=expired`)).body.total,
        0,
      );

      // --- text search ---
      const search = await get(owner.cookie, "?q=expired");
      assert.deepEqual(
        search.body.items.map((i: any) => i.email),
        [expired.email],
      );
      assert.equal((await get(owner.cookie, "?q=a")).status, 400);
      assert.equal((await get(owner.cookie, "?q=")).body.total, 8);

      // --- sorting by name uses Turkish collation (Ç after C, before D) ---
      const byName = await get(owner.cookie, "?sort=name&role=member");
      assert.deepEqual(
        byName.body.items.map((i: any) => i.firstName),
        ["Ahmet", "Burak", "Çağla", "Fatma", "Zeynep"],
      );
      const byNameDesc = await get(
        owner.cookie,
        "?sort=name&dir=desc&role=member",
      );
      assert.equal(byNameDesc.body.items[0].firstName, "Zeynep");

      // --- paging: pages are disjoint, total constant, past-the-end is empty ---
      const p1 = await get(owner.cookie, "?pageSize=3&page=1&sort=name");
      const p2 = await get(owner.cookie, "?pageSize=3&page=2&sort=name");
      const p3 = await get(owner.cookie, "?pageSize=3&page=3&sort=name");
      const p4 = await get(owner.cookie, "?pageSize=3&page=4&sort=name");
      assert.deepEqual(
        [p1, p2, p3, p4].map((p) => p.body.items.length),
        [3, 3, 2, 0],
      );
      assert.equal(p4.body.total, 8);
      const ids = [p1, p2, p3].flatMap((p) =>
        p.body.items.map((i: any) => i.id),
      );
      assert.equal(new Set(ids).size, 8);
      // Paging also works on the join-first (filtered) path.
      const f1 = await get(owner.cookie, "?status=none&pageSize=3&page=1");
      const f2 = await get(owner.cookie, "?status=none&pageSize=3&page=2");
      assert.equal(f1.body.total, 5);
      assert.deepEqual(
        [f1, f2].map((p) => p.body.items.length),
        [3, 2],
      );

      // --- validation ---
      assert.equal((await get(owner.cookie, "?pageSize=101")).status, 400);
      assert.equal((await get(owner.cookie, "?role=root")).status, 400);

      // --- scope: staff/admin only for their own gyms; no gym filter stays chain-wide ---
      const ownGym = await get(staffA.cookie, `?gymId=${gymA}`);
      assert.equal(ownGym.status, 200);
      assert.equal(ownGym.body.total, 2);
      const otherGym = await get(staffA.cookie, `?gymId=${gymB}`);
      assert.equal(otherGym.status, 403);
      assert.equal(otherGym.body.code, "GYM_OUT_OF_SCOPE");
      assert.equal((await get(adminB.cookie, `?gymId=${gymA}`)).status, 403);
      assert.equal((await get(staffA.cookie, "")).body.total, 8);
    } finally {
      server.closeAllConnections();
      server.close();
      await db.dropDatabase().catch(() => undefined);
      if (redis.isOpen) {
        await redis.flushDb().catch(() => undefined);
        await redis.quit();
      }
      await mongoClient.close();
    }
  },
);
