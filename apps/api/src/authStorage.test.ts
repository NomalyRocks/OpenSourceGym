import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "redis";
import { createAuthSecondaryStorage } from "./authStorage.js";

test("auth storage consumes a value with a single GETDEL", async (t) => {
  const client = createClient();
  const consume = t.mock.method(client, "getDel", async () => "single-use");
  const get = t.mock.method(client, "get", () =>
    assert.fail("GET is not atomic"),
  );
  const del = t.mock.method(client, "del", () =>
    assert.fail("DEL is not atomic"),
  );
  const storage = createAuthSecondaryStorage(client);

  assert.equal(await storage.getAndDelete("verification-token"), "single-use");
  assert.equal(consume.mock.callCount(), 1);
  assert.deepEqual(consume.mock.calls[0]?.arguments, ["verification-token"]);
  assert.equal(get.mock.callCount(), 0);
  assert.equal(del.mock.callCount(), 0);
});

test("auth storage increments through one script with the TTL in seconds", async (t) => {
  const client = createClient();
  const evaluate = t.mock.method(client, "eval", async () => 7);
  const storage = createAuthSecondaryStorage(client);

  assert.equal(await storage.increment("rate-limit-counter", 60), 7);
  assert.equal(evaluate.mock.callCount(), 1);
  const [script, options] = evaluate.mock.calls[0]?.arguments ?? [];
  assert.equal(typeof script, "string");
  assert.deepEqual(options, {
    keys: ["rate-limit-counter"],
    arguments: ["60"],
  });
});

test("auth storage rejects a non-numeric counter result", async (t) => {
  const client = createClient();
  t.mock.method(client, "eval", async () => null);
  const storage = createAuthSecondaryStorage(client);

  await assert.rejects(async () => storage.increment("counter", 60), {
    name: "TypeError",
    message: "Redis auth counter returned a non-numeric value",
  });
});

test("auth storage preserves expiring and persistent writes", async (t) => {
  const client = createClient();
  const set = t.mock.method(client, "set", async () => "OK");
  const storage = createAuthSecondaryStorage(client);

  await storage.set("session", "payload", 60);
  await storage.set("persistent", "payload");
  assert.deepEqual(
    set.mock.calls.map((call) => call.arguments),
    [
      ["session", "payload", { expiration: { type: "EX", value: 60 } }],
      ["persistent", "payload"],
    ],
  );
});

test("auth storage rounds a fractional counter TTL up to whole seconds", async (t) => {
  const client = createClient();
  const evaluate = t.mock.method(client, "eval", async () => 1);
  const storage = createAuthSecondaryStorage(client);

  await storage.increment("counter", 0.5);
  await storage.increment("counter", 59.2);
  assert.deepEqual(
    evaluate.mock.calls.map((call) => call.arguments[1]),
    [
      { keys: ["counter"], arguments: ["1"] },
      { keys: ["counter"], arguments: ["60"] },
    ],
  );
});

test("auth storage rejects a non-finite counter TTL", async (t) => {
  const client = createClient();
  const evaluate = t.mock.method(client, "eval", async () => 1);
  const storage = createAuthSecondaryStorage(client);

  await assert.rejects(async () => storage.increment("counter", Number.NaN), {
    name: "RangeError",
  });
  assert.equal(evaluate.mock.callCount(), 0);
});
