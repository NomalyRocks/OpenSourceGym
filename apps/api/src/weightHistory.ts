/**
 * Üyenin kilo geçmişi: profildeki `weightKg` her değiştiğinde tarihli bir
 * kayıt eklenir. Takvim, seçili gün için kaydı yoksa en son değişiklikten
 * itibaren geçerli değeri gösterebilsin diye geçmişin tamamı okunur.
 */

import { weightHistoryCollection } from "./db.js";

/** Ardışık aynı değerle geçmişi şişirmemek için: yalnızca fark varsa kaydet. */
export function shouldRecordWeightChange(
  lastWeightKg: number | null,
  nextWeightKg: number,
): boolean {
  return lastWeightKg == null || lastWeightKg !== nextWeightKg;
}

/** BetterAuth `user.update.after` kancasından çağrılır. */
export async function recordWeightHistoryIfChanged(
  userId: string,
  weightKg: number,
): Promise<void> {
  const last = await weightHistoryCollection()
    .find({ userId })
    .sort({ at: -1 })
    .limit(1)
    .next();
  if (!shouldRecordWeightChange(last?.weightKg ?? null, weightKg)) return;
  await weightHistoryCollection().insertOne({
    userId,
    weightKg,
    at: new Date(),
  });
  await pruneWeightHistory(userId);
}

const WEIGHT_HISTORY_LIMIT = 500;

/**
 * Geçmiş üye başına sınırlıdır: aksi halde kiloyu ileri geri değiştiren bir
 * üye sağlık verisi deposunu sınırsız büyütebilir. Okuma zaten aynı sınırı
 * uyguladığı için taşan kayıtlar hiçbir zaman gösterilmiyordu.
 */
async function pruneWeightHistory(userId: string): Promise<void> {
  const oldest = await weightHistoryCollection()
    .find({ userId })
    .sort({ at: -1 })
    .skip(WEIGHT_HISTORY_LIMIT)
    .limit(1)
    .next();
  if (!oldest) return;
  await weightHistoryCollection().deleteMany({
    userId,
    at: { $lte: oldest.at },
  });
}

/** Üyenin kilo geçmişi, artan zamana göre sıralı. */
export async function listWeightHistory(
  userId: string,
): Promise<{ weightKg: number; at: Date }[]> {
  const rows = await weightHistoryCollection()
    .find({ userId })
    .sort({ at: -1 })
    .limit(WEIGHT_HISTORY_LIMIT)
    .toArray();
  return rows.reverse().map((row) => ({ weightKg: row.weightKg, at: row.at }));
}
