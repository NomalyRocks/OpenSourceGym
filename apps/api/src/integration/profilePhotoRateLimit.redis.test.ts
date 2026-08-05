import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const redisUri = process.env.TEST_REDIS_URL;

test(
  "profile photo upload limit returns 429 when the window is exceeded",
  { skip: redisUri ? false : "TEST_REDIS_URL is not defined" },
  async () => {
    // The shared Redis client in profilePhoto is created at import time, so set
    // the test address before the dynamic import.
    process.env.REDIS_URL = redisUri!;
    const [
      { enforceProfilePhotoRateLimit, ProfilePhotoRateLimitError },
      { redis },
    ] = await Promise.all([
      import("../profilePhoto.js"),
      import("../redis.js"),
    ]);

    const userId = `test-${randomUUID()}`;
    const key = `og:rl:profile-photo:${userId}`;
    try {
      await redis.connect();
      for (let i = 0; i < 10; i++) {
        await enforceProfilePhotoRateLimit(userId);
      }
      await assert.rejects(
        () => enforceProfilePhotoRateLimit(userId),
        ProfilePhotoRateLimitError,
      );
      const ttl = await redis.ttl(key);
      assert.ok(
        ttl > 0 && ttl <= 3600,
        `TTL must be within the window: ${ttl}`,
      );
    } finally {
      await redis.del(key).catch(() => {});
      await redis.quit().catch(() => {});
    }
  },
);
