/**
 * Takvimin kilo katmanı için saf çözümleme mantığı — `../lib/api` (dolayısıyla
 * react-native) bağımlılığı olmadığı için doğrudan test edilebilir.
 *
 * Seçili günde kayıt yoksa en son o günden önce/o gün girilen değer geçerli
 * sayılır (ileri taşıma) — sonraki bir kayıt varsa o hâlâ görünmez, yalnızca
 * geçmişe doğru taşınır.
 */

import type { MyWeightEntry } from "@opengym/shared";
import { dayKey } from "./dateKeys";

export type WeightEntry = MyWeightEntry;

/**
 * `entries` artan zamana göre sıralı olmalı (sunucu bu sırada döner). Hedef
 * güne kadarki (dahil) en son kaydı bulur; hiçbiri uymazsa `null` döner.
 */
export function resolveWeightForDay(
  entries: WeightEntry[],
  targetDayKey: string,
): number | null {
  let result: number | null = null;
  for (const entry of entries) {
    if (dayKey(new Date(entry.at)) > targetDayKey) break;
    result = entry.weightKg;
  }
  return result;
}
