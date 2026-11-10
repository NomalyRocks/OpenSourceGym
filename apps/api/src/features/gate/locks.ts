import { ObjectId } from "mongodb";
import { withRedisLock } from "../subscriptions/subscriptions.js";
import { redis, releaseLock } from "../../core/redis.js";

// The original QR passage lease used the key now specified for actor counters.
// Keep old QR leases compatible, and atomically move a live lease when its user
// first becomes a reception actor. Numeric counters and UUID leases never mix.
const ACQUIRE_PASSAGE = `
local legacy = redis.call('get', KEYS[1])
if legacy and tonumber(legacy) then
  return redis.call('set', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2]) and 1 or 0
end
if redis.call('exists', KEYS[2]) == 1 then return 0 end
return redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) and 1 or 0
`;

const COUNT_RECEPTION = `
local previous = redis.call('get', KEYS[1])
if previous and not tonumber(previous) then
  local remaining = redis.call('pttl', KEYS[1])
  if remaining > 0 then redis.call('psetex', KEYS[2], remaining, previous) end
  redis.call('del', KEYS[1])
end
local count = redis.call('incr', KEYS[1])
redis.call('expire', KEYS[1], 600, 'NX')
return count
`;

const keysFor = (userId: string) => {
  const id = new ObjectId(userId).toHexString();
  return [`og:gate-open:${id}`, `og:lock:gate-open:${id}`];
};

/** Always acquire before the subscription lock: gate freeze handling takes it internally. */
export const gateUserLifecycleLockKey = (userId: string): string =>
  `og:lock:gate-lifecycle:${new ObjectId(userId).toHexString()}`;

/** Serialize target reads, passage and awaited logs with deletion's complete erasure sweep. */
export function withGateUserLifecycleLock<T>(
  userId: string,
  work: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return withRedisLock(gateUserLifecycleLockKey(userId), 10_000, 1_000, work);
}

export async function acquirePassageLock(
  userId: string,
  token: string,
  ttlMs: number,
): Promise<boolean> {
  return (
    (await redis.eval(ACQUIRE_PASSAGE, {
      keys: keysFor(userId),
      arguments: [token, String(ttlMs)],
    })) === 1
  );
}

export async function releasePassageLock(
  userId: string,
  token: string,
): Promise<void> {
  for (const key of keysFor(userId)) await releaseLock(key, token);
}

export async function isGateOpenRateLimited(actorId: string): Promise<boolean> {
  const count = await redis.eval(COUNT_RECEPTION, {
    keys: keysFor(actorId),
    arguments: [],
  });
  return Number(count) > 30;
}
