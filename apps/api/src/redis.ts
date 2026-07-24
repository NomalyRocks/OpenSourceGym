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

// Kilidi yalnızca hâlâ çağıranın token'ı duruyorsa siler. Lease süresi dolup
// kilit başka bir isteğe geçtiyse o isteğin kilidi yanlışlıkla açılmaz.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Sahiplik token'lı kilidi kurar; kilit başkasındaysa false döner. */
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

/** acquireLock ile alınmış kilidi bırakır (sahibi değilse hiçbir şey yapmaz). */
export async function releaseLock(key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [token] });
}
