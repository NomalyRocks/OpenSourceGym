/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of ad-hoc HTTP calls in a test */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

// Istanbul and Ankara: ~350 km apart, so an immediate hop is impossible.
const ISTANBUL = { lat: 41.0, lng: 29.0 };
const ANKARA = { lat: 39.9, lng: 32.8 };

test(
  "multi-gym: scoping, subscription gyms, gate scan, exit, inactive gym and impossible travel",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_multigym_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/14";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "multi-gym-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { default: express },
      { createServer },
      { WebSocket },
      { auth },
      { db, mongoClient },
      { connectRedis, redis },
      { ensureIndexes },
      { adminRouter },
      { gymsRouter },
      { meRouter },
      { chainReportsRouter },
      { attachDeviceGateway },
      { startEntryEventConsumer },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("ws"),
      import("../auth.js"),
      import("../db.js"),
      import("../redis.js"),
      import("../indexes.js"),
      import("../routes/admin.js"),
      import("../routes/gyms.js"),
      import("../routes/me.js"),
      import("../routes/reports.js"),
      import("../gateway.js"),
      import("../eventQueue.js"),
    ]);

    const app = express();
    app.use(express.json());
    app.use("/api/admin/gyms", gymsRouter);
    app.use("/api/admin/reports", chainReportsRouter);
    app.use("/api/admin", adminRouter);
    app.use("/api/me", meRouter);
    const server = createServer(app);
    attachDeviceGateway(server);
    server.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const sockets: InstanceType<typeof WebSocket>[] = [];
    let consumer: Awaited<ReturnType<typeof startEntryEventConsumer>> | null =
      null;

    let phoneCounter = 0;
    async function createUser(
      label: string,
      role: "owner" | "admin" | "staff" | "member",
    ): Promise<{ id: string; cookie: string }> {
      const email = `${label}-${randomUUID()}@example.com`;
      phoneCounter += 1;
      const signedUp = await auth.api.signUpEmail({
        body: {
          email,
          password: "test-password-1234",
          name: label,
          firstName: label,
          lastName: "Test",
          phone: `53${phoneCounter}1234567`.slice(0, 10),
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      const id = signedUp.user.id;
      const { ObjectId } = await import("mongodb");
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(id) },
          { $set: { role, emailVerified: true } },
        );
      const signedIn = await auth.api.signInEmail({
        body: { email, password: "test-password-1234" },
        returnHeaders: true,
      });
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return { id, cookie };
    }

    async function call(
      cookie: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: Record<string, any> }> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    }

    async function connectDevice(
      deviceId: string,
      token: string,
    ): Promise<void> {
      const ws = new WebSocket(
        `${base.replace("http", "ws")}/api/device-gateway`,
      );
      sockets.push(ws);
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", deviceId, token }));
      const [raw] = (await once(ws, "message")) as [Buffer];
      assert.equal(JSON.parse(raw.toString()).type, "auth_ok");
    }

    const scan = (cookie: string, qr: string, at: typeof ISTANBUL) =>
      call(cookie, "POST", "/api/me/gate-scan", { qr, ...at });

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();
      await ensureIndexes();
      consumer = await startEntryEventConsumer();

      const owner = await createUser("owner", "owner");
      const staffA = await createUser("staffa", "staff");
      const staffB = await createUser("staffb", "staff");
      const member = await createUser("member", "member");
      const noSub = await createUser("nosub", "member");
      const traveller = await createUser("traveller", "member");

      // --- gym CRUD is owner only; creation is audited ---
      const forbiddenCreate = await call(
        staffA.cookie,
        "POST",
        "/api/admin/gyms",
        {
          name: "Nope",
        },
      );
      assert.equal(forbiddenCreate.status, 403);

      const gymA = (
        await call(owner.cookie, "POST", "/api/admin/gyms", {
          name: "Gym A",
          location: { ...ISTANBUL, radiusM: 400 },
        })
      ).body as { id: string };
      const gymB = (
        await call(owner.cookie, "POST", "/api/admin/gyms", {
          name: "Gym B",
          location: { ...ANKARA, radiusM: 400 },
        })
      ).body as { id: string };
      assert.ok(gymA.id && gymB.id);
      assert.equal(
        await db
          .collection("audit_logs")
          .countDocuments({ action: "gym-created", gymId: gymA.id }),
        1,
      );

      // --- scope: admin/staff reach only their gyms; owner reaches all ---
      assert.equal(
        (
          await call(
            owner.cookie,
            "PUT",
            `/api/admin/users/${staffA.id}/gyms`,
            {
              gymIds: [gymA.id],
            },
          )
        ).status,
        200,
      );
      await call(owner.cookie, "PUT", `/api/admin/users/${staffB.id}/gyms`, {
        gymIds: [gymB.id],
      });
      assert.equal(
        await db
          .collection("audit_logs")
          .countDocuments({ action: "user-gyms-assigned" }),
        2,
      );
      assert.equal(
        (await call(staffA.cookie, "GET", `/api/admin/gyms/${gymA.id}/stats`))
          .status,
        200,
      );
      const otherGym = await call(
        staffA.cookie,
        "GET",
        `/api/admin/gyms/${gymB.id}/stats`,
      );
      assert.equal(otherGym.status, 403);
      assert.equal(otherGym.body.code, "GYM_OUT_OF_SCOPE");
      assert.equal(
        (
          await call(
            owner.cookie,
            "GET",
            `/api/admin/gyms/${"0".repeat(24)}/stats`,
          )
        ).status,
        404,
      );
      assert.equal(
        (await call(owner.cookie, "GET", `/api/admin/gyms/${gymB.id}/stats`))
          .status,
        200,
      );
      // Staff may never read devices (gate credentials).
      assert.equal(
        (await call(staffA.cookie, "GET", `/api/admin/gyms/${gymA.id}/devices`))
          .status,
        403,
      );
      const staffGyms = await call(staffA.cookie, "GET", "/api/admin/gyms");
      assert.deepEqual(
        (staffGyms.body as unknown as { id: string }[]).map((g) => g.id),
        [gymA.id],
      );

      // --- devices belong to a gym ---
      async function makeDevice(gymId: string, direction: "in" | "out") {
        const created = await call(
          owner.cookie,
          "POST",
          `/api/admin/gyms/${gymId}/devices`,
          { name: `${direction}-${gymId.slice(-4)}`, direction },
        );
        assert.equal(created.status, 200);
        assert.equal(created.body.gymId, gymId);
        await connectDevice(created.body.id, created.body.token);
        return created.body as { id: string; qrContent: string };
      }
      const inA = await makeDevice(gymA.id, "in");
      const outA = await makeDevice(gymA.id, "out");
      const inB = await makeDevice(gymB.id, "in");
      const outB = await makeDevice(gymB.id, "out");

      // --- subscriptions carry gymIds, validated and scoped ---
      const subscribe = (cookie: string, userId: string, gymIds: string[]) =>
        call(cookie, "POST", "/api/admin/subscriptions", {
          userId,
          months: 1,
          gymIds,
        });
      assert.equal((await subscribe(staffA.cookie, member.id, [])).status, 400);
      assert.equal(
        (await subscribe(staffA.cookie, member.id, [gymB.id])).status,
        403,
        "staff cannot sell access to a gym outside their scope",
      );
      assert.equal(
        (await subscribe(staffA.cookie, member.id, [gymA.id])).status,
        200,
      );
      assert.equal(
        (await subscribe(owner.cookie, traveller.id, [gymA.id, gymB.id]))
          .status,
        200,
      );
      const unknownGym = await subscribe(owner.cookie, noSub.id, [
        "f".repeat(24),
      ]);
      assert.equal(unknownGym.body.code, "GYM_NOT_FOUND");

      // --- entry: allowed gym / not allowed at gym / no subscription ---
      assert.equal(
        (await scan(member.cookie, inA.qrContent, ISTANBUL)).status,
        200,
      );
      await redis.del(`og:gate-open:${member.id}`);
      const wrongGym = await scan(member.cookie, inB.qrContent, ANKARA);
      assert.equal(wrongGym.status, 403);
      assert.equal(wrongGym.body.code, "NOT_ALLOWED_AT_GYM");
      const none = await scan(noSub.cookie, inA.qrContent, ISTANBUL);
      assert.equal(none.body.code, "NO_ACTIVE_SUBSCRIPTION");

      // --- exit is never refused for subscription reasons ---
      await redis.hSet(`og:inside:${gymA.id}`, noSub.id, String(Date.now()));
      assert.equal(
        (await scan(noSub.cookie, outA.qrContent, { lat: 0, lng: 0 })).status,
        200,
        "a member without a subscription can still leave",
      );

      // --- staff enter their own gym without a subscription; others do not ---
      assert.equal(
        (await scan(staffA.cookie, inA.qrContent, ISTANBUL)).status,
        200,
      );
      const staffElsewhere = await scan(staffA.cookie, inB.qrContent, ANKARA);
      assert.equal(staffElsewhere.body.code, "NO_ACTIVE_SUBSCRIPTION");
      assert.equal(
        (await scan(owner.cookie, inB.qrContent, ANKARA)).status,
        200,
      );
      void staffB;

      // --- impossible travel: A -> B closes the A record and signals sharing ---
      assert.equal(
        (await scan(traveller.cookie, inA.qrContent, ISTANBUL)).status,
        200,
      );
      await redis.del(`og:gate-open:${traveller.id}`);
      assert.equal(
        (await scan(traveller.cookie, inB.qrContent, ANKARA)).status,
        200,
      );
      assert.equal(
        await redis.hGet(`og:inside:${gymA.id}`, traveller.id),
        null,
      );
      assert.ok(await redis.hGet(`og:inside:${gymB.id}`, traveller.id));
      const { ObjectId } = await import("mongodb");
      const signal = await db.collection("sharing_signals").findOne({
        userId: new ObjectId(traveller.id),
        kind: "location-inconsistency",
      });
      assert.ok(signal, "implied speed above 120 km/h records a signal");
      assert.equal(signal.gymId, gymB.id);
      assert.equal(signal.meta.fromGymId, gymA.id);

      // --- inactive gym refuses entry but never exit ---
      assert.equal(
        (
          await call(owner.cookie, "PUT", `/api/admin/gyms/${gymB.id}`, {
            active: false,
          })
        ).status,
        200,
      );
      assert.equal(
        await db
          .collection("audit_logs")
          .countDocuments({ action: "gym-deactivated", gymId: gymB.id }),
        1,
      );
      await redis.del(`og:gate-open:${owner.id}`);
      const inactive = await scan(owner.cookie, inB.qrContent, ANKARA);
      assert.equal(inactive.body.code, "GYM_INACTIVE");
      await redis.del(`og:gate-open:${traveller.id}`);
      assert.equal(
        (await scan(traveller.cookie, outB.qrContent, { lat: 0, lng: 0 }))
          .status,
        200,
        "exit still works at a deactivated gym",
      );

      // --- every scan, allowed or refused, is logged with its gym ---
      await new Promise((resolve) => setTimeout(resolve, 500));
      const logged = await db
        .collection("entry_events")
        .find({ reason: "NOT_ALLOWED_AT_GYM" })
        .toArray();
      assert.equal(logged.length, 1);
      assert.equal(logged[0]?.gymId, gymB.id);
      const autoExit = await db.collection("entry_events").findOne({
        userId: traveller.id,
        gymId: gymB.id,
        allowed: true,
        direction: "in",
      });
      assert.equal(autoExit?.autoExitedGymId, gymA.id);

      // --- per-gym occupancy: scoped, and counts only that gym's records ---
      const occupancyA = await call(
        staffA.cookie,
        "GET",
        `/api/admin/gyms/${gymA.id}/occupancy`,
      );
      assert.equal(occupancyA.status, 200);
      assert.equal(occupancyA.body.gymId, gymA.id);
      assert.equal(occupancyA.body.gymName, "Gym A");
      assert.equal(occupancyA.body.inside, 2, "member and staffA are inside A");
      assert.equal(
        (
          await call(
            staffA.cookie,
            "GET",
            `/api/admin/gyms/${gymB.id}/occupancy`,
          )
        ).body.code,
        "GYM_OUT_OF_SCOPE",
      );
      assert.equal(
        (
          await call(
            owner.cookie,
            "GET",
            `/api/admin/gyms/${gymB.id}/occupancy`,
          )
        ).status,
        200,
      );

      // --- a record closed by an entry elsewhere does not revoke the exit ---
      await redis.del(`og:gate-open:${traveller.id}`);
      assert.equal(
        (await scan(traveller.cookie, outA.qrContent, { lat: 0, lng: 0 }))
          .status,
        200,
        "entered A, then B with the same account: exit at A is still allowed",
      );
      await redis.del(`og:gate-open:${traveller.id}`);
      assert.equal(
        (await scan(traveller.cookie, outA.qrContent, { lat: 0, lng: 0 })).body
          .code,
        "NOT_INSIDE",
        "the marker is single-use",
      );

      // --- gym settings audit records previous and new location + capacity ---
      assert.equal(
        (
          await call(
            owner.cookie,
            "PUT",
            `/api/admin/gyms/${gymA.id}/settings`,
            {
              location: { ...ISTANBUL, radiusM: 900 },
              capacity: 50,
              autoExitHours: 4,
            },
          )
        ).status,
        200,
      );
      const settingsAudit = await db
        .collection("audit_logs")
        .findOne({ action: "gym-settings-updated", gymId: gymA.id });
      assert.equal(settingsAudit?.details.previousLocation.radiusM, 400);
      assert.equal(settingsAudit?.details.location.radiusM, 900);
      assert.equal(settingsAudit?.details.previousCapacity, null);
      assert.equal(settingsAudit?.details.capacity, 50);

      // --- chain summary is owner only ---
      assert.equal(
        (await call(staffA.cookie, "GET", "/api/admin/reports/chain/summary"))
          .status,
        403,
      );
      const summary = await call(
        owner.cookie,
        "GET",
        "/api/admin/reports/chain/summary",
      );
      assert.equal(summary.status, 200);
      assert.equal(summary.body.gyms.length, 2);

      // --- two owners demoting each other at once never leave zero owners ---
      const owner2 = await createUser("owner2", "owner");
      const demotions = await Promise.all([
        call(owner.cookie, "POST", `/api/admin/users/${owner2.id}/role`, {
          role: "admin",
        }),
        call(owner2.cookie, "POST", `/api/admin/users/${owner.id}/role`, {
          role: "admin",
        }),
      ]);
      assert.equal(
        await db.collection("user").countDocuments({ role: "owner" }),
        1,
        `exactly one owner must remain (got ${demotions.map((r) => r.status)})`,
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      await consumer?.stop().catch(() => undefined);
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
