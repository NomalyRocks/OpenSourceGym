import type { MyEntryDay } from "@opengym/shared";

/**
 * Takvimin geliş katmanı için gün etiketi (`YYYY-MM-DD`) yardımcıları.
 *
 * Gün sınırı salonun yerel günüdür (`REPORTS_TIME_ZONE`): UTC'ye göre
 * gruplanınca gece yarısına yakın geçişler komşu güne kayardı.
 */

/** Sorgu parametrelerinde kabul edilen gün etiketi biçimi. */
export const DAY_LABEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Tek istekte istenebilecek azami gün sayısı — takvim bir ay çeker. */
export const MAX_ENTRY_RANGE_DAYS = 92;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Yerel gün sınırının UTC'den sapabileceği azami süre (UTC-12 … UTC+14).
 * Sorgu penceresi bu kadar geniş tutulur; pencereye giren fazla günler
 * gruplama sonrası etikete göre elenir.
 */
const MAX_TZ_OFFSET_MS = 14 * 60 * 60 * 1000;

function labelToUtc(label: string): number {
  return Date.parse(`${label}T00:00:00Z`);
}

/** İki gün etiketi arasındaki gün farkı; `to` daha eskiyse negatif. */
export function dayLabelSpan(from: string, to: string): number {
  return (labelToUtc(to) - labelToUtc(from)) / DAY_MS;
}

/**
 * Aralığın `at` üzerinden taranacağı UTC penceresi. Saat dilimi sapması
 * kadar geniştir: yerel `from` gününün ilk geçişi UTC'de bir önceki güne,
 * yerel `to` gününün son geçişi bir sonrakine düşebilir.
 */
export function entryQueryWindow(
  from: string,
  to: string,
): { start: Date; end: Date } {
  return {
    start: new Date(labelToUtc(from) - MAX_TZ_OFFSET_MS),
    end: new Date(labelToUtc(to) + DAY_MS + MAX_TZ_OFFSET_MS),
  };
}

/**
 * Gruplama sonucunu yanıt biçimine indirger: pencereden taşan günler elenir,
 * kalanlar tarihe göre sıralanır. Boş günler yanıtta yer almaz — istemci
 * "geliş yok"u eksik anahtardan okur.
 */
export function toEntryDays(
  rows: { _id: string; entries: number }[],
  from: string,
  to: string,
): MyEntryDay[] {
  return rows
    .filter((row) => row._id >= from && row._id <= to && row.entries > 0)
    .map((row) => ({ date: row._id, entries: row.entries }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
