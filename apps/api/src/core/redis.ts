import { createClient } from "redis";
import { env } from "./env.js";

export const redis = createClient({ url: env.redisUrl });

redis.on("error", (err) => {
  console.error("redis error:", err);
});

export async function connectRedis(): Promise<void> {
  if (!redis.isOpen) {
    await redis.connect();
  }
}

// Deletes the lock only while it still holds the caller's token. If the lease
// expires and another request acquires it, that request's lock is not released.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Acquires a lock with an ownership token; returns false if already held. */
export async function acquireLock(
  key: string,
  token: string,
  ttlMs: number,
): Promise<boolean> {
  const acquired = await redis.set(key, token, {
    condition: "NX",
    expiration: { type: "PX", value: ttlMs },
  });
  return acquired === "OK";
}

/** Releases a lock acquired with acquireLock (does nothing if not the owner). */
export async function releaseLock(key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [token] });
}
