import { ObjectId } from "mongodb";
import { sessionCollection } from "./db.js";
import { redis } from "./redis.js";

// Bir kullanıcının TÜM oturumlarını iptal eder: Redis'te önbelleğe alınmış
// BetterAuth oturumları (secondary storage, anahtar = oturum token'ı) TTL
// beklemeden açıkça silinir, ardından Mongo'daki oturum kayıtları temizlenir.
// Uygulama rotaları zaten middleware'in Mongo re-read'iyle 401'e düşer.
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
