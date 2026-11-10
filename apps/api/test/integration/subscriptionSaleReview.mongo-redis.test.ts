import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ObjectId } from "mongodb";
import type { ApiErrorResponse, Subscription } from "@opengym/shared";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;

test(
  "subscription sale review: confirmed terms, scoped replays and older debt",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async (t) => {
    process.env.MONGODB_URI = `${mongoUri!}/opengym_sale_review_${randomUUID().replaceAll("-", "")}`;
    process.env.REDIS_URL = redisUri!;
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "sale-review-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { db, mongoClient },
      { connectRedis, redis },
      { ensurePaymentIndexes },
      { subscriptionCollection },
      { paymentCollection },
      { default: express },
      { createServer },
      { auth },
      { subscriptionsRouter },
      { paymentsRouter },
    ] = await Promise.all([
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/core/indexes.js"),
      import("../../src/features/subscriptions/subscriptions.js"),
      import("../../src/features/payments/paymentStore.js"),
      import("express"),
      import("node:http"),
      import("../../src/auth/auth.js"),
      import("../../src/features/subscriptions/router.js"),
      import("../../src/features/payments/router.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/admin", subscriptionsRouter, paymentsRouter);
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;

    async function request<T>(
      cookie: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: T }> {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as T };
    }

    let userCounter = 0;
    async function signIn(role: "owner" | "staff", gymIds: string[] = []) {
      const email = `${randomUUID()}@example.com`;
      const password = "test-password-1234";
      const signedUp = await auth.api.signUpEmail({
        body: {
          email,
          password,
          name: "Sale Reviewer",
          firstName: "Sale",
          lastName: "Reviewer",
          phone: `531${String(++userCounter).padStart(7, "0")}`,
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(signedUp.user.id) },
          { $set: { role, gymIds, emailVerified: true } },
        );
      const signedIn = await auth.api.signInEmail({
        body: { email, password },
        returnHeaders: true,
      });
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return cookie;
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await ensurePaymentIndexes(db);
      const gymA = new ObjectId();
      const gymB = new ObjectId();
      await db.collection("gyms").insertMany([
        { _id: gymA, name: "Gym A", active: true },
        { _id: gymB, name: "Gym B", active: true },
      ]);
      const owner = await signIn("owner");
      const staffA = await signIn("staff", [gymA.toHexString()]);
      const staffB = await signIn("staff", [gymB.toHexString()]);
      const userId = new ObjectId();
      await db.collection("user").insertOne({ _id: userId, role: "member" });
      const packageId = new ObjectId();
      const month = { unit: "month", value: 1 } as const;
      await db.collection("packages").insertOne({
        _id: packageId,
        name: "Monthly",
        duration: month,
        priceMinor: 1_000,
        active: true,
      });
      const settings = db.collection<{ _id: string; currency: string }>(
        "settings",
      );
      await settings.updateOne(
        { _id: "chain" },
        { $set: { currency: "TRY" } },
        { upsert: true },
      );
      const sale = () => ({
        userId: userId.toHexString(),
        gymIds: [gymA.toHexString()],
        packageId: packageId.toHexString(),
        expectedPriceMinor: 1_000,
        expectedCurrency: "TRY",
        expectedDuration: month,
        requestId: randomUUID(),
      });
      type Created = { ok: true; id: string; startsAt: string; endsAt: string };

      await t.test(
        "currency drift with unchanged price is refused",
        async () => {
          await settings.updateOne(
            { _id: "chain" },
            { $set: { currency: "EUR" } },
          );
          const response = await request<ApiErrorResponse>(
            staffA,
            "/subscriptions",
            sale(),
          );
          assert.equal(response.status, 409);
          assert.equal(response.body.code, "PACKAGE_PRICE_CHANGED");
          assert.equal(await subscriptionCollection().countDocuments(), 0);
          assert.equal(await paymentCollection().countDocuments(), 0);
          assert.equal(await db.collection("audit_logs").countDocuments(), 0);
          await settings.updateOne(
            { _id: "chain" },
            { $set: { currency: "TRY" } },
          );
        },
      );

      await t.test("duration unit and value drift are refused", async () => {
        for (const duration of [
          { unit: "month", value: 2 },
          { unit: "day", value: 1 },
        ]) {
          await db
            .collection("packages")
            .updateOne({ _id: packageId }, { $set: { duration } });
          const response = await request<ApiErrorResponse>(
            staffA,
            "/subscriptions",
            sale(),
          );
          assert.equal(response.status, 409);
          assert.equal(response.body.code, "PACKAGE_PRICE_CHANGED");
          assert.equal(await subscriptionCollection().countDocuments(), 0);
        }
        await db
          .collection("packages")
          .updateOne({ _id: packageId }, { $set: { duration: month } });
      });

      await t.test(
        "unchanged terms succeed and snapshot the confirmed terms",
        async () => {
          const response = await request<Created>(
            staffA,
            "/subscriptions",
            sale(),
          );
          assert.equal(response.status, 200);
          const period = await subscriptionCollection().findOne({
            _id: new ObjectId(response.body.id),
          });
          assert.equal(period?.sale?.currency, "TRY");
          assert.equal(period?.sale?.priceMinor, 1_000);
          assert.deepEqual(period?.sale?.duration, month);
        },
      );

      await t.test(
        "custom and override sales also guard confirmed terms",
        async () => {
          await settings.updateOne(
            { _id: "chain" },
            { $set: { currency: "EUR" } },
          );
          const base = {
            userId: userId.toHexString(),
            gymIds: [gymA.toHexString()],
            expectedCurrency: "TRY",
            requestId: randomUUID(),
          };
          const bodies = [
            { ...sale(), priceMinor: 500 },
            {
              ...base,
              expectedDuration: { unit: "day", value: 10 },
              custom: { days: 10, priceMinor: 500 },
            },
          ];
          for (const body of bodies) {
            const response = await request<ApiErrorResponse>(
              owner,
              "/subscriptions",
              body,
            );
            assert.equal(response.status, 409);
            assert.equal(response.body.code, "PACKAGE_PRICE_CHANGED");
          }
          await settings.updateOne(
            { _id: "chain" },
            { $set: { currency: "TRY" } },
          );
          await db
            .collection("packages")
            .updateOne(
              { _id: packageId },
              { $set: { duration: { unit: "month", value: 2 } } },
            );
          const override = await request<ApiErrorResponse>(
            owner,
            "/subscriptions",
            {
              ...sale(),
              priceMinor: 500,
            },
          );
          assert.equal(override.status, 409);
          assert.equal(override.body.code, "PACKAGE_PRICE_CHANGED");
          await db
            .collection("packages")
            .updateOne({ _id: packageId }, { $set: { duration: month } });
          const custom = await request<Created>(
            owner,
            "/subscriptions",
            bodies[1],
          );
          assert.equal(custom.status, 200);
        },
      );

      await t.test(
        "lost response retries survive gym deactivation without another audit",
        async () => {
          const body = sale();
          const original = await request<Created>(
            staffA,
            "/subscriptions",
            body,
          );
          assert.equal(original.status, 200);
          await db
            .collection("gyms")
            .updateOne({ _id: gymA }, { $set: { active: false } });
          const replay = await request<Created>(staffA, "/subscriptions", body);
          assert.equal(replay.status, 200);
          assert.deepEqual(replay.body, original.body);
          assert.equal(
            await subscriptionCollection().countDocuments({
              requestId: body.requestId,
            }),
            1,
          );
          assert.equal(
            await db.collection("audit_logs").countDocuments({
              action: "subscription-created",
              "details.subscriptionId": original.body.id,
            }),
            1,
          );
          const hidden = await request<ApiErrorResponse>(
            staffB,
            "/subscriptions",
            body,
          );
          assert.equal(hidden.status, 403);
          assert.equal(hidden.body.code, "GYM_OUT_OF_SCOPE");
          assert.equal("id" in hidden.body, false);
          await db
            .collection("gyms")
            .updateOne({ _id: gymA }, { $set: { active: true } });
          // A changed payload must not bypass scope through the lower-level replay.
          const hiddenWithScopedGym = await request<ApiErrorResponse>(
            staffB,
            "/subscriptions",
            {
              ...body,
              gymIds: [gymB.toHexString()],
            },
          );
          assert.equal(hiddenWithScopedGym.status, 409);
          assert.equal(hiddenWithScopedGym.body.code, "REQUEST_ID_CONFLICT");
          const unusedId = await request<Created>(staffB, "/subscriptions", {
            ...body,
            userId: new ObjectId().toHexString(),
            gymIds: [gymB.toHexString()],
          });
          assert.equal(unusedId.status, 404);
        },
      );

      await t.test(
        "the latest 50 plus the oldest unpaid period are returned and payable",
        async () => {
          const member = new ObjectId();
          await db
            .collection("user")
            .insertOne({ _id: member, role: "member" });
          const periods = Array.from({ length: 51 }, (_, index) => ({
            _id: new ObjectId(),
            userId: member,
            gymIds: [gymA],
            startsAt: new Date(Date.UTC(2020, 0, index + 1)),
            endsAt: new Date(Date.UTC(2020, 0, index + 2)),
            note: null,
            createdAt: new Date(Date.UTC(2020, 0, index + 1)),
            createdBy: "reviewer",
            sale: {
              packageId,
              packageName: "Monthly",
              duration: month,
              listPriceMinor: 1_000,
              priceMinor: index === 0 ? 1_000 : 0,
              currency: "TRY" as const,
              nextPaymentDue: null,
            },
          }));
          await subscriptionCollection().insertMany(periods);
          const oldest = periods[0]!;
          const response = await request<Subscription[]>(
            staffA,
            `/users/${member.toHexString()}/subscriptions`,
          );
          assert.equal(response.status, 200);
          assert.equal(response.body.length, 51);
          assert.equal(
            new Set(response.body.map((period) => period.id)).size,
            51,
          );
          assert.deepEqual(
            response.body.map((period) => period.id),
            [...periods].reverse().map((period) => period._id.toHexString()),
          );
          assert.equal(response.body.at(-1)?.balanceMinor, 1_000);
          const hidden = await request<Subscription[]>(
            staffB,
            `/users/${member.toHexString()}/subscriptions`,
          );
          assert.equal(hidden.body.length, 50);
          assert.ok(hidden.body.every((period) => period.sale === null));
          await subscriptionCollection().updateOne(
            { _id: periods.at(-1)!._id },
            { $set: { "sale.priceMinor": 1_000 } },
          );
          const withRecentDebt = await request<Subscription[]>(
            staffA,
            `/users/${member.toHexString()}/subscriptions`,
          );
          assert.equal(withRecentDebt.body.length, 51);
          assert.equal(
            new Set(withRecentDebt.body.map((period) => period.id)).size,
            51,
          );
          const payment = await request(
            staffA,
            `/subscriptions/${oldest._id.toHexString()}/payments`,
            {
              amountMinor: 1_000,
              method: "cash",
              gymId: gymA.toHexString(),
              requestId: randomUUID(),
            },
          );
          assert.equal(payment.status, 200);
          const afterPayment = await request<Subscription[]>(
            staffA,
            `/users/${member.toHexString()}/subscriptions`,
          );
          assert.equal(afterPayment.body.length, 50);
          assert.equal(
            afterPayment.body.some(
              (period) => period.id === oldest._id.toHexString(),
            ),
            false,
          );
        },
      );
    } finally {
      server.close();
      await db.dropDatabase().catch(() => undefined);
      if (redis.isOpen) await redis.quit();
      await mongoClient.close();
    }
  },
);
