import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "kayıt hook'u eski onay anahtarını kabul eder, telefonu normalize eder ve farklı yazılmış mükerreri ayırır",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI ve TEST_REDIS_URL tanımlı değil",
  },
  async () => {
    const databaseName = `opengym_signup_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/15";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "phone-signup-integration-test-secret-at-least-32-characters";

    const [
      { auth },
      { db, mongoClient },
      { connectRedis, redis },
      { backfillLegacyUserPhones },
      { ensureIndexes },
      { seedInitialAdmin },
    ] = await Promise.all([
      import("../auth.js"),
      import("../db.js"),
      import("../redis.js"),
      import("../phoneBackfill.js"),
      import("../indexes.js"),
      import("../seed.js"),
    ]);

    async function signUp(
      email: string,
      phone: string,
      consentField: "current" | "legacy" = "current",
    ): Promise<{
      status: number;
      body: Record<string, unknown> & { code?: string; message?: string };
    }> {
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({
            name: "Telefon Testi",
            firstName: "Telefon",
            lastName: "Testi",
            email,
            password: "test-password-1234",
            phone,
            ...(consentField === "legacy"
              ? { kvkkAccepted: true }
              : { dataProcessingAccepted: true }),
            privacyAccepted: true,
          }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown> & {
          code?: string;
          message?: string;
        },
      };
    }

    async function signIn(email: string): Promise<string> {
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({
            email,
            password: "test-password-1234",
          }),
        }),
      );
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return cookie;
    }

    async function updatePhone(
      cookie: string,
      phone: string,
    ): Promise<{
      status: number;
      body: Record<string, unknown> & { code?: string };
    }> {
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/update-user", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({ phone }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown> & {
          code?: string;
        },
      };
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();
      await db.collection("user").insertMany([
        {
          email: "legacy-phone-a@example.com",
          phone: "534 123 45 67",
        },
        {
          email: "legacy-phone-b@example.com",
          phone: "+90 534 123 45 67",
        },
      ]);
      await backfillLegacyUserPhones();
      await ensureIndexes();

      const first = await signUp(
        "phone-a@example.com",
        "532 123 45 67",
        "legacy",
      );
      assert.equal(first.status, 200);
      assert.doesNotMatch(JSON.stringify(first.body), /phoneE164/);
      assert.equal(
        (first.body.user as { phone?: string } | undefined)?.phone,
        "+905321234567",
      );
      const stored = await db.collection("user").findOne(
        { email: "phone-a@example.com" },
        {
          projection: {
            phone: 1,
            phoneE164: 1,
            dataProcessingAccepted: 1,
            kvkkAccepted: 1,
          },
        },
      );
      assert.equal(stored?.phone, "+905321234567");
      assert.equal(stored?.phoneE164, "+905321234567");
      assert.equal(stored?.dataProcessingAccepted, true);
      assert.equal("kvkkAccepted" in (stored ?? {}), false);

      const duplicate = await signUp(
        "phone-b@example.com",
        "+90 532 123 45 67",
      );
      assert.equal(duplicate.status, 400);
      assert.equal(duplicate.body.code, "PHONE_ALREADY_EXISTS");
      assert.match(duplicate.body.message ?? "", /telefon numarası/i);
      assert.equal(
        await db.collection("user").countDocuments({
          phoneE164: "+905321234567",
        }),
        1,
      );

      await redis.flushDb();
      const concurrent = await Promise.all([
        signUp("phone-c@example.com", "533 123 45 67"),
        signUp("phone-d@example.com", "+90 533 123 45 67"),
      ]);
      assert.deepEqual(
        concurrent.map((result) => result.status).sort(),
        [200, 400],
      );
      assert.equal(
        concurrent.find((result) => result.status === 400)?.body.code,
        "PHONE_ALREADY_EXISTS",
      );
      assert.equal(
        await db.collection("user").countDocuments({
          phoneE164: "+905331234567",
        }),
        1,
      );

      await redis.flushDb();
      const legacyConflict = await signUp(
        "legacy-phone-c@example.com",
        "(0534) 123-45-67",
      );
      assert.equal(legacyConflict.status, 400);
      assert.equal(legacyConflict.body.code, "PHONE_ALREADY_EXISTS");

      await redis.flushDb();
      const publicSeedAttempt = await signUp("admin@opengym.local", "-");
      assert.equal(publicSeedAttempt.status, 400);
      assert.equal(publicSeedAttempt.body.code, "INVALID_PHONE_NUMBER");
      assert.match(
        publicSeedAttempt.body.message ?? "",
        /Geçerli bir telefon numarası/,
      );

      await seedInitialAdmin();
      const initialAdmin = await db.collection("user").findOne({
        email: "admin@opengym.local",
      });
      assert.equal(initialAdmin?.phone, "-");
      assert.equal(initialAdmin?.phoneE164, undefined);
      assert.equal(initialAdmin?.role, "admin");

      const conflictPartnerEmail =
        concurrent[0]?.status === 200
          ? "phone-c@example.com"
          : "phone-d@example.com";
      const target = await signUp("phone-e@example.com", "538 123 45 67");
      assert.equal(target.status, 200);
      await db
        .collection("user")
        .updateOne(
          { email: "phone-a@example.com" },
          { $set: { emailVerified: true } },
        );
      const cookie = await signIn("phone-a@example.com");

      const conflictUsers = await db
        .collection("user")
        .find({
          email: { $in: ["phone-a@example.com", conflictPartnerEmail] },
        })
        .toArray();
      assert.equal(conflictUsers.length, 2);
      const phoneA = conflictUsers.find(
        (user) => user.email === "phone-a@example.com",
      );
      const partner = conflictUsers.find(
        (user) => user.email === conflictPartnerEmail,
      );
      assert.ok(phoneA && partner);

      await db.collection("user").updateOne(
        { _id: phoneA._id },
        {
          $set: { phone: "535 123 45 67" },
          $unset: { phoneE164: "" },
        },
      );
      await db.collection("user").updateOne(
        { _id: partner._id },
        {
          $set: { phone: "+90 (535) 123-45-67" },
          $unset: { phoneE164: "" },
        },
      );
      await backfillLegacyUserPhones();

      const resolved = await updatePhone(cookie, "536 123 45 67");
      assert.equal(resolved.status, 200);
      assert.equal(
        await db
          .collection("phone_identity_conflicts")
          .findOne({ _id: "+905351234567" as never }),
        null,
      );
      const normalizedPartner = await db
        .collection("user")
        .findOne({ _id: partner._id });
      assert.equal(normalizedPartner?.phone, "+905351234567");
      assert.equal(normalizedPartner?.phoneE164, "+905351234567");

      await db.collection("user").updateOne(
        { _id: phoneA._id },
        {
          $set: { phone: "537 123 45 67" },
          $unset: { phoneE164: "" },
        },
      );
      await db.collection("user").updateOne(
        { _id: partner._id },
        {
          $set: { phone: "+90 (537) 123-45-67" },
          $unset: { phoneE164: "" },
        },
      );
      await backfillLegacyUserPhones();

      const oldConflictBeforeFailure = await db
        .collection("phone_identity_conflicts")
        .findOne({ _id: "+905371234567" as never });
      assert.ok(oldConflictBeforeFailure);
      const rejectedUpdate = await updatePhone(cookie, "+905381234567");
      assert.equal(rejectedUpdate.status, 400);
      assert.equal(rejectedUpdate.body.code, "PHONE_ALREADY_EXISTS");
      assert.deepEqual(
        await db
          .collection("phone_identity_conflicts")
          .findOne({ _id: "+905371234567" as never }),
        oldConflictBeforeFailure,
      );
      const unchangedPhoneA = await db
        .collection("user")
        .findOne({ _id: phoneA._id });
      assert.equal(unchangedPhoneA?.phone, "537 123 45 67");
      assert.equal(unchangedPhoneA?.phoneE164, undefined);
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
