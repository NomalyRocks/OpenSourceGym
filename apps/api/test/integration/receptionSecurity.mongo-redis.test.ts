/* eslint-disable @typescript-eslint/no-explicit-any -- Ad-hoc HTTP response assertions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Collection, ObjectId } from "mongodb";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "reception security: canonical IDs and serialization with deletion",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
    timeout: 30_000,
  },
  async (t) => {
    process.env.MONGODB_URI = `${mongoUri}/opengym_reception_security_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(redisUri!);
    url.pathname = "/13";
    process.env.REDIS_URL = url.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "reception-security-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;
    const [
      { default: express },
      { createServer },
      { WebSocket },
      { auth },
      { db, mongoClient },
      { redis, connectRedis },
      { gymsRouter },
      { deletionRequestsRouter },
      { attachDeviceGateway },
      { ensureIndexes },
      { gateUserLifecycleLockKey, withGateUserLifecycleLock },
      { revokeUserSessions },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("ws"),
      import("../../src/auth/auth.js"),
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/features/gyms/router.js"),
      import("../../src/features/deletionRequests/router.js"),
      import("../../src/features/devices/gateway.js"),
      import("../../src/core/indexes.js"),
      import("../../src/features/gate/locks.js"),
      import("../../src/auth/sessions.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/admin/gyms", gymsRouter);
    app.use("/api/admin", deletionRequestsRouter);
    const server = createServer(app);
    attachDeviceGateway(server);
    const targets: string[] = [];
    let base = "";
    let cookie = "";
    let actorId = "";
    let gymId = "";
    let deviceId = "";
    let socket: InstanceType<typeof WebSocket> | null = null;
    const staffReason = "Phone unavailable during security regression test";
    async function call(path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    }
    async function target(role = "member") {
      const id = new ObjectId();
      targets.push(id.toHexString());
      await db.collection("user").insertOne({
        _id: id,
        name: "Private member name",
        email: `target-${id.toHexString()}@example.com`,
        role,
        gymIds: [],
        createdAt: new Date(),
      });
      return id.toHexString();
    }
    const open = (userId: string, overrides: Record<string, unknown> = {}) =>
      call(`/api/admin/gyms/${gymId}/gate-open`, {
        userId,
        deviceId,
        direction: "in",
        reason: staffReason,
        ...overrides,
      });
    async function requestDeletion(userId: string) {
      const row = await db.collection("deletion_requests").insertOne({
        userId: new ObjectId(userId),
        status: "pending",
        requestedAt: new Date(),
      });
      return () =>
        call(
          `/api/admin/deletion-requests/${row.insertedId.toHexString()}/approve`,
          {},
        );
    }
    try {
      await mongoClient.connect();
      await connectRedis();
      await ensureIndexes();
      server.listen(0);
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const email = `security-owner-${randomUUID()}@example.com`;
      const signup = await auth.api.signUpEmail({
        body: {
          email,
          password: "test-password-1234",
          name: "Security owner",
          firstName: "Security",
          lastName: "Owner",
          phone: "5399876543",
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      actorId = signup.user.id;
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(actorId) },
          { $set: { role: "owner", emailVerified: true } },
        );
      const signin = await auth.api.signInEmail({
        body: { email, password: "test-password-1234" },
        returnHeaders: true,
      });
      cookie = signin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      assert.ok(cookie);
      const gym = await call("/api/admin/gyms", {
        name: "Reception security gym",
      });
      assert.equal(gym.status, 201);
      gymId = gym.body.id;
      const device = await call(`/api/admin/gyms/${gymId}/devices`, {
        name: "Security turnstile",
        direction: "both",
      });
      assert.equal(device.status, 200);
      deviceId = device.body.id;
      socket = new WebSocket(
        `${base.replace("http", "ws")}/api/device-gateway`,
      );
      await once(socket, "open");
      socket.send(
        JSON.stringify({ type: "auth", deviceId, token: device.body.token }),
      );
      const [raw] = (await once(socket, "message")) as [Buffer];
      assert.equal(JSON.parse(raw.toString()).type, "auth_ok");

      await t.test(
        "uppercase and malformed requests cannot bypass sharing or store noncanonical IDs",
        async () => {
          const id = await target();
          await redis.set(`og:qr-block:${id}`, "1");
          const refused = await open(id.toUpperCase(), {
            deviceId: deviceId.toUpperCase(),
          });
          assert.equal(refused.status, 403);
          assert.equal(refused.body.code, "SHARING_BLOCKED");
          const invalid = await open(id.toUpperCase(), {
            deviceId: deviceId.toUpperCase(),
            direction: "invalid",
          });
          assert.equal(invalid.status, 400);
          const events = await db
            .collection("entry_events")
            .find({ actorId })
            .toArray();
          assert.equal(events.length, 2);
          for (const event of events) {
            assert.equal(event.userId, id);
            assert.equal(event.deviceId, deviceId);
          }
          const audits = await db
            .collection("audit_logs")
            .find({ action: "gate-open-refused", targetId: id })
            .toArray();
          assert.equal(audits.length, 2);
          assert.ok(
            audits.every((audit) => audit.details.deviceId === deviceId),
          );
          assert.equal(
            await redis.exists(`og:gate-open:${id.toUpperCase()}`),
            0,
          );
        },
      );

      await t.test(
        "uppercase device and user IDs share the passage lease and online gateway registry",
        async () => {
          const id = await target("owner");
          const entryCommand = once(socket!, "message");
          assert.equal((await open(id)).status, 200);
          await entryCommand;
          const duplicate = await open(id.toUpperCase(), {
            deviceId: deviceId.toUpperCase(),
            direction: "out",
          });
          assert.equal(duplicate.status, 429);
          assert.equal(duplicate.body.code, "RATE_LIMITED");
          await redis.del(`og:gate-open:${id}`);
          const exitCommand = once(socket!, "message");
          assert.equal(
            (
              await open(id.toUpperCase(), {
                deviceId: deviceId.toUpperCase(),
                direction: "out",
              })
            ).status,
            200,
          );
          const [exit] = (await exitCommand) as [Buffer];
          assert.equal(JSON.parse(exit.toString()).side, "out");
          const rows = await db
            .collection("entry_events")
            .find({ userId: id })
            .toArray();
          assert.equal(rows.length, 3);
          assert.ok(rows.every((row) => row.deviceId === deviceId));
          assert.equal(
            await db
              .collection("entry_events")
              .countDocuments({ userId: id.toUpperCase() }),
            0,
          );
        },
      );

      await t.test(
        "frozen entry can take its subscription lock inside the lifecycle lock",
        async () => {
          const id = await target();
          const startedAt = new Date(Date.now() - 86_400_000);
          await db.collection("subscriptions").insertOne({
            userId: new ObjectId(id),
            gymIds: [new ObjectId(gymId)],
            startsAt: new Date(Date.now() - 2 * 86_400_000),
            endsAt: new Date(Date.now() + 86_400_000),
            createdBy: actorId,
            createdAt: new Date(),
          });
          await db.collection("subscription_freezes").insertOne({
            userId: new ObjectId(id),
            startedAt,
            startedBy: actorId,
            maxDays: 30,
            endedAt: null,
            endedBy: null,
            endReason: null,
            creditedMs: null,
            plan: null,
            creditApplied: false,
          });
          const command = once(socket!, "message");
          const result = await open(id);
          assert.equal(result.status, 200);
          assert.equal(result.body.unfrozen, true);
          await command;
        },
      );

      await t.test(
        "deletion waits for an in-flight reception audit, then erases all target data",
        async (t) => {
          const id = await target();
          await redis.set(`og:qr-block:${id}`, "1");
          const approve = await requestDeletion(id);
          const auditing = signal();
          const releaseAudit = signal();
          const originalInsert = Collection.prototype.insertOne;
          t.mock.method(
            Collection.prototype,
            "insertOne",
            async function (
              this: Collection,
              ...args: Parameters<typeof originalInsert>
            ) {
              if (
                this.collectionName === "audit_logs" &&
                args[0].action === "gate-open-refused" &&
                args[0].targetId === id
              ) {
                auditing.resolve();
                await releaseAudit.promise;
              }
              return originalInsert.apply(this, args);
            },
          );
          const blocked = signal();
          const originalSet = redis.set;
          t.mock.method(
            redis,
            "set",
            async (...args: Parameters<typeof originalSet>) => {
              const result = await originalSet.apply(redis, args);
              if (args[0] === gateUserLifecycleLockKey(id) && result === null)
                blocked.resolve();
              return result;
            },
          );
          const opening = open(id.toUpperCase(), {
            deviceId: deviceId.toUpperCase(),
          });
          assert.equal(
            await Promise.race([
              auditing.promise.then(() => "auditing"),
              opening.then(() => "finished"),
            ]),
            "auditing",
          );
          const approval = approve();
          try {
            assert.equal(
              await Promise.race([
                blocked.promise.then(() => "waiting"),
                approval.then(() => "deleted"),
              ]),
              "waiting",
            );
            assert.ok(
              await db.collection("user").findOne({ _id: new ObjectId(id) }),
            );
          } finally {
            releaseAudit.resolve();
            await Promise.all([opening, approval]);
          }
          assert.equal((await opening).body.code, "SHARING_BLOCKED");
          assert.equal((await approval).status, 200);
          assert.equal(
            await db.collection("user").findOne({ _id: new ObjectId(id) }),
            null,
          );
          const row = await db.collection("entry_events").findOne({
            deviceId,
            actorId,
            reason: "SHARING_BLOCKED",
            userId: null,
          });
          assert.ok(row);
          assert.equal(row.memberName, null);
          assert.equal(row.staffReason, null);
          const audit = await db
            .collection("audit_logs")
            .findOne({ targetId: id, action: "gate-open-refused" });
          assert.ok(audit);
          assert.equal(Object.hasOwn(audit.details, "staffReason"), false);
          assert.equal(
            await db
              .collection("entry_events")
              .countDocuments({ userId: { $in: [id, id.toUpperCase()] } }),
            0,
          );
        },
      );

      await t.test(
        "a gate request waiting behind deletion re-reads the missing target and logs no PII",
        async (t) => {
          const id = await target();
          const approve = await requestDeletion(id);
          const deleting = signal();
          const releaseDelete = signal();
          const originalDelete = Collection.prototype.deleteOne;
          t.mock.method(
            Collection.prototype,
            "deleteOne",
            async function (
              this: Collection,
              ...args: Parameters<typeof originalDelete>
            ) {
              if (
                this.collectionName === "user" &&
                args[0]?._id?.equals(new ObjectId(id))
              ) {
                deleting.resolve();
                await releaseDelete.promise;
              }
              return originalDelete.apply(this, args);
            },
          );
          const blocked = signal();
          const originalSet = redis.set;
          t.mock.method(
            redis,
            "set",
            async (...args: Parameters<typeof originalSet>) => {
              const result = await originalSet.apply(redis, args);
              if (args[0] === gateUserLifecycleLockKey(id) && result === null)
                blocked.resolve();
              return result;
            },
          );
          const approval = approve();
          assert.equal(
            await Promise.race([
              deleting.promise.then(() => "deleting"),
              approval.then(() => "finished"),
            ]),
            "deleting",
          );
          const opening = open(id.toUpperCase(), {
            deviceId: deviceId.toUpperCase(),
          });
          try {
            assert.equal(
              await Promise.race([
                blocked.promise.then(() => "waiting"),
                opening.then(() => "finished"),
              ]),
              "waiting",
            );
          } finally {
            releaseDelete.resolve();
            await Promise.all([opening, approval]);
          }
          assert.equal((await approval).status, 200);
          assert.equal((await opening).status, 404);
          assert.equal((await opening).body.code, "USER_NOT_FOUND");
          const audit = await db.collection("audit_logs").findOne({
            action: "gate-open-refused",
            "details.code": "USER_NOT_FOUND",
          });
          assert.ok(audit);
          assert.equal(audit.targetId, null);
          assert.equal(audit.details.staffReason, null);
          const row = await db.collection("entry_events").findOne({
            actorId,
            allowed: false,
            reason: null,
            staffReason: null,
            deviceId,
          });
          assert.ok(row);
          assert.equal(row.userId, null);
          assert.equal(row.memberName, null);
        },
      );

      await t.test(
        "lifecycle timeout refuses passage with an anonymous event and audit",
        async () => {
          const id = await target();
          await withGateUserLifecycleLock(id, async () => {
            const result = await open(id.toUpperCase(), {
              deviceId: deviceId.toUpperCase(),
            });
            assert.equal(result.status, 503);
            assert.equal(result.body.code, "SUBSCRIPTION_BUSY");
          });
          const audit = await db.collection("audit_logs").findOne({
            action: "gate-open-refused",
            "details.code": "SUBSCRIPTION_BUSY",
          });
          assert.ok(audit);
          assert.equal(audit.targetId, null);
          assert.equal(audit.details.staffReason, null);
          assert.equal(
            await db.collection("entry_events").countDocuments({ userId: id }),
            0,
          );
        },
      );
    } finally {
      socket?.terminate();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const id of [...targets, actorId].filter(Boolean))
        await redis
          .del([
            `og:gate-open:${id}`,
            `og:lock:gate-open:${id}`,
            `og:qr-block:${id}`,
            `og:gate-cooldown:${gymId}:${id}`,
          ])
          .catch(() => {});
      if (gymId) await redis.del(`og:inside:${gymId}`).catch(() => {});
      if (actorId) await revokeUserSessions(actorId).catch(() => {});
      await db.dropDatabase().catch(() => {});
      await redis.quit().catch(() => {});
      await mongoClient.close();
    }
  },
);
