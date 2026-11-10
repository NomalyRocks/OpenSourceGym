import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { redis } from "../../../../src/core/redis.js";
import {
  gateOpenIdentitySchema,
  gateOpenSchema,
} from "../../../../src/features/gate/receptionInput.js";
import {
  acquirePassageLock,
  gateUserLifecycleLockKey,
  isGateOpenRateLimited,
  withGateUserLifecycleLock,
} from "../../../../src/features/gate/locks.js";
import {
  subscriptionUserLockKey,
  SubscriptionLockTimeoutError,
  withRedisLock,
} from "../../../../src/features/subscriptions/subscriptions.js";

const userId = "abcdef0123456789abcdef01";
const deviceId = "abcdef0123456789abcdef02";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeLocks(t: TestContext, onBlocked?: (key: string) => void) {
  const held = new Map<string, string>();
  t.mock.method(redis, "set", async (key: string, token: string) => {
    if (held.has(key)) {
      onBlocked?.(key);
      return null;
    }
    held.set(key, token);
    return "OK";
  });
  t.mock.method(
    redis,
    "eval",
    async (
      script: string,
      options: { keys: string[]; arguments: string[] },
    ) => {
      const key = options.keys[0]!;
      if (held.get(key) !== options.arguments[0]) return 0;
      if (script.includes('redis.call("del"')) held.delete(key);
      return 1;
    },
  );
  return held;
}

test("reception parsing canonicalizes mixed-case IDs before valid or malformed attempts use them", () => {
  const body = {
    userId: userId.toUpperCase(),
    deviceId: deviceId.toUpperCase(),
    direction: "in",
    reason: "Phone unavailable",
  };
  assert.deepEqual(gateOpenSchema.parse(body), { ...body, userId, deviceId });
  const malformed = { ...body, direction: "both" };
  assert.equal(gateOpenSchema.safeParse(malformed).success, false);
  assert.deepEqual(gateOpenIdentitySchema.parse(malformed), {
    ...body,
    userId,
    deviceId,
    direction: undefined,
  });
});

test("passage and actor rate limits use identical keys for either ObjectId casing", async (t) => {
  const keys: string[][] = [];
  t.mock.method(
    redis,
    "eval",
    async (_script: string, options: { keys: string[] }) => {
      keys.push(options.keys);
      return 1;
    },
  );
  await acquirePassageLock(userId, "one", 3000);
  await acquirePassageLock(userId.toUpperCase(), "two", 3000);
  await isGateOpenRateLimited(userId);
  await isGateOpenRateLimited(userId.toUpperCase());
  assert.deepEqual(
    keys,
    Array.from({ length: 4 }, () => [
      `og:gate-open:${userId}`,
      `og:lock:gate-open:${userId}`,
    ]),
  );
  assert.equal(
    gateUserLifecycleLockKey(userId.toUpperCase()),
    gateUserLifecycleLockKey(userId),
  );
});

test("lifecycle serialization waits for the final audit before deletion erases gate records", async (t) => {
  const blocked = signal();
  const auditing = signal();
  const releaseAudit = signal();
  fakeLocks(t, () => blocked.resolve());
  const history: string[] = [];
  const opening = withGateUserLifecycleLock(userId, async () => {
    // The subscription lock remains available for the passage's freeze work.
    await withRedisLock(
      subscriptionUserLockKey(userId),
      10_000,
      1000,
      async () => {},
    );
    history.push("member name", "staff reason");
    auditing.resolve();
    await releaseAudit.promise;
    history.push("audit staff reason");
  });
  await auditing.promise;
  const deleting = withGateUserLifecycleLock(userId.toUpperCase(), async () => {
    history.length = 0;
  });
  try {
    assert.equal(
      await Promise.race([
        blocked.promise.then(() => "waiting"),
        deleting.then(() => "deleted"),
      ]),
      "waiting",
    );
  } finally {
    releaseAudit.resolve();
    await Promise.all([opening, deleting]);
  }
  assert.deepEqual(history, []);
});

test("a busy lifecycle lock times out using the existing subscription busy error", async (t) => {
  fakeLocks(t);
  await withGateUserLifecycleLock(userId, async () => {
    await assert.rejects(
      withGateUserLifecycleLock(userId, async () =>
        assert.fail("must not read the target"),
      ),
      SubscriptionLockTimeoutError,
    );
  });
});
