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
}

const WEIGHT_HISTORY_LIMIT = 500;

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
