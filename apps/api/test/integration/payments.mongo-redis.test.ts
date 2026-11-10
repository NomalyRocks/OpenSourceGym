import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Collection, ObjectId } from "mongodb";
import type {
  ApiErrorResponse,
  Package,
  PackageListResponse,
  PaymentResult,
} from "@opengym/shared";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;
const DAY = 86_400_000;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "package catalog and payments: balance, idempotency, cancel guard, cash report, anonymisation, seed",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async (t) => {
    const databaseName = `opengym_payments_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/9";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "payments-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { db, mongoClient },
      { connectRedis, redis },
      { ensurePaymentIndexes },
      {
        createSequentialSubscription,
        cancelScheduledSubscription,
        subscriptionCollection,
        getSubscriptionSummary,
        subscriptionUserLockKey,
        withRedisLock,
        USER_LOCK_LEASE_MS,
        USER_LOCK_WAIT_MS,
      },
      { recordPayment, voidPayment, anonymisePaymentsForUser, standingOf },
      { paymentCollection },
      { buildCashReport },
      { listDebtors },
      { seedLegacyMonthPackages },
      { default: express },
      { createServer },
      { auth },
      { paymentsRouter },
      { packagesRouter },
      { deletionRequestsRouter },
      { subscriptionsRouter },
    ] = await Promise.all([
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/core/indexes.js"),
      import("../../src/features/subscriptions/subscriptions.js"),
      import("../../src/features/payments/payments.js"),
      import("../../src/features/payments/paymentStore.js"),
      import("../../src/features/payments/cashReport.js"),
      import("../../src/features/payments/debtors.js"),
      import("../../src/repairs/seedLegacyPackages.js"),
      import("express"),
      import("node:http"),
      import("../../src/auth/auth.js"),
      import("../../src/features/payments/router.js"),
      import("../../src/features/packages/router.js"),
      import("../../src/features/deletionRequests/router.js"),
      import("../../src/features/subscriptions/router.js"),
    ]);

    const app = express();
    app.use(express.json());
    app.use(
      "/api/admin",
      paymentsRouter,
      packagesRouter,
      deletionRequestsRouter,
      subscriptionsRouter,
    );
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;

    async function request<T>(
      cookie: string,
      path: string,
      body: unknown = {},
      method = "POST",
    ): Promise<{ status: number; body: T }> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body),
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
          name: "Payment Tester",
          firstName: "Payment",
          lastName: "Tester",
          phone: `530${String(++userCounter).padStart(7, "0")}`,
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
      return { id: signedUp.user.id, cookie };
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await ensurePaymentIndexes(db);

      const gymA = new ObjectId();
      const gymB = new ObjectId();
      const otherGym = new ObjectId();
      const owner = await signIn("owner");
      const month = { unit: "month", value: 1 } as const;
      const sale = (
        priceMinor: number,
        nextPaymentDue: Date | null = null,
      ) => ({
        packageId: null,
        packageName: "Test package",
        duration: month,
        listPriceMinor: null,
        priceMinor,
        currency: "TRY" as const,
        nextPaymentDue,
      });
      /** Sells a period the way the route does and returns its id. */
      const sell = async (
        userId: ObjectId,
        priceMinor: number,
        options: {
          gymIds?: ObjectId[];
          nextPaymentDue?: Date | null;
          requestId?: string;
        } = {},
      ) => {
        await db.collection("user").updateOne(
          { _id: userId },
          {
            $setOnInsert: {
              email: `${userId.toHexString()}@example.com`,
              name: "Test member",
              role: "member",
            },
          },
          { upsert: true },
        );
        return createSequentialSubscription({
          userId,
          duration: month,
          gymIds: options.gymIds ?? [gymA, gymB],
          note: null,
          createdBy: "staff",
          sale: sale(priceMinor, options.nextPaymentDue ?? null),
          requestId: options.requestId ?? randomUUID(),
        });
      };
      const pay = (
        subscriptionId: ObjectId,
        amountMinor: number,
        extra: {
          gymId?: ObjectId;
          requestId?: string;
          recordedBy?: string;
        } = {},
      ) =>
        recordPayment({
          subscriptionId,
          amountMinor,
          method: "cash",
          gymId: (extra.gymId ?? gymA).toHexString(),
          note: null,
          requestId: extra.requestId ?? randomUUID(),
          recordedBy: extra.recordedBy ?? "staff",
        });

      await t.test(
        "staff catalog includes currency and catalog sales refuse price drift",
        async () => {
          const staff = await signIn("staff", [gymA.toHexString()]);
          await db
            .collection("gyms")
            .insertOne({ _id: gymA, name: "Test gym", active: true });
          const settings = db.collection<{ _id: string; currency: string }>(
            "settings",
          );
          await settings.updateOne(
            { _id: "chain" },
            { $set: { currency: "EUR" } },
            { upsert: true },
          );
          try {
            const pkg = await request<Package>(owner.cookie, "/packages", {
              name: "Price drift package",
              duration: month,
              priceMinor: 1_000,
            });
            assert.equal(pkg.status, 201);
            const catalog = await request<PackageListResponse>(
              staff.cookie,
              "/packages",
              {},
              "GET",
            );
            assert.equal(catalog.status, 200);
            assert.equal(catalog.body.currency, "EUR");
            assert.ok(
              catalog.body.packages.some((item) => item.id === pkg.body.id),
            );
            const userId = new ObjectId();
            await db
              .collection("user")
              .insertOne({ _id: userId, role: "member" });
            const body = {
              userId: userId.toHexString(),
              gymIds: [gymA.toHexString()],
              packageId: pkg.body.id,
              expectedPriceMinor: 1_000,
              expectedCurrency: "EUR",
              expectedDuration: month,
              requestId: randomUUID(),
            };
            await request(
              owner.cookie,
              `/packages/${pkg.body.id}`,
              { priceMinor: 2_000 },
              "PATCH",
            );
            const drift = await request<ApiErrorResponse>(
              staff.cookie,
              "/subscriptions",
              body,
            );
            assert.equal(drift.status, 409);
            assert.equal(drift.body.code, "PACKAGE_PRICE_CHANGED");
            assert.equal(
              await subscriptionCollection().countDocuments({ userId }),
              0,
            );
            assert.equal(
              await db.collection("audit_logs").countDocuments({
                action: "subscription-created",
                targetId: body.userId,
              }),
              0,
            );
            const refreshed = await request<PackageListResponse>(
              staff.cookie,
              "/packages",
              {},
              "GET",
            );
            assert.equal(
              refreshed.body.packages.find((item) => item.id === pkg.body.id)
                ?.priceMinor,
              2_000,
            );
            const acceptedBody = { ...body, expectedPriceMinor: 2_000 };
            const accepted = await request<{ id: string }>(
              staff.cookie,
              "/subscriptions",
              acceptedBody,
            );
            assert.equal(accepted.status, 200);
            assert.equal(
              (await subscriptionCollection().findOne({ userId }))?.sale
                ?.priceMinor,
              2_000,
            );
            await request(
              owner.cookie,
              `/packages/${pkg.body.id}`,
              { priceMinor: 3_000 },
              "PATCH",
            );
            const replay = await request<{ id: string }>(
              staff.cookie,
              "/subscriptions",
              acceptedBody,
            );
            assert.equal(replay.status, 200);
            assert.equal(replay.body.id, accepted.body.id);
            assert.equal(
              await subscriptionCollection().countDocuments({ userId }),
              1,
            );
          } finally {
            await settings.deleteOne({ _id: "chain" });
          }
        },
      );

      await t.test(
        "concurrent payments can never exceed the balance",
        async () => {
          const user = new ObjectId();
          const period = await sell(user, 10_000);
          const results = await Promise.all(
            Array.from({ length: 6 }, () => pay(period.id, 3_000)),
          );
          const recorded = results.filter((r) => r.status === "recorded");
          const refused = results.filter((r) => r.status === "exceeds-balance");
          assert.equal(recorded.length, 3);
          assert.equal(refused.length, 3);
          const standing = await standingOf(period.id, 10_000);
          assert.deepEqual(standing, { paidMinor: 9_000, balanceMinor: 1_000 });
          assert.equal(
            await paymentCollection().countDocuments({
              subscriptionId: period.id,
            }),
            3,
          );
        },
      );

      await t.test(
        "a payment takes the sale currency and package snapshot",
        async () => {
          const user = new ObjectId();
          const period = await sell(user, 5_000);
          const result = await pay(period.id, 1_000);
          assert.equal(result.status, "recorded");
          if (result.status !== "recorded") return;
          assert.equal(result.payment.currency, "TRY");
          assert.equal(result.payment.packageName, "Test package");
          assert.equal(result.payment.userId, user.toHexString());
          assert.equal(result.payment.void, null);
        },
      );

      await t.test(
        "a repeated payment requestId returns the same payment",
        async () => {
          const user = new ObjectId();
          const period = await sell(user, 10_000);
          const requestId = randomUUID();
          const [first, second] = await Promise.all([
            pay(period.id, 4_000, { requestId }),
            pay(period.id, 4_000, { requestId }),
          ]);
          const third = await pay(period.id, 4_000, { requestId });
          const statuses = [first.status, second.status].sort();
          assert.deepEqual(statuses, ["recorded", "replayed"]);
          assert.equal(third.status, "replayed");
          if (
            first.status === "exceeds-balance" ||
            third.status !== "replayed"
          ) {
            assert.fail("unexpected status");
          }
          assert.equal(
            await paymentCollection().countDocuments({ requestId }),
            1,
          );
          assert.equal((await standingOf(period.id, 10_000)).paidMinor, 4_000);
          // The same id on another period is a conflict, not a replay.
          const otherPeriod = await sell(new ObjectId(), 10_000);
          assert.equal(
            (await pay(otherPeriod.id, 1_000, { requestId })).status,
            "request-conflict",
          );
        },
      );

      await t.test(
        "payment replay rejects changed fields and a reassigned staff gym",
        async () => {
          const staff = await signIn("staff", [gymA.toHexString()]);
          const period = await sell(new ObjectId(), 10_000);
          const path = `/subscriptions/${period.id.toHexString()}/payments`;
          const body = {
            amountMinor: 1_000,
            method: "cash",
            gymId: gymA.toHexString(),
            note: "Private member note",
            requestId: randomUUID(),
          };
          const first = await request<PaymentResult>(staff.cookie, path, body);
          assert.equal(first.status, 200);
          const replay = await request<PaymentResult>(staff.cookie, path, body);
          assert.equal(replay.status, 200);
          assert.equal(replay.body.payment.id, first.body.payment.id);
          for (const changes of [
            { amountMinor: 2_000 },
            { method: "card" },
            { gymId: gymB.toHexString() },
          ]) {
            const conflict = await request<ApiErrorResponse>(
              owner.cookie,
              path,
              {
                ...body,
                ...changes,
              },
            );
            assert.equal(conflict.status, 409);
            assert.equal(conflict.body.code, "REQUEST_ID_CONFLICT");
          }
          await db
            .collection("user")
            .updateOne(
              { _id: new ObjectId(staff.id) },
              { $set: { gymIds: [gymB.toHexString()] } },
            );
          const hidden = await request<ApiErrorResponse>(
            staff.cookie,
            path,
            body,
          );
          assert.equal(hidden.status, 403);
          assert.equal(hidden.body.code, "GYM_OUT_OF_SCOPE");
          const swapped = await request<ApiErrorResponse>(staff.cookie, path, {
            ...body,
            gymId: gymB.toHexString(),
          });
          assert.equal(swapped.status, 409);
          assert.equal(swapped.body.code, "REQUEST_ID_CONFLICT");
          assert.equal("payment" in swapped.body, false);
          assert.equal("balanceMinor" in swapped.body, false);
        },
      );

      await t.test(
        "a repeated sale requestId returns the same period",
        async () => {
          const user = new ObjectId();
          const requestId = randomUUID();
          const results = await Promise.all([
            sell(user, 1_000, { requestId }),
            sell(user, 1_000, { requestId }),
            sell(user, 1_000, { requestId }),
          ]);
          assert.equal(new Set(results.map((r) => r.id.toHexString())).size, 1);
          assert.equal(results.filter((r) => !r.replayed).length, 1);
          assert.equal(
            await subscriptionCollection().countDocuments({ userId: user }),
            1,
          );
          await assert.rejects(sell(new ObjectId(), 1_000, { requestId }), {
            name: "RequestIdConflictError",
          });
        },
      );

      await t.test("periods without a sale take no payments", async () => {
        const user = new ObjectId();
        await db.collection("user").insertOne({ _id: user });
        const legacy = await subscriptionCollection().insertOne({
          userId: user,
          startsAt: new Date(Date.now() - DAY),
          endsAt: new Date(Date.now() + DAY),
          gymIds: [gymA],
          note: null,
          createdBy: "old",
          createdAt: new Date(),
        });
        assert.equal((await pay(legacy.insertedId, 100)).status, "unpriced");
        assert.equal((await pay(new ObjectId(), 100)).status, "not-found");
      });

      await t.test("the payment gym must be on the period", async () => {
        const period = await sell(new ObjectId(), 5_000, { gymIds: [gymA] });
        assert.equal(
          (await pay(period.id, 100, { gymId: otherGym })).status,
          "gym-not-on-period",
        );
        assert.equal(
          (await pay(period.id, 100, { gymId: gymA })).status,
          "recorded",
        );
      });

      await t.test(
        "cancel is refused with payments and allowed after void",
        async () => {
          const user = new ObjectId();
          // A running period makes the next sale start in the future.
          await subscriptionCollection().insertOne({
            userId: user,
            startsAt: new Date(Date.now() - DAY),
            endsAt: new Date(Date.now() + 10 * DAY),
            gymIds: [gymA],
            note: null,
            createdBy: "old",
            createdAt: new Date(),
          });
          const future = await sell(user, 8_000);
          const paid = await pay(future.id, 3_000);
          assert.equal(paid.status, "recorded");
          if (paid.status !== "recorded") return;

          const allow = () => true;
          assert.equal(
            (await cancelScheduledSubscription(future.id, allow)).status,
            "has-payments",
          );
          assert.equal(
            await subscriptionCollection().countDocuments({ _id: future.id }),
            1,
          );

          const voided = await voidPayment(paid.payment._id, "owner", "typo");
          assert.equal(voided.status, "voided");
          if (voided.status !== "voided") return;
          // A voided payment no longer counts toward the balance.
          assert.deepEqual(voided.standing, {
            paidMinor: 0,
            balanceMinor: 8_000,
          });
          assert.equal(
            (await voidPayment(paid.payment._id, "owner", "again")).status,
            "already-voided",
          );
          assert.equal(
            (await voidPayment(new ObjectId(), "owner", "nothing")).status,
            "not-found",
          );
          assert.equal(
            (await cancelScheduledSubscription(future.id, allow)).status,
            "cancelled",
          );
          // The voided row stays as history.
          assert.equal(
            await paymentCollection().countDocuments({
              subscriptionId: future.id,
            }),
            1,
          );
        },
      );

      await t.test(
        "void rechecks erasure after waiting for the member lock",
        async (t) => {
          const userId = new ObjectId();
          const period = await sell(userId, 5_000);
          const paid = await pay(period.id, 1_000);
          assert.equal(paid.status, "recorded");
          if (paid.status !== "recorded") return;
          const key = subscriptionUserLockKey(userId.toHexString());
          const attempted = signal();
          const originalSet = redis.set;
          const set = t.mock.method(
            redis,
            "set",
            async (...args: Parameters<typeof originalSet>) => {
              const result = await originalSet.apply(redis, args);
              if (args[0] === key && result === null) attempted.resolve();
              return result;
            },
          );
          let pending: ReturnType<typeof voidPayment> | undefined;
          try {
            await withRedisLock(
              key,
              USER_LOCK_LEASE_MS,
              USER_LOCK_WAIT_MS,
              async () => {
                pending = voidPayment(
                  paid.payment._id,
                  owner.id,
                  "Private void reason",
                );
                assert.equal(
                  await Promise.race([
                    attempted.promise.then(() => "waiting"),
                    pending.then(() => "finished"),
                  ]),
                  "waiting",
                );
                await anonymisePaymentsForUser(userId.toHexString());
              },
            );
            assert.equal((await pending)?.status, "not-found");
            assert.equal(
              (await voidPayment(paid.payment._id, owner.id, "Try again"))
                .status,
              "not-found",
            );
            const response = await request<ApiErrorResponse>(
              owner.cookie,
              `/payments/${paid.payment._id.toHexString()}/void`,
              { reason: "Try again" },
            );
            assert.equal(response.status, 404);
            assert.equal(response.body.code, "PAYMENT_NOT_FOUND");
            const row = await paymentCollection().findOne({
              _id: paid.payment._id,
            });
            assert.equal(row?.userId, null);
            assert.equal(row?.void, null);
          } finally {
            await pending;
            set.mock.restore();
          }
        },
      );

      await t.test(
        "deletion waits for the void audit and erases both reasons",
        async (t) => {
          const userId = new ObjectId();
          const period = await sell(userId, 5_000);
          const paid = await pay(period.id, 1_000);
          assert.equal(paid.status, "recorded");
          if (paid.status !== "recorded") return;
          const deletion = await db
            .collection("deletion_requests")
            .insertOne({ userId, status: "pending", requestedAt: new Date() });
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
                args[0].action === "payment-voided" &&
                args[0].targetId === userId.toHexString()
              ) {
                auditing.resolve();
                await releaseAudit.promise;
              }
              return originalInsert.apply(this, args);
            },
          );
          const key = subscriptionUserLockKey(userId.toHexString());
          const attempted = signal();
          const originalSet = redis.set;
          t.mock.method(
            redis,
            "set",
            async (...args: Parameters<typeof originalSet>) => {
              const result = await originalSet.apply(redis, args);
              if (args[0] === key && result === null) attempted.resolve();
              return result;
            },
          );
          const voiding = request<PaymentResult>(
            owner.cookie,
            `/payments/${paid.payment._id.toHexString()}/void`,
            { reason: "Private reason to erase" },
          );
          await auditing.promise;
          const approval = request(
            owner.cookie,
            `/deletion-requests/${deletion.insertedId.toHexString()}/approve`,
          );
          try {
            assert.equal(
              await Promise.race([
                attempted.promise.then(() => "waiting"),
                approval.then(() => "approved"),
              ]),
              "waiting",
            );
          } finally {
            releaseAudit.resolve();
            await Promise.all([voiding, approval]);
          }
          assert.equal((await voiding).status, 200);
          assert.equal((await approval).status, 200);
          const row = await paymentCollection().findOne({
            _id: paid.payment._id,
          });
          assert.equal(row?.userId, null);
          assert.equal(row?.void?.reason, null);
          const audit = await db.collection("audit_logs").findOne({
            action: "payment-voided",
            targetId: userId.toHexString(),
          });
          assert.ok(audit);
          assert.equal(audit.details.reason, undefined);
        },
      );

      await t.test("a void frees room for a new payment", async () => {
        const period = await sell(new ObjectId(), 5_000);
        const first = await pay(period.id, 5_000);
        assert.equal((await pay(period.id, 1)).status, "exceeds-balance");
        if (first.status !== "recorded") return assert.fail("not recorded");
        await voidPayment(first.payment._id, "owner", "wrong amount");
        assert.equal((await pay(period.id, 5_000)).status, "recorded");
      });

      await t.test(
        "the cash report cuts days at local midnight and skips voids",
        async () => {
          const cashGym = new ObjectId().toHexString();
          const zone = "Europe/Istanbul"; // UTC+3, no daylight saving
          const base = {
            subscriptionId: new ObjectId(),
            userId: null,
            gymId: cashGym,
            currency: "TRY" as const,
            note: null,
            packageName: "Cash pkg",
            void: null,
          };
          const row = (
            iso: string,
            amountMinor: number,
            method: "cash" | "card",
            overrides: Record<string, unknown> = {},
          ) => ({
            ...base,
            _id: new ObjectId(),
            amountMinor,
            method,
            paidAt: new Date(iso),
            recordedBy: "staff-1",
            requestId: randomUUID(),
            ...overrides,
          });
          await db.collection("payments").insertMany([
            // 2026-03-01 23:59:59 local: the day before
            row("2026-03-01T20:59:59.000Z", 111, "cash"),
            // 2026-03-02 00:00:00 local: first instant of the day
            row("2026-03-01T21:00:00.000Z", 1_000, "cash"),
            row("2026-03-02T10:00:00.000Z", 500, "card"),
            // 2026-03-02 23:59:59.999 local: last instant of the day
            row("2026-03-02T20:59:59.999Z", 250, "cash"),
            // voided that day: listed apart, not in the totals
            row("2026-03-02T11:00:00.000Z", 9_999, "cash", {
              void: { at: new Date(), by: "owner", reason: "oops" },
            }),
            // 2026-03-03 00:00:00 local: the next day
            row("2026-03-02T21:00:00.000Z", 222, "cash"),
            // another gym, same day
            row("2026-03-02T10:00:00.000Z", 777, "cash", {
              gymId: "f".repeat(24),
            }),
          ] as never[]);

          const report = await buildCashReport(cashGym, "2026-03-02", zone);
          assert.equal(report.day, "2026-03-02");
          assert.equal(report.totals.length, 1);
          const totals = report.totals[0]!;
          assert.equal(totals.totalMinor, 1_750);
          assert.equal(totals.count, 3);
          assert.deepEqual(
            totals.byMethod.map((m) => [m.method, m.totalMinor]),
            [
              ["cash", 1_250],
              ["card", 500],
            ],
          );
          assert.equal(report.payments.length, 3);
          assert.equal(report.voided.length, 1);
          assert.equal(report.voided[0]?.amountMinor, 9_999);
          assert.equal(report.truncated, false);

          const previous = await buildCashReport(cashGym, "2026-03-01", zone);
          assert.equal(previous.totals[0]?.totalMinor, 111);
          const empty = await buildCashReport(cashGym, "2026-03-10", zone);
          assert.deepEqual(empty.totals, []);
          assert.equal(empty.truncated, false);
        },
      );

      await t.test(
        "cash totals cover rows beyond the cap across currencies, methods and staff",
        async () => {
          const gymId = new ObjectId().toHexString();
          const tailStaff = new ObjectId();
          await db.collection("user").insertOne({
            _id: tailStaff,
            name: "Tail recorder",
          });
          const row = {
            subscriptionId: new ObjectId(),
            userId: null,
            gymId,
            amountMinor: 100,
            currency: "TRY" as const,
            method: "cash" as const,
            paidAt: new Date("2026-03-02T10:00:00Z"),
            note: null,
            recordedBy: "staff",
            packageName: "Bulk package",
            void: null,
          };
          await paymentCollection().insertMany([
            {
              ...row,
              requestId: randomUUID(),
              paidAt: new Date("2026-03-02T09:00:00Z"),
              amountMinor: 999_999,
              void: { at: new Date(), by: "owner", reason: "Mistake" },
            },
            ...Array.from({ length: 5000 }, () => ({
              ...row,
              requestId: randomUUID(),
            })),
            {
              ...row,
              requestId: randomUUID(),
              paidAt: new Date("2026-03-02T11:00:00Z"),
              currency: "EUR",
              method: "transfer",
              amountMinor: 700,
              recordedBy: tailStaff.toHexString(),
            },
            {
              ...row,
              requestId: randomUUID(),
              paidAt: new Date("2026-03-02T12:00:00Z"),
              method: "card",
              amountMinor: 300,
              recordedBy: tailStaff.toHexString(),
            },
          ]);
          const report = await buildCashReport(
            gymId,
            "2026-03-02",
            "Europe/Istanbul",
          );
          assert.equal(report.truncated, true);
          assert.equal(report.payments.length + report.voided.length, 5000);
          assert.equal(report.voided.length, 1);
          const tryTotals = report.totals.find((row) => row.currency === "TRY");
          assert.deepEqual(tryTotals, {
            currency: "TRY",
            totalMinor: 500_300,
            count: 5001,
            byMethod: [
              { method: "cash", totalMinor: 500_000, count: 5000 },
              { method: "card", totalMinor: 300, count: 1 },
            ],
            byStaff: [
              { userId: "staff", name: null, totalMinor: 500_000, count: 5000 },
              {
                userId: tailStaff.toHexString(),
                name: "Tail recorder",
                totalMinor: 300,
                count: 1,
              },
            ],
          });
          assert.deepEqual(
            report.totals.find((row) => row.currency === "EUR"),
            {
              currency: "EUR",
              totalMinor: 700,
              count: 1,
              byMethod: [{ method: "transfer", totalMinor: 700, count: 1 }],
              byStaff: [
                {
                  userId: tailStaff.toHexString(),
                  name: "Tail recorder",
                  totalMinor: 700,
                  count: 1,
                },
              ],
            },
          );
        },
      );

      await t.test(
        "account deletion anonymises payments but keeps the sums",
        async () => {
          const user = new ObjectId();
          const other = new ObjectId();
          const anonGym = new ObjectId().toHexString();
          const period = await sell(user, 10_000, {
            gymIds: [new ObjectId(anonGym)],
          });
          const otherPeriod = await sell(other, 10_000, {
            gymIds: [new ObjectId(anonGym)],
          });
          const kept = await recordPayment({
            subscriptionId: period.id,
            amountMinor: 4_000,
            method: "card",
            gymId: anonGym,
            note: "member said hello",
            requestId: randomUUID(),
            recordedBy: "staff-9",
          });
          const wrong = await recordPayment({
            subscriptionId: period.id,
            amountMinor: 1_000,
            method: "cash",
            gymId: anonGym,
            note: "private note",
            requestId: randomUUID(),
            recordedBy: "staff-9",
          });
          const untouched = await recordPayment({
            subscriptionId: otherPeriod.id,
            amountMinor: 2_000,
            method: "cash",
            gymId: anonGym,
            note: "other member note",
            requestId: randomUUID(),
            recordedBy: "staff-9",
          });
          assert.ok(
            kept.status === "recorded" &&
              wrong.status === "recorded" &&
              untouched.status === "recorded",
          );
          if (wrong.status !== "recorded" || kept.status !== "recorded") return;
          await voidPayment(
            wrong.payment._id,
            "owner",
            "free text about member",
          );

          const before = await paymentCollection()
            .find({ gymId: anonGym })
            .toArray();
          const sumBefore = before
            .filter((p) => !p.void)
            .reduce((sum, p) => sum + p.amountMinor, 0);

          assert.equal(await anonymisePaymentsForUser(user.toHexString()), 2);

          const rows = await paymentCollection()
            .find({ subscriptionId: period.id })
            .toArray();
          assert.equal(rows.length, 2);
          for (const payment of rows) {
            assert.equal(payment.userId, null);
            assert.equal(payment.note, null);
            assert.equal(payment.recordedBy, "staff-9");
            assert.equal(payment.packageName, "Test package");
            assert.equal(payment.gymId, anonGym);
            assert.equal(payment.currency, "TRY");
          }
          const keptRow = rows.find((p) => p._id.equals(kept.payment._id))!;
          assert.equal(keptRow.void, null); // still not a void object
          assert.equal(keptRow.amountMinor, 4_000);
          const voidedRow = rows.find((p) => p._id.equals(wrong.payment._id))!;
          assert.equal(voidedRow.void?.reason, null);
          assert.equal(voidedRow.void?.by, "owner");
          assert.ok(voidedRow.void?.at instanceof Date);

          const otherRow = await paymentCollection().findOne({
            subscriptionId: otherPeriod.id,
          });
          assert.equal(otherRow?.userId, other.toHexString());
          assert.equal(otherRow?.note, "other member note");

          const after = await paymentCollection()
            .find({ gymId: anonGym })
            .toArray();
          assert.equal(
            after
              .filter((p) => !p.void)
              .reduce((sum, p) => sum + p.amountMinor, 0),
            sumBefore,
          );
          // Running it again changes nothing.
          assert.equal(await anonymisePaymentsForUser(user.toHexString()), 0);
        },
      );

      await t.test(
        "debtors list overdue first, then due date, then balance",
        async () => {
          const debtGym = new ObjectId();
          const at = (days: number) => new Date(Date.now() + days * DAY);
          const create = async (
            priceMinor: number,
            nextPaymentDue: Date | null,
            gymIds = [debtGym],
          ) =>
            (await sell(new ObjectId(), priceMinor, { gymIds, nextPaymentDue }))
              .id;
          const farFuture = await create(1_000, at(30));
          const sameDue = at(-5);
          const overdueSmall = await create(1_000, sameDue);
          const overdueBig = await create(9_000, sameDue);
          const overdueOlder = await create(500, at(-20));
          const noDate = await create(700, null);
          const paidInFull = await create(1_000, at(-3));
          const voidedOnly = await create(2_000, at(-1));
          const free = await create(0, null);
          const elsewhere = await create(1_000, at(-1), [otherGym]);
          const legacyUser = new ObjectId();
          await subscriptionCollection().insertOne({
            userId: legacyUser,
            startsAt: at(-5),
            endsAt: at(5),
            gymIds: [debtGym],
            note: null,
            createdBy: "old",
            createdAt: new Date(),
          });

          const paidRow = await recordPaymentFor(paidInFull, 1_000, debtGym);
          assert.equal(paidRow, "recorded");
          const partial = await recordPaymentFor(overdueBig, 4_000, debtGym);
          assert.equal(partial, "recorded");
          const voidTarget = await pay(voidedOnly, 2_000, { gymId: debtGym });
          assert.equal(voidTarget.status, "recorded");
          if (voidTarget.status === "recorded") {
            await voidPayment(voidTarget.payment._id, "owner", "refunded");
          }

          const all: string[] = [];
          let cursor: string | undefined;
          const balances: number[] = [];
          for (let guard = 0; guard < 20; guard++) {
            const page = await listDebtors({
              gymId: debtGym.toHexString(),
              limit: 2,
              cursor,
            });
            for (const item of page.items) {
              all.push(item.subscriptionId);
              balances.push(item.balanceMinor);
            }
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
          }
          const ids = (...docs: ObjectId[]) => docs.map((d) => d.toHexString());
          // overdue by due date (-20 first), the -5 pair with the larger balance first
          // (voidedOnly -1 is also overdue), then the future, then undated.
          assert.deepEqual(
            all,
            ids(
              overdueOlder,
              overdueBig,
              overdueSmall,
              voidedOnly,
              farFuture,
              noDate,
            ),
          );
          assert.deepEqual(balances, [500, 5_000, 1_000, 2_000, 1_000, 700]);
          assert.ok(!all.includes(paidInFull.toHexString()));
          assert.ok(!all.includes(free.toHexString()));
          assert.ok(!all.includes(elsewhere.toHexString()));
          assert.equal(all.length, new Set(all).size);

          const firstPage = await listDebtors({
            gymId: debtGym.toHexString(),
            limit: 3,
          });
          assert.equal(firstPage.items[0]?.overdue, true);
          assert.equal(firstPage.items.at(-1)?.overdue, true);
        },
      );

      async function recordPaymentFor(
        id: ObjectId,
        amountMinor: number,
        gym: ObjectId,
      ): Promise<string> {
        return (await pay(id, amountMinor, { gymId: gym })).status;
      }

      await t.test(
        "a member's billing summary shows the package and balance",
        async () => {
          const user = new ObjectId();
          const period = await sell(user, 6_000, {
            nextPaymentDue: new Date(Date.now() + 3 * DAY),
          });
          await pay(period.id, 1_000);
          const summary = await getSubscriptionSummary(user.toHexString());
          assert.deepEqual(
            { ...summary.billing, nextPaymentDue: undefined },
            {
              packageName: "Test package",
              balanceMinor: 5_000,
              currency: "TRY",
              nextPaymentDue: undefined,
            },
          );
          assert.ok(summary.billing?.nextPaymentDue);
          const none = await getSubscriptionSummary(
            new ObjectId().toHexString(),
          );
          assert.equal(none.billing, null);
        },
      );

      await t.test(
        "payments recheck the period and user inside the subscription lock",
        async (t) => {
          for (const missing of ["period", "user"] as const) {
            const userId = new ObjectId();
            const period = await sell(userId, 10_000);
            const requestId = randomUUID();
            assert.equal(
              (await pay(period.id, 1_000, { requestId })).status,
              "recorded",
            );
            const key = subscriptionUserLockKey(userId.toHexString());
            const attempted = signal();
            const originalSet = redis.set;
            const set = t.mock.method(
              redis,
              "set",
              async (...args: Parameters<typeof originalSet>) => {
                const result = await originalSet.apply(redis, args);
                if (args[0] === key && result === null) attempted.resolve();
                return result;
              },
            );
            let pending: ReturnType<typeof pay> | undefined;
            try {
              await withRedisLock(
                key,
                USER_LOCK_LEASE_MS,
                USER_LOCK_WAIT_MS,
                async () => {
                  pending = pay(period.id, 1_000, { requestId });
                  await attempted.promise;
                  if (missing === "period") {
                    await subscriptionCollection().deleteOne({
                      _id: period.id,
                    });
                  } else {
                    await db.collection("user").deleteOne({ _id: userId });
                  }
                },
              );
              assert.equal((await pending)?.status, "not-found");
              assert.equal((await pay(period.id, 1_000)).status, "not-found");
              assert.equal(
                await paymentCollection().countDocuments({
                  subscriptionId: period.id,
                }),
                1,
              );
            } finally {
              set.mock.restore();
            }
          }
        },
      );

      await t.test(
        "deletion waits for an in-flight payment and anonymises its inserted row",
        async (t) => {
          const userId = new ObjectId();
          const period = await sell(userId, 10_000);
          const deletion = await db.collection("deletion_requests").insertOne({
            userId,
            status: "pending",
            requestedAt: new Date(),
            email: "deleted@example.com",
            name: "Deleted member",
          });
          const requestId = randomUUID();
          const inserting = signal();
          const releaseInsert = signal();
          const originalInsert = Collection.prototype.insertOne;
          t.mock.method(
            Collection.prototype,
            "insertOne",
            async function (
              this: Collection,
              ...args: Parameters<typeof originalInsert>
            ) {
              if (
                this.collectionName === "payments" &&
                args[0].requestId === requestId
              ) {
                inserting.resolve();
                await releaseInsert.promise;
              }
              return originalInsert.apply(this, args);
            },
          );
          const key = subscriptionUserLockKey(userId.toHexString());
          const attempted = signal();
          const originalSet = redis.set;
          t.mock.method(
            redis,
            "set",
            async (...args: Parameters<typeof originalSet>) => {
              const result = await originalSet.apply(redis, args);
              if (args[0] === key && result === null) attempted.resolve();
              return result;
            },
          );
          const payment = recordPayment({
            subscriptionId: period.id,
            amountMinor: 1_000,
            method: "cash",
            gymId: gymA.toHexString(),
            note: "Private note from an in-flight payment",
            requestId,
            recordedBy: owner.id,
          });
          await inserting.promise;
          const approval = request<{ ok: boolean }>(
            owner.cookie,
            `/deletion-requests/${deletion.insertedId.toHexString()}/approve`,
          );
          try {
            assert.equal(
              await Promise.race([
                attempted.promise.then(() => "waiting"),
                approval.then(() => "approved"),
              ]),
              "waiting",
            );
            assert.ok(await db.collection("user").findOne({ _id: userId }));
          } finally {
            releaseInsert.resolve();
            await payment;
            await approval;
          }
          assert.equal((await payment).status, "recorded");
          assert.equal((await approval).status, 200);
          const row = await paymentCollection().findOne({ requestId });
          assert.ok(row);
          assert.equal(row.userId, null);
          assert.equal(row.note, null);
          assert.equal(
            await subscriptionCollection().findOne({ _id: period.id }),
            null,
          );
          assert.equal(
            await db.collection("user").findOne({ _id: userId }),
            null,
          );
        },
      );

      await t.test(
        "deletion lock timeout returns SUBSCRIPTION_BUSY and leaves a retryable request",
        async () => {
          const userId = new ObjectId();
          const period = await sell(userId, 10_000);
          const paid = await recordPayment({
            subscriptionId: period.id,
            amountMinor: 1_000,
            method: "cash",
            gymId: gymA.toHexString(),
            note: "Retained until erasure can run",
            requestId: randomUUID(),
            recordedBy: owner.id,
          });
          assert.equal(paid.status, "recorded");
          const deletion = await db.collection("deletion_requests").insertOne({
            userId,
            status: "pending",
            requestedAt: new Date(),
          });
          const path = `/deletion-requests/${deletion.insertedId.toHexString()}/approve`;
          const key = subscriptionUserLockKey(userId.toHexString());
          await redis.set(key, "held-by-another-operation", {
            expiration: { type: "PX", value: 30_000 },
          });
          try {
            const busy = await request<ApiErrorResponse>(owner.cookie, path);
            assert.equal(busy.status, 503);
            assert.equal(busy.body.code, "SUBSCRIPTION_BUSY");
            const retryable = await db.collection("deletion_requests").findOne({
              _id: deletion.insertedId,
            });
            assert.equal(retryable?.status, "pending");
            assert.equal(retryable?.resolvedAt, undefined);
            assert.equal(retryable?.resolvedBy, undefined);
            assert.ok(await db.collection("user").findOne({ _id: userId }));
            assert.ok(
              await subscriptionCollection().findOne({ _id: period.id }),
            );
            const row = await paymentCollection().findOne({
              subscriptionId: period.id,
            });
            assert.equal(row?.userId, userId.toHexString());
            assert.equal(row?.note, "Retained until erasure can run");
          } finally {
            await redis.del(key);
          }
          assert.equal((await request(owner.cookie, path)).status, 200);
          const row = await paymentCollection().findOne({
            subscriptionId: period.id,
          });
          assert.equal(row?.userId, null);
          assert.equal(row?.note, null);
        },
      );

      await t.test(
        "concurrent package edits audit the snapshots atomically replaced",
        async (t) => {
          const created = await request<Package>(owner.cookie, "/packages", {
            name: "Concurrent package",
            duration: month,
            priceMinor: 1_000,
          });
          assert.equal(created.status, 201);
          const id = new ObjectId(created.body.id);
          const bothUpdating = signal();
          let arrivals = 0;
          const originalUpdate = Collection.prototype.findOneAndUpdate;
          t.mock.method(
            Collection.prototype,
            "findOneAndUpdate",
            async function (
              this: Collection,
              ...args: Parameters<typeof originalUpdate>
            ) {
              if (
                this.collectionName === "packages" &&
                id.equals(args[0]._id)
              ) {
                if (++arrivals === 2) bothUpdating.resolve();
                await bothUpdating.promise;
              }
              return originalUpdate.apply(this, args);
            },
          );
          const results = await Promise.all(
            [2_000, 3_000].map((priceMinor) =>
              request<Package>(
                owner.cookie,
                `/packages/${created.body.id}`,
                { priceMinor },
                "PATCH",
              ),
            ),
          );
          assert.deepEqual(
            results.map((result) => result.status),
            [200, 200],
          );
          const audits = await db
            .collection("audit_logs")
            .find({
              action: "package-updated",
              targetId: created.body.id,
            })
            .toArray();
          assert.equal(audits.length, 2);
          const first = audits.find(
            (row) => row.details.before.priceMinor === 1_000,
          );
          assert.ok(first);
          const second = audits.find((row) => row !== first);
          assert.equal(
            second?.details.before.priceMinor,
            first.details.after.priceMinor,
          );
          const stored = await db.collection("packages").findOne({ _id: id });
          assert.equal(stored?.priceMinor, second?.details.after.priceMinor);
          assert.deepEqual(
            results.map((result) => result.body.priceMinor).sort(),
            [2_000, 3_000],
          );
        },
      );

      await t.test(
        "the legacy package seed is idempotent and never overwrites edits",
        async () => {
          // Same database as the rest of the test: a second one would only add
          // more open files to a Mongo container that runs with a low limit.
          const seedDb = db;
          try {
            const first = await seedLegacyMonthPackages(seedDb);
            assert.deepEqual(first, { skipped: false, insertedCount: 4 });
            const packages = seedDb.collection("packages");
            assert.equal(
              await packages.countDocuments({
                legacyMonths: { $exists: true },
              }),
              4,
            );
            const second = await seedLegacyMonthPackages(seedDb);
            assert.equal(second.skipped, true);

            const twelve = await packages.findOne({ legacyMonths: 12 });
            assert.equal(twelve?.name, "12 Aylık");
            assert.equal(twelve?.priceMinor, null);
            assert.deepEqual(twelve?.duration, { unit: "month", value: 12 });
            await packages.updateOne(
              { legacyMonths: 12 },
              { $set: { name: "Yearly", priceMinor: 700_000 } },
            );

            // Markers gone and several concurrent starts: still four packages.
            await seedDb.collection("migration_markers").deleteMany({});
            await Promise.all(
              Array.from({ length: 5 }, () => seedLegacyMonthPackages(seedDb)),
            );
            assert.equal(
              await packages.countDocuments({
                legacyMonths: { $exists: true },
              }),
              4,
            );
            const renamed = await packages.findOne({ legacyMonths: 12 });
            assert.equal(renamed?.name, "Yearly");
            assert.equal(renamed?.priceMinor, 700_000);
          } finally {
            await seedDb.dropDatabase().catch(() => undefined);
          }
        },
      );
    } finally {
      server.close();
      await db.dropDatabase().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await mongoClient.close();
    }
  },
);
