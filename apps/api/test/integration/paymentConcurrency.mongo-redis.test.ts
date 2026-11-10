import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { Collection, ObjectId } from "mongodb";
import type { Subscription } from "@opengym/shared";
import type { SaleSnapshot } from "../../src/features/subscriptions/subscriptions.js";

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
  "payment concurrency and freeze-adjusted billing regressions",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async (t) => {
    const databaseName = `opengym_payment_concurrency_${randomUUID().replaceAll("-", "")}`;
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = redisUri!;
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "payment-concurrency-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { db, mongoClient },
      { connectRedis, redis },
      { ensurePaymentIndexes },
      {
        cancelScheduledSubscription,
        getSubscriptionSummary,
        subscriptionCollection,
        subscriptionUserLockKey,
      },
      { recordPayment, standingOf, voidPayment },
      { paymentCollection },
      { freezeCollection },
      { default: express },
      { createServer },
      { auth },
      { paymentsRouter },
    ] = await Promise.all([
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/core/indexes.js"),
      import("../../src/features/subscriptions/subscriptions.js"),
      import("../../src/features/payments/payments.js"),
      import("../../src/features/payments/paymentStore.js"),
      import("../../src/features/freeze/freezeCredit.js"),
      import("express"),
      import("node:http"),
      import("../../src/auth/auth.js"),
      import("../../src/features/payments/router.js"),
    ]);

    const app = express();
    app.use(express.json());
    app.use("/api/admin", paymentsRouter);
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
    const gymId = new ObjectId();
    const sale: SaleSnapshot = {
      packageId: null,
      packageName: "Package A",
      duration: { unit: "month", value: 1 },
      listPriceMinor: 10_000,
      priceMinor: 10_000,
      currency: "TRY",
      nextPaymentDue: new Date("2026-11-01T00:00:00.000Z"),
    };

    async function createPeriod(
      userId: ObjectId,
      startsAt = new Date(Date.now() - DAY),
      endsAt = new Date(Date.now() + 29 * DAY),
      snapshot = sale,
    ) {
      await db.collection("user").updateOne(
        { _id: userId },
        {
          $setOnInsert: {
            name: "Concurrency member",
            email: `${userId.toHexString()}@example.com`,
            role: "member",
          },
        },
        { upsert: true },
      );
      const inserted = await subscriptionCollection().insertOne({
        userId,
        startsAt,
        endsAt,
        gymIds: [gymId],
        note: null,
        createdBy: "owner",
        createdAt: new Date(),
        sale: snapshot,
      });
      return inserted.insertedId;
    }

    function pay(subscriptionId: ObjectId, amountMinor: number) {
      return recordPayment({
        subscriptionId,
        amountMinor,
        method: "cash",
        gymId: gymId.toHexString(),
        note: null,
        recordedBy: "owner",
        requestId: randomUUID(),
      });
    }

    // Hold the first operation just after the real Redis acquisition until the
    // second operation has read its preview and tried the same lock.
    async function contend<T, U>(
      context: TestContext,
      userId: ObjectId,
      first: () => Promise<T>,
      second: () => Promise<U>,
    ): Promise<[T, U]> {
      const key = subscriptionUserLockKey(userId.toHexString());
      const acquired = signal();
      const waiting = signal();
      const release = signal();
      let held = false;
      const originalSet = redis.set;
      const mocked = context.mock.method(
        redis,
        "set",
        async (...args: Parameters<typeof originalSet>) => {
          const result = await originalSet.apply(redis, args);
          if (args[0] === key) {
            if (result === "OK" && !held) {
              held = true;
              acquired.resolve();
              await release.promise;
            } else if (result === null) {
              waiting.resolve();
            }
          }
          return result;
        },
      );
      const firstPending = first();
      let secondPending: Promise<U> | undefined;
      try {
        await Promise.race([
          acquired.promise,
          firstPending.then(() => assert.fail("The first operation must lock")),
        ]);
        secondPending = second();
        await Promise.race([
          waiting.promise,
          secondPending.then(() =>
            assert.fail("The second operation must wait for the member lock"),
          ),
        ]);
        release.resolve();
        return await Promise.all([firstPending, secondPending]);
      } finally {
        release.resolve();
        await Promise.allSettled([firstPending, secondPending]);
        mocked.mock.restore();
      }
    }

    try {
      await mongoClient.connect();
      await connectRedis();
      await ensurePaymentIndexes(db);

      await t.test(
        "concurrent due-date edits audit a continuous before/after chain",
        async (t) => {
          const email = `${randomUUID()}@example.com`;
          const password = "test-password-1234";
          const signedUp = await auth.api.signUpEmail({
            body: {
              email,
              password,
              name: "Concurrency Owner",
              firstName: "Concurrency",
              lastName: "Owner",
              phone: "5300000001",
              dataProcessingAccepted: true,
              privacyAccepted: true,
            },
          });
          await db
            .collection("user")
            .updateOne(
              { _id: new ObjectId(signedUp.user.id) },
              { $set: { role: "owner", emailVerified: true } },
            );
          const signedIn = await auth.api.signInEmail({
            body: { email, password },
            returnHeaders: true,
          });
          const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
          assert.ok(cookie);
          const userId = new ObjectId();
          const id = await createPeriod(userId);
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
                this.collectionName === "subscriptions" &&
                id.equals(args[0]._id)
              ) {
                if (++arrivals === 2) bothUpdating.resolve();
                await bothUpdating.promise;
              }
              return originalUpdate.apply(this, args);
            },
          );
          const dates = [
            "2026-11-15T00:00:00.000Z",
            "2026-11-20T00:00:00.000Z",
          ];
          const results = await Promise.all(
            dates.map(async (nextPaymentDue) => {
              const response = await fetch(`${base}/subscriptions/${id}/sale`, {
                method: "PATCH",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ nextPaymentDue }),
              });
              assert.equal(response.status, 200);
              return (await response.json()) as Subscription;
            }),
          );
          assert.deepEqual(
            results.map((result) => result.sale?.nextPaymentDue).sort(),
            dates,
          );
          const audits = await db
            .collection<{
              action: string;
              targetId: string;
              details: {
                subscriptionId: string;
                before: string;
                after: string;
              };
            }>("audit_logs")
            .find({
              action: "subscription-sale-updated",
              targetId: userId.toHexString(),
              "details.subscriptionId": id.toHexString(),
            })
            .toArray();
          assert.equal(audits.length, 2);
          const first = audits.find(
            (row) => row.details.before === sale.nextPaymentDue!.toISOString(),
          );
          assert.ok(first);
          const second = audits.find((row) => row !== first);
          assert.ok(second);
          assert.equal(second.details.before, first.details.after);
          assert.deepEqual(
            audits.map((row) => row.details.after).sort(),
            dates,
          );
          const stored = await subscriptionCollection().findOne({ _id: id });
          assert.equal(
            stored?.sale?.nextPaymentDue?.toISOString(),
            second.details.after,
          );
        },
      );

      for (const withNextPackage of [true, false]) {
        await t.test(
          `billing keeps package A past its original end while frozen (next package: ${withNextPackage})`,
          async () => {
            const userId = new ObjectId();
            const boundary = new Date("2026-11-01T00:00:00.000Z");
            await createPeriod(
              userId,
              new Date("2026-10-01T00:00:00.000Z"),
              boundary,
            );
            if (withNextPackage) {
              await createPeriod(
                userId,
                boundary,
                new Date("2026-12-01T00:00:00.000Z"),
                { ...sale, packageName: "Package B" },
              );
            }
            await freezeCollection().insertOne({
              userId,
              startedAt: new Date("2026-10-25T00:00:00.000Z"),
              startedBy: "owner",
              maxDays: 30,
              endedAt: null,
              endedBy: null,
              endReason: null,
              creditedMs: null,
              plan: null,
              creditApplied: false,
            });
            const summary = await getSubscriptionSummary(
              userId.toHexString(),
              new Date("2026-11-10T00:00:00.000Z"),
            );
            assert.equal(summary.active, true);
            assert.ok(summary.freeze);
            assert.equal(summary.billing?.packageName, "Package A");
            assert.equal(
              summary.billing.balanceMinor,
              withNextPackage ? 20_000 : 10_000,
            );
            assert.equal(summary.billing.currency, "TRY");
            const stored = await subscriptionCollection()
              .find({ userId })
              .sort({ startsAt: 1 })
              .toArray();
            assert.equal(
              stored[0]?.endsAt.toISOString(),
              boundary.toISOString(),
            );
            if (withNextPackage) {
              assert.equal(
                stored[1]?.startsAt.toISOString(),
                boundary.toISOString(),
              );
            }
          },
        );
      }

      for (const payFirst of [true, false]) {
        await t.test(
          `concurrent pay and void preserve the balance (pay first: ${payFirst})`,
          async (t) => {
            const userId = new ObjectId();
            const id = await createPeriod(userId);
            const initial = await pay(id, 6_000);
            assert.equal(initial.status, "recorded");
            if (initial.status !== "recorded")
              assert.fail("Payment not recorded");
            const record = () => pay(id, 4_000);
            const voidInitial = () =>
              voidPayment(initial.payment._id, "owner", "Correcting payment");
            const results = payFirst
              ? await contend(t, userId, record, voidInitial)
              : await contend(t, userId, voidInitial, record);
            const recorded = results[payFirst ? 0 : 1];
            const voided = results[payFirst ? 1 : 0];
            assert.equal(recorded.status, "recorded");
            assert.equal(voided.status, "voided");
            const rows = await paymentCollection()
              .find({ subscriptionId: id })
              .toArray();
            assert.equal(rows.length, 2);
            assert.equal(rows.filter((row) => row.void).length, 1);
            const paidMinor = rows
              .filter((row) => !row.void)
              .reduce((sum, row) => sum + row.amountMinor, 0);
            assert.equal(paidMinor, 4_000);
            assert.deepEqual(await standingOf(id, sale.priceMinor), {
              paidMinor,
              balanceMinor: sale.priceMinor - paidMinor,
            });
            const summary = await getSubscriptionSummary(userId.toHexString());
            assert.equal(summary.billing?.balanceMinor, 6_000);
          },
        );

        await t.test(
          `concurrent cancel and pay cannot both succeed (pay first: ${payFirst})`,
          async (t) => {
            const userId = new ObjectId();
            const id = await createPeriod(
              userId,
              new Date(Date.now() + 10 * DAY),
              new Date(Date.now() + 40 * DAY),
            );
            const record = () => pay(id, 4_000);
            const cancel = () => cancelScheduledSubscription(id, () => true);
            const results = payFirst
              ? await contend(t, userId, record, cancel)
              : await contend(t, userId, cancel, record);
            const recorded = results[payFirst ? 0 : 1];
            const cancelled = results[payFirst ? 1 : 0];
            assert.equal(recorded.status, payFirst ? "recorded" : "not-found");
            assert.equal(
              cancelled.status,
              payFirst ? "has-payments" : "cancelled",
            );
            assert.equal(
              await subscriptionCollection().countDocuments({ _id: id }),
              payFirst ? 1 : 0,
            );
            assert.equal(
              await paymentCollection().countDocuments({ subscriptionId: id }),
              payFirst ? 1 : 0,
            );
          },
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.dropDatabase();
      if (redis.isOpen) await redis.quit();
      await mongoClient.close();
    }
  },
);
