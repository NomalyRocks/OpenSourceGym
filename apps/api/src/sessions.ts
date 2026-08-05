import { ObjectId } from "mongodb";
import { sessionCollection } from "./db.js";
import { redis } from "./redis.js";

// Revokes ALL sessions for a user: explicitly deletes BetterAuth sessions cached
// in Redis (secondary storage, key = session token) without waiting for TTL,
// then removes Mongo session records. Application routes already return 401
// through the middleware's Mongo reread.
export async function revokeUserSessions(userId: string): Promise<number> {
  const targetId = new ObjectId(userId);
  const sessionDocs = await sessionCollection()
    .find({ userId: targetId }, { projection: { token: 1 } })
    .toArray();
  const sessionTokens = sessionDocs
    .map((s) => s.token ?? "")
    .filter((token) => token !== "");
  if (sessionTokens.length > 0) {
    await redis.del(sessionTokens).catch(console.error);
  }
  await redis.del(`active-sessions-${userId}`).catch(console.error);

  const result = await sessionCollection().deleteMany({ userId: targetId });
  return result.deletedCount;
}
