/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of ad-hoc HTTP calls in a test */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "live presence: /inside list and directory presence with scope",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_presence_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/12";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "presence-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { default: express },
      { createServer },
      { auth },
      { db, mongoClient },
      { connectRedis, redis },
      { ensureIndexes },
      { adminRouter },
      { gymsRouter },
      { memberControlsRouter },
      { getOccupancy },
      { ObjectId },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("../auth.js"),
      import("../db.js"),
      import("../redis.js"),
      import("../indexes.js"),
      import("../routes/admin.js"),
      import("../routes/gyms.js"),
      import("../routes/memberControls.js"),
      import("../occupancy.js"),
      import("mongodb"),
    ]);

    const app = express();
    app.use(express.json());
    app.use("/api/admin/gyms", gymsRouter);
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

    async function get(
      cookie: string,
      path: string,
    ): Promise<{ status: number; body: any }> {
      const response = await fetch(`${base}/api/admin${path}`, {
        headers: { cookie },
      });
      return { status: response.status, body: await response.json() };
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
          createdAt: new Date(),
        });
      }
      const A = gymA.toHexString();
      const B = gymB.toHexString();

      const owner = await createUser("Olga", { role: "owner" });
      const adminA = await createUser("Adem", { role: "admin", gymIds: [A] });
      const early = await createUser("Early");
      const late = await createUser("Late");
      const stale = await createUser("Stale");
      const atB = await createUser("AtB");
      const outside = await createUser("Out");

      const now = Date.now();
      const HOUR = 3_600_000;
      await redis.hSet(`og:inside:${A}`, early.id, String(now - 2 * HOUR));
      await redis.hSet(`og:inside:${A}`, late.id, String(now - 10 * 60_000));
      await redis.hSet(`og:inside:${A}`, stale.id, String(now - 5 * HOUR));
      await redis.hSet(`og:inside:${B}`, atB.id, String(now - 30 * 60_000));

      // --- /inside ---
      assert.equal((await get(late.cookie, `/gyms/${A}/inside`)).status, 403);
      assert.equal((await get(adminA.cookie, `/gyms/${B}/inside`)).status, 403);
      const inside = await get(owner.cookie, `/gyms/${A}/inside`);
      assert.equal(inside.status, 200);
      assert.equal(inside.body.gymId, A);
      assert.deepEqual(
        inside.body.members.map((m: any) => m.userId),
        [early.id, late.id],
      );
      assert.equal(inside.body.members[0].name, "Early Tester");
      assert.equal(inside.body.members.length, await getOccupancy(A));

      // --- directory presence ---
      const dir = await get(owner.cookie, "/users/directory?pageSize=100");
      const row = (rows: any[], id: string) => rows.find((r) => r.id === id);
      assert.equal(row(dir.body.items, early.id).presence.gymId, A);
      assert.equal(row(dir.body.items, early.id).presence.gymName, "Gym A");
      assert.equal(row(dir.body.items, atB.id).presence.gymId, B);
      assert.equal(row(dir.body.items, stale.id).presence, null);
      assert.equal(row(dir.body.items, outside.id).presence, null);

      // Admin of A: sees A presence, not B.
      const scoped = await get(adminA.cookie, "/users/directory?pageSize=100");
      assert.equal(row(scoped.body.items, early.id).presence.gymId, A);
      assert.equal(row(scoped.body.items, atB.id).presence, null);

      // --- member detail ---
      const detail = await get(owner.cookie, `/users/${atB.id}`);
      assert.equal(detail.body.user.presence.gymId, B);
      const hidden = await get(adminA.cookie, `/users/${atB.id}`);
      assert.equal(hidden.body.user.presence, null);
    } finally {
      await db.dropDatabase().catch(() => undefined);
      await redis.flushDb().catch(() => undefined);
      server.close();
      await redis.quit().catch(() => undefined);
      await mongoClient.close();
    }
  },
);
