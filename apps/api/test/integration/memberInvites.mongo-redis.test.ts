/* eslint-disable @typescript-eslint/no-explicit-any -- Ad-hoc HTTP response assertions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import nodemailer from "nodemailer";
import { ObjectId } from "mongodb";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "member invite lifecycle, consent, verification, authorization and privacy",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async (t) => {
    process.env.NODE_ENV = "test";
    process.env.MONGODB_URI = `${mongoUri}/opengym_invites_${randomUUID().replaceAll("-", "")}`;
    // Sibling integration files call flushDb() on TEST_REDIS_URL in parallel;
    // a dedicated logical DB keeps this file's locks and counters intact.
    const redisUrl = new URL(redisUri!);
    redisUrl.pathname = "/7";
    process.env.REDIS_URL = redisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "member-invite-test-secret-at-least-32-characters";
    process.env.PUBLIC_WEB_URL = "http://localhost:5173";
    process.env.SMTP_HOST = "smtp.example.com";
    const messages: { to: string; subject: string; text: string }[] = [];
    const sendMail = t.mock.fn(async (mail: (typeof messages)[number]) => {
      messages.push(mail);
    });
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail }) as never);
    const [
      { default: express },
      { createServer },
      { toNodeHandler },
      { auth },
      { db, mongoClient, chainSettingsCollection },
      { redis, connectRedis },
      { gymsRouter },
      { publicInvitesRouter },
      { ensureIndexes },
      { hashInviteToken, memberInvites, newInviteToken },
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("better-auth/node"),
      import("../../src/auth/auth.js"),
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/features/gyms/router.js"),
      import("../../src/features/invites/router.js"),
      import("../../src/core/indexes.js"),
      import("../../src/features/invites/invites.js"),
    ]);
    const app = express();
    app.all("/api/auth/{*splat}", toNodeHandler(auth));
    app.use(express.json());
    app.use("/api/admin/gyms", gymsRouter);
    app.use("/api/invites", publicInvitesRouter);
    app.use(
      (
        _error: unknown,
        _req: import("express").Request,
        res: import("express").Response,
        _next: import("express").NextFunction,
      ) => {
        void _next;
        res.status(500).json({ code: "INTERNAL_ERROR" });
      },
    );
    const server = createServer(app);
    const gym = new ObjectId();
    const otherGym = new ObjectId();
    const invitePath = `/api/admin/gyms/${gym}/invites`;
    let base = "";
    let contactCounter = 0;
    let staff: { id: string; cookie: string };
    let member: { id: string; cookie: string };
    let outsider: { id: string; cookie: string };
    const contacts = () => ({
      email: `invite-${randomUUID()}@example.com`,
      firstName: "Alex",
      lastName: "Member",
      phone: `+90539${String(++contactCounter).padStart(7, "0")}`,
    });
    const context = await auth.$context;
    async function caller(role: string, gymIds: string[]) {
      const data = contacts();
      const result = await auth.api.signUpEmail({
        body: {
          ...data,
          name: `${data.firstName} ${data.lastName}`,
          password: "password-1234",
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      await context.internalAdapter.updateUser(result.user.id, {
        role,
        emailVerified: true,
      } as never);
      // gymIds is not a BetterAuth field; the adapter drops it, so write it
      // the way the gym-assignment route does.
      await db
        .collection("user")
        .updateOne({ _id: new ObjectId(result.user.id) }, { $set: { gymIds } });
      const signin = await auth.api.signInEmail({
        body: { email: data.email, password: "password-1234" },
        returnHeaders: true,
      });
      const cookie = signin.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return { id: result.user.id, cookie };
    }
    async function call(
      method: string,
      path: string,
      body?: unknown,
      cookie = "",
    ) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as any,
        headers: response.headers,
      };
    }
    function tokenFor(email: string) {
      const mail = [...messages]
        .reverse()
        .find((message) => message.to === email);
      assert.ok(mail);
      const token = mail.text.match(/\/invite#token=([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);
      return token;
    }
    async function create() {
      const data = contacts();
      const result = await call("POST", invitePath, data, staff.cookie);
      assert.equal(result.status, 201);
      assert.equal(result.body.email, data.email);
      return {
        data,
        id: new ObjectId(result.body.id),
        token: tokenFor(data.email),
      };
    }
    const acceptBody = (token: string, legalVersion = 4) => ({
      token,
      password: "new-password-1234",
      dataProcessingAccepted: true,
      privacyAccepted: true,
      legalVersion,
    });
    async function resetLimits() {
      const keys = await redis.keys("og:invite-*");
      if (keys.length) await redis.del(keys);
    }
    try {
      await mongoClient.connect();
      await connectRedis();
      await ensureIndexes();
      await chainSettingsCollection().insertOne({
        _id: "chain",
        chainName: "Test Fitness",
        legal: {
          dataProcessingUrl: "https://example.com/data",
          privacyUrl: "https://example.com/privacy",
          version: 4,
        },
      });
      for (const id of [gym, otherGym])
        await db.collection("gyms").insertOne({
          _id: id,
          name: "Invite gym",
          active: true,
          location: null,
          capacity: null,
          autoExitHours: 3,
          createdAt: new Date(),
          createdBy: "test",
        });
      staff = await caller("staff", [gym.toHexString()]);
      member = await caller("member", []);
      outsider = await caller("staff", [otherGym.toHexString()]);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      await t.test(
        "normal signup stamps the current legal version and still sends OTP",
        async () => {
          const stored = await db
            .collection("user")
            .findOne({ _id: new ObjectId(member.id) });
          assert.equal(stored?.legalVersionAccepted, 4);
          assert.equal(stored?.dataProcessingAccepted, true);
          assert.ok(stored?.dataProcessingAcceptedAt instanceof Date);
          assert.ok(sendMail.mock.callCount() >= 3);
          assert.ok(messages.some((mail) => /\d{6}/.test(mail.text)));
        },
      );
      await t.test("create uses live role and gym authorization", async () => {
        assert.equal(
          (await call("POST", invitePath, contacts(), member.cookie)).status,
          403,
        );
        const forbidden = await call(
          "POST",
          invitePath,
          contacts(),
          outsider.cookie,
        );
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.body.code, "GYM_OUT_OF_SCOPE");
        assert.equal((await call("POST", invitePath, contacts())).status, 401);
      });
      await t.test(
        "create normalizes contact data, rejects conflicts and audits no contact details",
        async () => {
          const data = contacts();
          const result = await call(
            "POST",
            invitePath,
            {
              ...data,
              email: ` ${data.email.toUpperCase()} `,
              phone: data.phone.slice(3),
            },
            staff.cookie,
          );
          assert.equal(result.status, 201);
          const invite = await memberInvites().findOne({
            _id: new ObjectId(result.body.id),
          });
          assert.ok(invite);
          assert.equal(invite.email, data.email);
          assert.equal(invite.phone, data.phone);
          assert.equal(
            await db.collection("user").countDocuments({ email: data.email }),
            0,
          );
          assert.equal(
            invite.expiresAt.getTime() - invite.createdAt.getTime(),
            7 * 86400000,
          );
          assert.equal("token" in invite, false);
          assert.match(invite.tokenHash, /^[a-f0-9]{64}$/);
          assert.equal(
            (await call("POST", invitePath, data, staff.cookie)).body.code,
            "INVITE_EXISTS",
          );
          const existing = await db
            .collection("user")
            .findOne({ _id: new ObjectId(member.id) });
          assert.equal(
            (
              await call(
                "POST",
                invitePath,
                { ...contacts(), email: existing!.email },
                staff.cookie,
              )
            ).body.code,
            "EMAIL_TAKEN",
          );
          assert.equal(
            (
              await call(
                "POST",
                invitePath,
                { ...contacts(), phone: existing!.phone },
                staff.cookie,
              )
            ).body.code,
            "PHONE_ALREADY_EXISTS",
          );
          const audit = await db
            .collection("audit_logs")
            .findOne({ action: "invite-created", targetId: result.body.id });
          assert.ok(audit);
          assert.equal(audit.gymId, gym.toHexString());
          assert.equal(audit.details, null);
          for (const value of [
            data.email,
            data.firstName,
            data.lastName,
            data.phone,
          ])
            assert.equal(JSON.stringify(audit).includes(value), false);
        },
      );
      await t.test(
        "create atomically limits each actor to twenty requests per hour",
        async () => {
          await redis.set(`og:invite-create:${staff.id}`, "20", {
            expiration: { type: "EX", value: 3600 },
          });
          const result = await call(
            "POST",
            invitePath,
            contacts(),
            staff.cookie,
          );
          assert.equal(result.status, 429);
          assert.equal(result.body.code, "RATE_LIMITED");
          assert.ok((await redis.ttl(`og:invite-create:${staff.id}`)) > 0);
          await resetLimits();
        },
      );
      await t.test(
        "list and mutations hide invites from another gym",
        async () => {
          const invite = await create();
          const otherPath = `/api/admin/gyms/${otherGym}/invites`;
          assert.deepEqual(
            (await call("GET", otherPath, undefined, outsider.cookie)).body,
            [],
          );
          for (const [method, suffix] of [
            ["POST", "/resend"],
            ["DELETE", ""],
          ]) {
            assert.equal(
              (
                await call(
                  method!,
                  `${otherPath}/${invite.id}${suffix}`,
                  undefined,
                  outsider.cookie,
                )
              ).status,
              404,
            );
          }
          const list = await call("GET", invitePath, undefined, staff.cookie);
          assert.ok(
            list.body.some(
              (row: any) =>
                row.id === invite.id.toHexString() &&
                row.createdByName === "Alex Member",
            ),
          );
          assert.equal(JSON.stringify(list.body).includes("tokenHash"), false);
          assert.equal(
            list.body.some((row: any) => "phone" in row),
            false,
          );
        },
      );
      await t.test(
        "resend enforces spacing, rotates the token and caps resends",
        async () => {
          const invite = await create();
          assert.equal(
            (
              await call(
                "POST",
                `${invitePath}/${invite.id}/resend`,
                undefined,
                staff.cookie,
              )
            ).status,
            429,
          );
          await memberInvites().updateOne(
            { _id: invite.id },
            { $set: { createdAt: new Date(Date.now() - 61000) } },
          );
          const resent = await call(
            "POST",
            `${invitePath}/${invite.id}/resend`,
            undefined,
            staff.cookie,
          );
          assert.equal(resent.status, 200);
          assert.equal(resent.body.resendCount, 1);
          const rotated = tokenFor(invite.data.email);
          assert.notEqual(rotated, invite.token);
          assert.equal(
            (await call("POST", "/api/invites/lookup", { token: invite.token }))
              .body.code,
            "INVITE_INVALID",
          );
          assert.equal(
            (await call("POST", "/api/invites/lookup", { token: rotated }))
              .status,
            200,
          );
          assert.equal(
            (
              await call(
                "POST",
                `${invitePath}/${invite.id}/resend`,
                undefined,
                staff.cookie,
              )
            ).status,
            429,
          );
          await memberInvites().updateOne(
            { _id: invite.id },
            { $set: { resendCount: 5 } },
          );
          const capped = await call(
            "POST",
            `${invitePath}/${invite.id}/resend`,
            undefined,
            staff.cookie,
          );
          assert.equal(capped.status, 409);
          assert.equal(capped.body.code, "INVITE_RESEND_LIMIT");
          assert.ok(
            await db.collection("audit_logs").findOne({
              action: "invite-resent",
              targetId: invite.id.toHexString(),
            }),
          );
        },
      );
      await t.test(
        "lookup exposes current documents and gives identical unknown/expired responses",
        async () => {
          await resetLimits();
          const invite = await create();
          const found = await call("POST", "/api/invites/lookup", {
            token: invite.token,
          });
          assert.equal(found.status, 200);
          assert.equal(found.body.chainName, "Test Fitness");
          assert.equal(found.body.legal.version, 4);
          assert.equal(found.headers.get("cache-control"), "no-store");
          await memberInvites().updateOne(
            { _id: invite.id },
            { $set: { expiresAt: new Date(0) } },
          );
          const expired = await call("POST", "/api/invites/lookup", {
            token: invite.token,
          });
          const unknown = await call("POST", "/api/invites/lookup", {
            token: newInviteToken().token,
          });
          assert.equal(expired.status, 404);
          assert.equal(unknown.status, 404);
          assert.deepEqual(expired.body, unknown.body);
          assert.equal(
            (
              await call(
                "POST",
                "/api/invites/accept",
                acceptBody(invite.token),
              )
            ).body.code,
            "INVITE_INVALID",
          );
        },
      );
      await t.test(
        "accept creates one verified user, both consents and version, without OTP or session",
        async () => {
          const invite = await create();
          const mailCount = sendMail.mock.callCount();
          const verifications = await db
            .collection("verification")
            .countDocuments();
          const sessions = await db.collection("session").countDocuments();
          const accepted = await call(
            "POST",
            "/api/invites/accept",
            acceptBody(invite.token),
          );
          assert.equal(accepted.status, 200);
          assert.deepEqual(accepted.body, { ok: true });
          assert.equal(accepted.headers.get("set-cookie"), null);
          assert.equal(sendMail.mock.callCount(), mailCount);
          assert.equal(
            await db.collection("verification").countDocuments(),
            verifications,
          );
          assert.equal(
            await db.collection("session").countDocuments(),
            sessions,
          );
          const user = await db
            .collection("user")
            .findOne({ email: invite.data.email });
          assert.ok(user);
          assert.equal(user.dataProcessingAccepted, true);
          assert.equal(user.privacyAccepted, true);
          assert.ok(user.dataProcessingAcceptedAt instanceof Date);
          assert.ok(user.privacyAcceptedAt instanceof Date);
          assert.equal(user.legalVersionAccepted, 4);
          assert.equal(user.emailVerified, true);
          assert.equal(user.role, "member");
          assert.equal(
            await db.collection("account").countDocuments({ userId: user._id }),
            1,
          );
          assert.equal(await memberInvites().findOne({ _id: invite.id }), null);
          const audit = await db.collection("audit_logs").findOne({
            action: "invite-accepted",
            targetId: invite.id.toHexString(),
          });
          assert.equal(audit?.actorId, user._id.toHexString());
          assert.equal(audit?.gymId, gym.toHexString());
          assert.equal(audit?.actorEmail, "");
          assert.equal(audit?.details, null);
          assert.equal(
            (
              await call(
                "POST",
                "/api/invites/accept",
                acceptBody(invite.token),
              )
            ).body.code,
            "INVITE_INVALID",
          );
          const signedIn = await auth.api.signInEmail({
            body: { email: invite.data.email, password: "new-password-1234" },
          });
          assert.ok(signedIn.token);
        },
      );
      await t.test(
        "legal changes require renewed consent without consuming the invitation",
        async () => {
          const invite = await create();
          const changed = await call(
            "POST",
            "/api/invites/accept",
            acceptBody(invite.token, 3),
          );
          assert.equal(changed.status, 409);
          assert.equal(changed.body.code, "LEGAL_VERSION_CHANGED");
          assert.ok(await memberInvites().findOne({ _id: invite.id }));
          assert.equal(
            await db
              .collection("user")
              .countDocuments({ email: invite.data.email }),
            0,
          );
          for (const flag of ["dataProcessingAccepted", "privacyAccepted"]) {
            assert.equal(
              (
                await call("POST", "/api/invites/accept", {
                  ...acceptBody(invite.token),
                  [flag]: false,
                })
              ).status,
              400,
            );
          }
        },
      );
      await t.test(
        "two concurrent accepts create exactly one account",
        async () => {
          await resetLimits();
          const invite = await create();
          const results = await Promise.all([
            call("POST", "/api/invites/accept", acceptBody(invite.token)),
            call("POST", "/api/invites/accept", acceptBody(invite.token)),
          ]);
          assert.deepEqual(
            results.map((result) => result.status).sort(),
            [200, 404],
          );
          assert.equal(
            results.find((result) => result.status === 404)?.body.code,
            "INVITE_INVALID",
          );
          assert.equal(
            await db
              .collection("user")
              .countDocuments({ email: invite.data.email }),
            1,
          );
        },
      );
      await t.test(
        "cancel and resend refuse an in-flight claimed accept after the Redis lease expires",
        async (t) => {
          await resetLimits();
          const invite = await create();
          let markStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            markStarted = resolve;
          });
          let resumeSignup!: () => void;
          const resume = new Promise<void>((resolve) => {
            resumeSignup = resolve;
          });
          const signUpEmail = auth.api.signUpEmail;
          t.mock.method(
            auth.api,
            "signUpEmail",
            async (...args: Parameters<typeof signUpEmail>) => {
              markStarted();
              await resume;
              return signUpEmail(...args);
            },
          );
          const accepting = call(
            "POST",
            "/api/invites/accept",
            acceptBody(invite.token),
          );
          try {
            await Promise.race([
              started,
              accepting.then(() => {
                throw new Error("Acceptance returned before signup started.");
              }),
            ]);
            const claimed = await memberInvites().findOne({ _id: invite.id });
            assert.ok(claimed?.acceptingAt instanceof Date);
            // Simulate expiry of the old Redis lease without a minute-long wait.
            await redis.del(`og:lock:invite:${hashInviteToken(invite.token)}`);
            for (const [method, suffix] of [
              ["DELETE", ""],
              ["POST", "/resend"],
            ] as const) {
              const result = await call(
                method,
                `${invitePath}/${invite.id}${suffix}`,
                undefined,
                staff.cookie,
              );
              assert.equal(result.status, 409);
              assert.equal(result.body.code, "INVITE_ACCEPTING");
              assert.deepEqual(
                await memberInvites().findOne({ _id: invite.id }),
                claimed,
              );
            }
          } finally {
            resumeSignup();
            await accepting;
          }
          assert.equal((await accepting).status, 200);
          assert.equal(await memberInvites().findOne({ _id: invite.id }), null);
          const user = await db
            .collection("user")
            .findOne({ email: invite.data.email });
          assert.equal(user?.emailVerified, true);
        },
      );
      await t.test(
        "a claim older than two minutes can be accepted",
        async () => {
          const invite = await create();
          await memberInvites().updateOne(
            { _id: invite.id },
            { $set: { acceptingAt: new Date(Date.now() - 3 * 60_000) } },
          );
          const result = await call(
            "POST",
            "/api/invites/accept",
            acceptBody(invite.token),
          );
          assert.equal(result.status, 200);
          assert.equal(await memberInvites().findOne({ _id: invite.id }), null);
          const user = await db
            .collection("user")
            .findOne({ email: invite.data.email });
          assert.equal(user?.emailVerified, true);
        },
      );
      await t.test(
        "phone conflicts from the signup hook keep the invite pending",
        async () => {
          const invite = await create();
          const existing = await db
            .collection("user")
            .findOne({ _id: new ObjectId(member.id) });
          await memberInvites().updateOne(
            { _id: invite.id },
            { $set: { phone: existing!.phone } },
          );
          const result = await call(
            "POST",
            "/api/invites/accept",
            acceptBody(invite.token),
          );
          assert.equal(result.status, 400);
          assert.equal(result.body.code, "PHONE_ALREADY_EXISTS");
          const pending = await memberInvites().findOne({ _id: invite.id });
          assert.ok(pending);
          assert.equal("acceptingAt" in pending, false);
          assert.equal(
            await db
              .collection("user")
              .countDocuments({ email: invite.data.email }),
            0,
          );
          assert.equal(
            (
              await call(
                "DELETE",
                `${invitePath}/${invite.id}`,
                undefined,
                staff.cookie,
              )
            ).status,
            200,
          );
          assert.equal(await memberInvites().findOne({ _id: invite.id }), null);
        },
      );
      await t.test(
        "cancellation deletes the invite and leaves only an anonymous audit",
        async () => {
          const invite = await create();
          assert.equal(
            (
              await call(
                "DELETE",
                `${invitePath}/${invite.id}`,
                undefined,
                staff.cookie,
              )
            ).status,
            200,
          );
          assert.equal(await memberInvites().findOne({ _id: invite.id }), null);
          assert.equal(
            (await call("POST", "/api/invites/lookup", { token: invite.token }))
              .body.code,
            "INVITE_INVALID",
          );
          const audit = await db.collection("audit_logs").findOne({
            action: "invite-cancelled",
            targetId: invite.id.toHexString(),
          });
          assert.ok(audit);
          assert.equal(audit.details, null);
          assert.equal(
            JSON.stringify(audit).includes(invite.data.email),
            false,
          );
        },
      );
      await t.test(
        "expired invites do not reserve an email and indexes enforce pending privacy",
        async () => {
          const invite = await create();
          await memberInvites().updateOne(
            { _id: invite.id },
            { $set: { expiresAt: new Date(0) } },
          );
          const replacement = await call(
            "POST",
            invitePath,
            invite.data,
            staff.cookie,
          );
          assert.equal(replacement.status, 201);
          assert.notEqual(replacement.body.id, invite.id.toHexString());
          const indexes = await memberInvites().indexes();
          assert.ok(
            indexes.some(
              (index) =>
                index.key.expiresAt === 1 && index.expireAfterSeconds === 0,
            ),
          );
          assert.ok(
            indexes.some((index) => index.key.email === 1 && index.unique),
          );
          assert.ok(
            indexes.some((index) => index.key.tokenHash === 1 && index.unique),
          );
        },
      );
      await t.test("public endpoints share an atomic IP limit", async () => {
        await resetLimits();
        for (let i = 0; i < 20; i++)
          assert.equal(
            (
              await call("POST", "/api/invites/lookup", {
                token: newInviteToken().token,
              })
            ).status,
            404,
          );
        const result = await call(
          "POST",
          "/api/invites/accept",
          acceptBody(newInviteToken().token),
        );
        assert.equal(result.status, 429);
        assert.equal(result.body.code, "RATE_LIMITED");
      });
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      if (redis.isOpen) {
        await resetLimits().catch(() => {});
        await redis.quit().catch(() => {});
      }
      await db.dropDatabase().catch(() => {});
      await mongoClient.close();
    }
  },
);
