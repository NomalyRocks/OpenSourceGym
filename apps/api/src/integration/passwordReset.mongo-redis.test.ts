import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "password reset revokes Redis sessions missing from the active-sessions list",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_reset_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/4";
    // Development mode makes @test.com addresses use the fixed dev OTP.
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "password-reset-integration-test-secret-at-least-32-characters";

    const [{ auth }, { db, mongoClient }, { connectRedis, redis }] =
      await Promise.all([
        import("../auth.js"),
        import("../db.js"),
        import("../redis.js"),
      ]);

    const email = "reset-orphan@test.com";
    const devOtp = "111111";

    async function post(
      path: string,
      body: Record<string, unknown>,
    ): Promise<Response> {
      return auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
          },
          body: JSON.stringify(body),
        }),
      );
    }

    async function signIn(password: string): Promise<string> {
      const response = await post("/sign-in/email", { email, password });
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return cookie;
    }

    async function sessionUserId(cookie: string): Promise<string | null> {
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/get-session", {
          headers: { cookie, origin: "http://localhost:5173" },
        }),
      );
      const body = (await response.json()) as {
        user?: { id?: string };
      } | null;
      return body?.user?.id ?? null;
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();

      const signUp = await post("/sign-up/email", {
        name: "Reset Test",
        firstName: "Reset",
        lastName: "Test",
        email,
        password: "old-password-1234",
        phone: "539 123 45 67",
        dataProcessingAccepted: true,
        privacyAccepted: true,
      });
      assert.equal(signUp.status, 200);
      await db
        .collection("user")
        .updateOne({ email }, { $set: { emailVerified: true } });
      const user = await db.collection("user").findOne({ email });
      assert.ok(user);
      const userId = user._id.toString();

      const listed = await signIn("old-password-1234");
      const orphaned = await signIn("old-password-1234");
      const tokens = (
        await db
          .collection("session")
          .find({ userId: user._id }, { projection: { token: 1 } })
          .toArray()
      ).map((session) => String(session.token));
      assert.equal(tokens.length, 2);

      // Drop one token from the list, as a concurrent sign-in race or the
      // sharing.ts list rewrite can, leaving its Redis blob unlisted.
      const listKey = `active-sessions-${userId}`;
      const list = JSON.parse((await redis.get(listKey)) ?? "[]") as {
        token: string;
      }[];
      // The cookie value is "<token>.<signature>", URL-encoded.
      const orphanToken = decodeURIComponent(
        orphaned.slice(orphaned.indexOf("=") + 1),
      ).split(".", 1)[0];
      assert.ok(orphanToken && tokens.includes(orphanToken));
      assert.ok(orphanToken);
      await redis.set(
        listKey,
        JSON.stringify(list.filter((entry) => entry.token !== orphanToken)),
      );
      assert.equal(await sessionUserId(orphaned), userId);
      assert.equal(await sessionUserId(listed), userId);

      const request = await post("/email-otp/request-password-reset", {
        email,
      });
      assert.equal(request.status, 200);
      const reset = await post("/email-otp/reset-password", {
        email,
        otp: devOtp,
        password: "new-password-5678",
      });
      assert.equal(reset.status, 200);

      for (const token of tokens) {
        assert.equal(await redis.get(token), null, "Redis blob survived");
      }
      assert.equal(await sessionUserId(orphaned), null);
      assert.equal(await sessionUserId(listed), null);
      assert.equal(
        await db.collection("session").countDocuments({ userId: user._id }),
        0,
      );
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
