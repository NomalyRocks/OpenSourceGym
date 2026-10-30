import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { createClient } from "redis";
import { createAuthSecondaryStorage } from "../authStorage.js";

const redisUri = process.env.TEST_REDIS_URL;

test(
  "auth secondary storage preserves atomic consumption and fixed-window counters",
  { skip: redisUri ? false : "TEST_REDIS_URL is not defined" },
  async (t) => {
    const isolatedRedisUrl = new URL(redisUri!);
    // Other integration suites flush their own databases. Use a separate one
    // and clean up only this test's random keys, never the entire database.
    isolatedRedisUrl.pathname = "/5";
    const first = createClient({
      url: isolatedRedisUrl.toString(),
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    const second = first.duplicate();
    const storage = createAuthSecondaryStorage(first);
    const otherStorage = createAuthSecondaryStorage(second);
    const keys: string[] = [];
    function newKey(): string {
      const key = `og:test:auth-storage:${randomUUID()}`;
      keys.push(key);
      return key;
    }
    for (const client of [first, second]) {
      client.on("error", (error) => t.diagnostic(String(error)));
    }
    t.after(async () => {
      for (const client of [first, second]) {
        if (client.isReady && keys.length > 0) await client.del(keys);
        if (client.isOpen) await client.quit();
      }
    });
    await Promise.all([first.connect(), second.connect()]);

    await t.test(
      "only one concurrent client consumes a stored value",
      async () => {
        const key = newKey();
        await storage.set(key, "single-use", 60);
        const results = await Promise.all(
          Array.from({ length: 64 }, (_, index) =>
            (index % 2 === 0 ? storage : otherStorage).getAndDelete(key),
          ),
        );
        assert.equal(
          results.filter((value) => value === "single-use").length,
          1,
        );
        assert.equal(results.filter((value) => value === null).length, 63);
        assert.equal(await storage.getAndDelete(key), null);
      },
    );

    await t.test(
      "concurrent increments create one expiring counter without losing updates",
      async () => {
        const key = newKey();
        const results = await Promise.all(
          Array.from({ length: 64 }, (_, index) =>
            (index % 2 === 0 ? storage : otherStorage).increment(key, 60),
          ),
        );
        assert.deepEqual(
          results.sort((left, right) => left - right),
          Array.from({ length: 64 }, (_, index) => index + 1),
        );
        assert.equal(await first.get(key), "64");
        const ttl = await first.pTTL(key);
        assert.ok(ttl > 0 && ttl <= 60_000, `Unexpected counter TTL: ${ttl}`);
      },
    );

    await t.test(
      "later increments preserve the existing expiry, including a zero counter",
      async () => {
        const key = newKey();
        assert.equal(await storage.increment(key, 60), 1);
        await first.pExpire(key, 15_000);
        assert.equal(await otherStorage.increment(key, 120), 2);
        const ttl = await first.pTTL(key);
        assert.ok(
          ttl > 0 && ttl <= 15_000,
          `Counter window was extended: ${ttl}`,
        );

        await first.set(key, "0", {
          expiration: { type: "PX", value: 12_000 },
        });
        assert.equal(await storage.increment(key, 120), 1);
        const zeroTtl = await first.pTTL(key);
        assert.ok(
          zeroTtl > 0 && zeroTtl <= 12_000,
          `Existing zero counter window was extended: ${zeroTtl}`,
        );
      },
    );

    await t.test(
      "an existing persistent counter does not gain an expiry",
      async () => {
        const key = newKey();
        await first.set(key, "0");
        assert.equal(await storage.increment(key, 60), 1);
        assert.equal(await first.pTTL(key), -1);
      },
    );

    await t.test(
      "a legacy non-integer value restarts the window instead of failing",
      async () => {
        const key = newKey();
        await first.set(key, JSON.stringify({ count: 3, lastRequest: 1 }), {
          expiration: { type: "EX", value: 60 },
        });
        assert.equal(await storage.increment(key, 30), 1);
        assert.equal(await otherStorage.increment(key, 30), 2);
        const ttl = await first.pTTL(key);
        assert.ok(ttl > 0 && ttl <= 30_000, `Unexpected restarted TTL: ${ttl}`);
      },
    );

    await t.test("an expired counter starts a new window at one", async () => {
      const key = newKey();
      assert.equal(await storage.increment(key, 1), 1);
      await setTimeout(1100);
      assert.equal(await first.get(key), null);
      assert.equal(await otherStorage.increment(key, 60), 1);
      const ttl = await first.pTTL(key);
      assert.ok(ttl > 0 && ttl <= 60_000, `Unexpected new window TTL: ${ttl}`);
    });
  },
);
