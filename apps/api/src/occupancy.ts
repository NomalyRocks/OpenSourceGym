import { findGymSettings } from "./db.js";
import { redis } from "./redis.js";

// İçerideki üyeler: field = userId, value = giriş anı (epoch ms, string)
const INSIDE_KEY = "og:inside";

// Üyeyi "içeride" olarak işaretler (giriş turnikesi geçişi izin verildiğinde)
export async function markInside(userId: string): Promise<void> {
  await redis.hSet(INSIDE_KEY, userId, String(Date.now()));
}

// Üyeyi "dışarıda" olarak işaretler (çıkış turnikesi geçişi veya hesap silme temizliği)
export async function markOutside(userId: string): Promise<void> {
  await redis.hDel(INSIDE_KEY, userId);
}

// Anlık salon doluluğu: autoExitHours'tan daha eski giriş kayıtları (çıkış
// turnikesi geçilmemiş/arızalı senaryosu) süresi dolmuş sayılıp düşülür
export async function getOccupancy(): Promise<number> {
  const entries = await redis.hGetAll(INSIDE_KEY);
  const settings = await findGymSettings();
  const autoExitHours = settings?.autoExitHours ?? 4;
  const cutoff = Date.now() - autoExitHours * 60 * 60 * 1000;

  const stale: string[] = [];
  let count = 0;
  for (const [userId, enteredAtRaw] of Object.entries(entries)) {
    const enteredAt = Number(enteredAtRaw);
    if (!Number.isFinite(enteredAt) || enteredAt < cutoff) {
      stale.push(userId);
      continue;
    }
    count += 1;
  }
  if (stale.length > 0) {
    await redis.hDel(INSIDE_KEY, stale);
  }
  return count;
}
