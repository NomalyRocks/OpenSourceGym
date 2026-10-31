import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "per-email OTP attempt cap holds under parallel guesses from many IPs",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_otp_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/3";
    // Development mode, but the address is not @test.com, so the dev bypass
    // does not apply and the cap is enforced.
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "otp-attempts-integration-test-secret-at-least-32-characters";

    const [{ auth }, { db, mongoClient }, { connectRedis, redis }] =
      await Promise.all([
        import("../auth.js"),
        import("../db.js"),
        import("../redis.js"),
      ]);

    const email = "otp-victim@example.com";
    let ipCounter = 0;

    // Every call comes from a distinct IP, so the per-IP 5/60s rule never
    // trips and any OTP_ATTEMPTS_EXCEEDED must come from the per-email cap.
    async function post(
      path: string,
      body: Record<string, unknown>,
    ): Promise<{ status: number; code: string | undefined }> {
      ipCounter += 1;
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
            "x-forwarded-for": `203.0.113.${ipCounter}`,
          },
          body: JSON.stringify(body),
        }),
      );
      const json = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;
      return { status: response.status, code: json?.code };
    }

    const guess = () =>
      post("/email-otp/check-verification-otp", {
        email,
        type: "forget-password",
        otp: "000000",
      });

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();

      const first = await post("/email-otp/request-password-reset", { email });
      assert.equal(first.status, 200);

      const burst = await Promise.all(Array.from({ length: 20 }, guess));
      const allowed = burst.filter((r) => r.status !== 429);
      const capped = burst.filter((r) => r.code === "OTP_ATTEMPTS_EXCEEDED");
      assert.ok(allowed.length <= 5, `${allowed.length} guesses got through`);
      assert.equal(capped.length, 20 - allowed.length);
      assert.equal(burst.filter((r) => r.status === 429).length, capped.length);

      // A different request path and case/whitespace variants share the cap.
      const verify = await post("/email-otp/verify-email", {
        email: `  ${email.toUpperCase()} `,
        otp: "000000",
      });
      assert.equal(verify.status, 429);
      assert.equal(verify.code, "OTP_ATTEMPTS_EXCEEDED");

      // Requesting a new code must not reset the counter.
      const second = await post("/email-otp/request-password-reset", { email });
      assert.equal(second.status, 200);
      const after = await guess();
      assert.equal(after.status, 429);
      assert.equal(after.code, "OTP_ATTEMPTS_EXCEEDED");

      // A correct code clears the counter. The OTP is stored hashed, so seed
      // the verification record with the hash of a known code.
      const clearEmail = "otp-success@example.com";
      const knownOtp = "424242";
      const hashed = createHash("sha256").update(knownOtp).digest("base64url");
      const counterKey = `og:otp-attempts:${clearEmail}`;
      assert.equal(
        (await post("/email-otp/request-password-reset", { email: clearEmail }))
          .status,
        200,
      );
      // No such user exists yet, so request-password-reset stored no OTP. Insert
      // a minimal user, then write the verification record directly (it lives
      // in Redis secondary storage).
      const now = new Date();
      await db.collection("user").insertOne({
        name: "OTP Success",
        email: clearEmail,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await redis.set(
        `verification:forget-password-otp-${clearEmail}`,
        JSON.stringify({
          id: randomUUID(),
          identifier: `forget-password-otp-${clearEmail}`,
          value: `${hashed}:0`,
          expiresAt: new Date(now.getTime() + 600_000),
          createdAt: now,
          updatedAt: now,
        }),
        { expiration: { type: "EX", value: 600 } },
      );
      const wrong = await post("/email-otp/check-verification-otp", {
        email: clearEmail,
        type: "forget-password",
        otp: "000000",
      });
      assert.notEqual(wrong.status, 200);
      assert.equal(await redis.get(counterKey), "1");
      const right = await post("/email-otp/check-verification-otp", {
        email: clearEmail,
        type: "forget-password",
        otp: knownOtp,
      });
      assert.equal(right.status, 200, JSON.stringify(right));
      assert.equal(await redis.get(counterKey), null);

      // Another address is unaffected.
      const other = await post("/email-otp/check-verification-otp", {
        email: "someone-else@example.com",
        type: "forget-password",
        otp: "000000",
      });
      assert.notEqual(other.code, "OTP_ATTEMPTS_EXCEEDED");
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
