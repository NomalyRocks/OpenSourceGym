import type { SecondaryStorage } from "better-auth";
import type { createClient } from "redis";

type StorageClient = Pick<
  ReturnType<typeof createClient>,
  "get" | "getDel" | "set" | "del" | "eval"
>;

// SET NX applies the expiry only when creating the counter. The script keeps
// creation and increment atomic across clients without extending the window.
// A non-integer value (the JSON rate-limit record better-auth 1.6 stored under
// the same keys) would make INCR fail every request, so it restarts the window.
const INCREMENT_COUNTER_SCRIPT = `
if redis.call("set", KEYS[1], "1", "NX", "EX", ARGV[1]) then
  return 1
end
local current = redis.call("get", KEYS[1])
if type(current) ~= "string" or not string.match(current, "^%-?%d+$") then
  redis.call("set", KEYS[1], "1", "EX", ARGV[1])
  return 1
end
return redis.call("incr", KEYS[1])
`;

// Redis EX takes a positive integer; round a fractional window up rather than
// failing the request with "invalid expire time".
function toExpirySeconds(ttl: number): number {
  if (!Number.isFinite(ttl)) {
    throw new RangeError("Redis auth counter TTL must be a finite number");
  }
  return Math.max(1, Math.ceil(ttl));
}

export function createAuthSecondaryStorage(
  client: StorageClient,
): SecondaryStorage {
  return {
    get: (key) => client.get(key),
    getAndDelete: (key) => client.getDel(key),
    increment: async (key, ttl) => {
      const count = await client.eval(INCREMENT_COUNTER_SCRIPT, {
        keys: [key],
        arguments: [String(toExpirySeconds(ttl))],
      });
      if (typeof count !== "number") {
        throw new TypeError("Redis auth counter returned a non-numeric value");
      }
      return count;
    },
    set: async (key, value, ttl) => {
      if (ttl) {
        await client.set(key, value, {
          expiration: { type: "EX", value: ttl },
        });
      } else {
        await client.set(key, value);
      }
    },
    delete: async (key) => {
      await client.del(key);
    },
  };
}
