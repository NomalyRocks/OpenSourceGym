/* eslint-disable @typescript-eslint/no-explicit-any -- Ad-hoc HTTP response assertions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "reception gate access, controls, provenance, rate limiting and erasure",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async (t) => {
    process.env.MONGODB_URI = `${mongoUri}/opengym_reception_${randomUUID().replaceAll("-", "")}`;
    // Sibling integration files call flushDb() on TEST_REDIS_URL in parallel;
    // a dedicated logical DB keeps this file's locks and counters intact.
    const url = new URL(redisUri!);
    url.pathname = "/2";
    process.env.REDIS_URL = url.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "reception-integration-secret-at-least-32-characters";
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
      { gateScanRouter },
      { attachDeviceGateway },
      { markInside },
      { ensureIndexes },
      { isGateOpenRateLimited },
      { acquirePassageLock, releasePassageLock },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("ws"),
      import("../../src/auth/auth.js"),
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/features/gyms/router.js"),
      import("../../src/features/deletionRequests/router.js"),
      import("../../src/features/gate/router.js"),
      import("../../src/features/devices/gateway.js"),
      import("../../src/features/gyms/occupancy.js"),
      import("../../src/core/indexes.js"),
      import("../../src/features/gate/locks.js"),
      import("../../src/features/gate/locks.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/admin/gyms", gymsRouter);
    app.use("/api/admin", deletionRequestsRouter);
    app.use("/api/me", gateScanRouter);
    const server = createServer(app);
    attachDeviceGateway(server);
    const sockets: InstanceType<typeof WebSocket>[] = [];
    let phoneCounter = 0;
    const createdUsers: string[] = [];
    const gymIds: string[] = [];
    async function createUser(role: string) {
      phoneCounter++;
      const email = `reception-${randomUUID()}@example.com`;
      const signup = await auth.api.signUpEmail({
        body: {
          email,
          password: "test-password-1234",
          name: `Reception ${role}`,
          firstName: "Reception",
          lastName: role,
          phone: `539${String(phoneCounter).padStart(7, "0")}`,
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      createdUsers.push(signup.user.id);
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(signup.user.id) },
          { $set: { role, emailVerified: true } },
        );
      const signin = await auth.api.signInEmail({
        body: { email, password: "test-password-1234" },
        returnHeaders: true,
      });
      const cookie = signin.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return { id: signup.user.id, cookie };
    }
    let base = "";
    async function call(
      cookie: string,
      method: string,
      path: string,
      body?: unknown,
    ) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    }
    try {
      await mongoClient.connect();
      await connectRedis();
      await ensureIndexes();
      server.listen(0);
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const owner = await createUser("owner");
      const staff = await createUser("staff");
      const member = await createUser("member");
      const noSub = await createUser("member");
      const otherStaff = await createUser("staff");
      const limiter = await createUser("staff");
      const gymA = await call(owner.cookie, "POST", "/api/admin/gyms", {
        name: "Reception A",
      });
      const gymB = await call(owner.cookie, "POST", "/api/admin/gyms", {
        name: "Reception B",
      });
      assert.equal(gymA.status, 201);
      assert.equal(gymB.status, 201);
      const gymId = gymA.body.id as string;
      gymIds.push(gymId, gymB.body.id);
      for (const actor of [staff, limiter])
        await db
          .collection("user")
          .updateOne(
            { _id: new ObjectId(actor.id) },
            { $set: { gymIds: [gymId] } },
          );
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(otherStaff.id) },
          { $set: { gymIds: [gymB.body.id] } },
        );
      const route = `/api/admin/gyms/${gymId}`;
      const deviceResult = await call(
        owner.cookie,
        "POST",
        `${route}/devices`,
        { name: "Reception both", direction: "both" },
      );
      const single = await call(owner.cookie, "POST", `${route}/devices`, {
        name: "Entry only",
        direction: "in",
      });
      const foreign = await call(
        owner.cookie,
        "POST",
        `/api/admin/gyms/${gymB.body.id}/devices`,
        { name: "Other gym", direction: "in" },
      );
      assert.equal(deviceResult.status, 200);
      const device = deviceResult.body;
      const socket = new WebSocket(
        `${base.replace("http", "ws")}/api/device-gateway`,
      );
      sockets.push(socket);
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "auth",
          deviceId: device.id,
          token: device.token,
        }),
      );
      const [raw] = (await once(socket, "message")) as [Buffer];
      assert.equal(JSON.parse(raw.toString()).type, "auth_ok");
      const reason = "Phone unavailable";
      const open = (
        actor = staff,
        target = member,
        overrides: Record<string, unknown> = {},
      ) =>
        call(actor.cookie, "POST", `${route}/gate-open`, {
          userId: target.id,
          deviceId: device.id,
          direction: "in",
          reason,
          ...overrides,
        });
      await t.test(
        "authorization uses fresh gym scope and rejects member actors",
        async () => {
          assert.equal(
            (
              await call(
                staff.cookie,
                "POST",
                `/api/admin/gyms/${gymB.body.id}/gate-open`,
                {
                  userId: member.id,
                  deviceId: foreign.body.id,
                  direction: "in",
                  reason,
                },
              )
            ).body.code,
            "GYM_OUT_OF_SCOPE",
          );
          assert.equal((await open(member)).status, 403);
          assert.equal(
            (await call(member.cookie, "GET", `${route}/gate-devices`)).status,
            403,
          );
        },
      );
      await t.test("safe device summaries expose no credentials", async () => {
        const list = await call(staff.cookie, "GET", `${route}/gate-devices`);
        assert.equal(list.status, 200);
        assert.equal(list.body.length, 2);
        for (const row of list.body)
          assert.deepEqual(Object.keys(row).sort(), [
            "direction",
            "id",
            "name",
            "online",
          ]);
        assert.equal(
          list.body.find((row: any) => row.id === device.id).online,
          true,
        );
        assert.equal(
          list.body.find((row: any) => row.id === single.body.id).online,
          false,
        );
        assert.equal(
          (await call(staff.cookie, "GET", `${route}/devices`)).status,
          403,
        );
      });
      await t.test(
        "device membership, direction, reason and target validation",
        async () => {
          const foreignResult = await open(staff, member, {
            deviceId: foreign.body.id,
          });
          assert.equal(foreignResult.status, 404);
          assert.equal(foreignResult.body.code, "DEVICE_NOT_FOUND");
          const wrongDirection = await open(staff, member, {
            deviceId: single.body.id,
            direction: "out",
          });
          assert.equal(wrongDirection.status, 400);
          assert.equal(wrongDirection.body.code, "INVALID_DIRECTION");
          assert.equal(
            (await open(staff, member, { reason: "  " })).status,
            400,
          );
          assert.equal(
            (await open(staff, member, { reason: "x".repeat(201) })).status,
            400,
          );
          assert.equal(
            (
              await open(staff, member, {
                userId: new ObjectId().toHexString(),
              })
            ).body.code,
            "USER_NOT_FOUND",
          );
        },
      );
      await t.test(
        "no subscription refusal is logged and audited",
        async () => {
          const refused = await open(staff, noSub);
          assert.equal(refused.status, 403);
          assert.equal(refused.body.code, "NO_ACTIVE_SUBSCRIPTION");
          const event = await db
            .collection("entry_events")
            .findOne({ userId: noSub.id, source: "reception" });
          assert.equal(event?.reason, "NO_ACTIVE_SUBSCRIPTION");
          assert.ok(event && !Object.hasOwn(event, "code"));
          assert.equal(event?.actorId, staff.id);
          assert.equal(event?.staffReason, reason);
          const audit = await db
            .collection("audit_logs")
            .findOne({ targetId: noSub.id, action: "gate-open-refused" });
          assert.equal(audit?.gymId, gymId);
          assert.equal(audit?.details.code, "NO_ACTIVE_SUBSCRIPTION");
          assert.equal(audit?.details.staffReason, reason);
        },
      );
      await db.collection("subscriptions").insertOne({
        userId: new ObjectId(member.id),
        gymIds: [new ObjectId(gymId)],
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        createdBy: owner.id,
        createdAt: new Date(),
      });
      await t.test(
        "successful entry skips unset location, sends relay command and records provenance",
        async () => {
          const command = once(socket, "message");
          const opened = await open(staff, member, { reason: `  ${reason}  ` });
          assert.equal(opened.status, 200);
          assert.equal(opened.body.direction, "in");
          const [message] = (await command) as [Buffer];
          assert.equal(JSON.parse(message.toString()).side, "in");
          const event = await db
            .collection("entry_events")
            .findOne({ userId: member.id, allowed: true });
          assert.equal(event?.source, "reception");
          assert.equal(event?.actorId, staff.id);
          assert.equal(event?.actorName, "Reception staff");
          assert.equal(event?.staffReason, reason);
          assert.equal(event?.reason, null);
          assert.ok(event && !Object.hasOwn(event, "code"));
          assert.equal(event?.distanceM, null);
          const audit = await db
            .collection("audit_logs")
            .findOne({ targetId: member.id, action: "gate-opened-by-staff" });
          assert.equal(audit?.gymId, gymId);
          assert.equal(audit?.details.staffReason, reason);
          assert.equal(Object.hasOwn(audit!.details, "reason"), false);
          assert.equal(audit?.details.code, null);
        },
      );
      await t.test(
        "anti-passback, bans, inactive gyms and sharing blocks still apply only to entry",
        async () => {
          assert.equal((await open()).body.code, "ALREADY_INSIDE");
          await db.collection("user").updateOne(
            { _id: new ObjectId(member.id) },
            {
              $set: {
                ban: {
                  reason: "Test ban",
                  bannedAt: new Date(),
                  bannedBy: owner.id,
                },
              },
            },
          );
          assert.equal((await open()).body.code, "BANNED");
          await db
            .collection("gyms")
            .updateOne(
              { _id: new ObjectId(gymId) },
              { $set: { active: false } },
            );
          await redis.set(`og:qr-block:${member.id}`, "1");
          await redis.del(`og:gate-open:${member.id}`);
          assert.equal(
            (await open(staff, member, { direction: "out" })).status,
            200,
          );
          await db
            .collection("user")
            .updateOne(
              { _id: new ObjectId(member.id) },
              { $unset: { ban: "" } },
            );
          assert.equal((await open()).body.code, "GYM_INACTIVE");
          await db
            .collection("gyms")
            .updateOne(
              { _id: new ObjectId(gymId) },
              { $set: { active: true } },
            );
          assert.equal((await open()).body.code, "SHARING_BLOCKED");
          await redis.del(`og:qr-block:${member.id}`);
          assert.equal((await open()).body.code, "ENTRY_COOLDOWN");
        },
      );
      await t.test(
        "the passing colleague's scope determines subscription bypass",
        async () => {
          assert.equal(
            (await open(staff, otherStaff)).body.code,
            "NO_ACTIVE_SUBSCRIPTION",
          );
          assert.equal((await open(owner, staff)).status, 200);
        },
      );
      await t.test(
        "QR refusals preserve reason and queue null staffReason without code",
        async () => {
          const refused = await call(
            member.cookie,
            "POST",
            "/api/me/gate-scan",
            { qr: "invalid" },
          );
          assert.equal(refused.body.code, "INVALID_QR");
          const queued = await redis.lRange("og:entry-events", 0, -1);
          const raw = queued.find((value) => {
            const event = JSON.parse(value);
            return event.userId === member.id && event.source === "qr";
          });
          assert.ok(raw);
          const event = JSON.parse(raw);
          assert.equal(event.reason, "INVALID_QR");
          assert.equal(event.staffReason, null);
          assert.equal(Object.hasOwn(event, "code"), false);
          await redis.lRem("og:entry-events", 1, raw);
        },
      );
      await t.test(
        "source filters include legacy QR rows and separate reception explanations",
        async () => {
          await db.collection("entry_events").insertOne({
            gymId,
            deviceId: device.id,
            deviceName: "Legacy",
            userId: member.id,
            memberName: "Legacy",
            allowed: false,
            reason: "BANNED",
            at: new Date(),
          });
          const qr = await call(
            staff.cookie,
            "GET",
            `${route}/entry-events?source=qr`,
          );
          assert.equal(qr.body.items.length, 1);
          assert.equal(qr.body.items[0].source, "qr");
          assert.equal(qr.body.items[0].reason, "BANNED");
          assert.equal(qr.body.items[0].staffReason, null);
          assert.equal(Object.hasOwn(qr.body.items[0], "code"), false);
          const reception = await call(
            staff.cookie,
            "GET",
            `${route}/entry-events?source=reception`,
          );
          assert.ok(reception.body.items.length > 0);
          assert.ok(
            reception.body.items.every(
              (item: any) =>
                item.source === "reception" && !Object.hasOwn(item, "code"),
            ),
          );
          const refusal = reception.body.items.find(
            (item: any) => item.reason === "NO_ACTIVE_SUBSCRIPTION",
          );
          assert.ok(refusal);
          assert.equal(refusal.staffReason, reason);
          const invalidDirection = await db.collection("audit_logs").findOne({
            targetId: member.id,
            "details.code": "INVALID_DIRECTION",
          });
          assert.equal(invalidDirection?.details.staffReason, reason);
        },
      );
      await t.test(
        "31st actor request is refused and audited with a fixed ten-minute expiry",
        async () => {
          for (let index = 0; index < 30; index++)
            assert.equal(
              (await open(limiter, noSub)).body.code,
              "NO_ACTIVE_SUBSCRIPTION",
            );
          const throttled = await open(limiter, noSub);
          assert.equal(throttled.status, 429);
          assert.equal(throttled.body.code, "RATE_LIMITED");
          const event = await db
            .collection("entry_events")
            .findOne({ actorId: limiter.id, reason: "RATE_LIMITED" });
          assert.equal(event?.staffReason, reason);
          assert.ok(event && !Object.hasOwn(event, "code"));
          assert.equal(await redis.get(`og:gate-open:${limiter.id}`), "31");
          assert.ok((await redis.ttl(`og:gate-open:${limiter.id}`)) > 0);
          assert.equal(
            await db
              .collection("entry_events")
              .countDocuments({ actorId: limiter.id }),
            31,
          );
          assert.equal(
            await db.collection("audit_logs").countDocuments({
              actorId: limiter.id,
              action: "gate-open-refused",
            }),
            31,
          );
        },
      );
      await t.test(
        "actor counters preserve a live passage lease across QR and reception",
        async () => {
          const id = new ObjectId().toHexString();
          createdUsers.push(id);
          assert.equal(await acquirePassageLock(id, "uuid-lease", 3000), true);
          assert.equal(await isGateOpenRateLimited(id), false);
          assert.equal(await redis.get(`og:gate-open:${id}`), "1");
          assert.equal(
            await acquirePassageLock(id, "second-lease", 3000),
            false,
          );
          await releasePassageLock(id, "uuid-lease");
          assert.equal(
            await acquirePassageLock(id, "second-lease", 3000),
            true,
          );
          await releasePassageLock(id, "second-lease");
          assert.equal(await redis.get(`og:gate-open:${id}`), "1");
        },
      );
      await t.test(
        "deletion approval clears reception reasons from retained history and audits",
        async () => {
          const eventIds = await db
            .collection("entry_events")
            .find(
              { userId: member.id, source: "reception" },
              { projection: { _id: 1, reason: 1 } },
            )
            .toArray();
          const request = await db.collection("deletion_requests").insertOne({
            userId: new ObjectId(member.id),
            email: "member@example.com",
            name: "Member",
            status: "pending",
            requestedAt: new Date(),
            reason: "Erase my account",
          });
          assert.equal(
            (
              await call(
                owner.cookie,
                "POST",
                `/api/admin/deletion-requests/${request.insertedId.toHexString()}/approve`,
              )
            ).status,
            200,
          );
          const events = await db
            .collection("entry_events")
            .find({ _id: { $in: eventIds.map((event) => event._id) } })
            .toArray();
          assert.ok(events.length > 0);
          assert.ok(
            events.every(
              (event) =>
                event.staffReason === null &&
                event.reason ===
                  eventIds.find((original) => original._id.equals(event._id))
                    ?.reason &&
                event.userId === null &&
                event.memberName === null,
            ),
          );
          const audits = await db
            .collection("audit_logs")
            .find({
              targetId: member.id,
              action: { $in: ["gate-opened-by-staff", "gate-open-refused"] },
            })
            .toArray();
          assert.ok(audits.length > 0);
          assert.ok(
            audits.every(
              (audit) => !Object.hasOwn(audit.details, "staffReason"),
            ),
          );
          assert.ok(audits.some((audit) => audit.details.code === "BANNED"));
        },
      );
      // Keep the occupancy helper exercised for a no-subscription exit as well.
      await markInside(gymId, noSub.id);
      assert.equal(
        (await open(owner, noSub, { direction: "out" })).status,
        200,
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const id of createdUsers)
        await redis
          .del([
            `og:gate-open:${id}`,
            `og:lock:gate-open:${id}`,
            `og:qr-block:${id}`,
          ])
          .catch(() => {});
      for (const id of gymIds)
        await redis.del(`og:inside:${id}`).catch(() => {});
      await db.dropDatabase().catch(() => {});
      await redis.quit().catch(() => {});
      await mongoClient.close();
    }
  },
);
