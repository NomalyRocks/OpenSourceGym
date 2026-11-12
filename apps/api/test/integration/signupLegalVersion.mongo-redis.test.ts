import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import nodemailer from "nodemailer";
import { ObjectId } from "mongodb";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "normal signup stamps the current legal version and both consents and sends OTP",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async (t) => {
    process.env.NODE_ENV = "test";
    process.env.MONGODB_URI = `${mongoUri}/opengym_signup_legal_${randomUUID().replaceAll("-", "")}`;
    // Other integration files flush their Redis databases in parallel.
    const url = new URL(process.env.TEST_REDIS_URL!);
    url.pathname = "/7";
    process.env.REDIS_URL = url.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "signup-legal-test-secret-at-least-32-characters";
    process.env.SMTP_HOST = "smtp.example.com";
    const messages: { to: string; subject: string; text: string }[] = [];
    const sendMail = t.mock.fn(async (mail: (typeof messages)[number]) => {
      messages.push(mail);
    });
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail }) as never);

    const [
      { auth },
      { db, mongoClient, chainSettingsCollection },
      { redis, connectRedis },
      { ensureIndexes },
    ] = await Promise.all([
      import("../../src/auth/auth.js"),
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/core/indexes.js"),
    ]);

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();
      await ensureIndexes();
      const legalVersion = 4;
      await chainSettingsCollection().insertOne({
        _id: "chain",
        chainName: "Test Fitness",
        legal: {
          dataProcessingUrl: "https://example.com/data",
          privacyUrl: "https://example.com/privacy",
          version: legalVersion,
        },
      });
      const email = `signup-legal-${randomUUID()}@example.com`;
      const beforeSignup = Date.now();
      const result = await auth.api.signUpEmail({
        body: {
          email,
          name: "Alex Member",
          firstName: "Alex",
          lastName: "Member",
          phone: "+905390000001",
          password: "password-1234",
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      const afterSignup = Date.now();
      const stored = await db
        .collection("user")
        .findOne({ _id: new ObjectId(result.user.id) });
      assert.ok(stored);
      assert.equal(stored.legalVersionAccepted, legalVersion);
      assert.equal(stored.dataProcessingAccepted, true);
      assert.equal(stored.privacyAccepted, true);
      for (const timestamp of [
        stored.dataProcessingAcceptedAt,
        stored.privacyAcceptedAt,
      ]) {
        assert.ok(timestamp instanceof Date);
        assert.ok(timestamp.getTime() >= beforeSignup);
        assert.ok(timestamp.getTime() <= afterSignup);
      }
      assert.equal(stored.emailVerified, false);
      assert.equal(sendMail.mock.callCount(), 1);
      assert.equal(messages[0]?.to, email);
      assert.match(messages[0]!.text, /\b\d{6}\b/);
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
