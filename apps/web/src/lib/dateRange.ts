/**
 * `<input type="date">` değerleri ile API'nin beklediği ISO zaman damgaları
 * arasındaki dönüşüm. Tek yerde toplanır çünkü iki kural her çağrı yerinde
 * aynı uygulanmalıdır ve elle yazıldığında ikisi de kolayca kaçırılır:
 *
 * 1. Gün YEREL olarak yorumlanır. `new Date("2026-07-29")` UTC gece yarısını
 *    verir; salon UTC+3'teyse o an 29 Temmuz'un değil 28 Temmuz'un içindedir.
 * 2. Bitiş günün SONUNA sabitlenir. 00:00 gönderilirse `$lte` filtresi seçilen
 *    son günü tamamen dışarıda bırakır ve tek günlük aralık boş döner.
 */

/** `<input type="date">` biçimi (YYYY-MM-DD), tarayıcının yerel gününe göre. */
export function dateInputValue(at: Date): string {
  const offset = at.getTimezoneOffset() * 60 * 1000;
  return new Date(at.getTime() - offset).toISOString().slice(0, 10);
}

function isoAt(day: string, time: string): string | null {
  if (!day) return null;
  const at = new Date(`${day}T${time}`);
  // Kullanıcı tarih girdisini temizleyebilir; Invalid Date üzerinde
  // toISOString() RangeError fırlatır ve sayfayı komple düşürürdü.
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/** Yerel günün başlangıcı (00:00:00.000). Boş/geçersiz girdide null. */
export function dayStartIso(day: string): string | null {
  return isoAt(day, "00:00:00.000");
}

/** Yerel günün sonu (23:59:59.999). Boş/geçersiz girdide null. */
export function dayEndIso(day: string): string | null {
  return isoAt(day, "23:59:59.999");
}

/** İki ucu birlikte isteyen sorgular için; biri geçersizse tamamı null. */
export function rangeBounds(
  from: string,
  to: string,
): { from: string; to: string } | null {
  const start = dayStartIso(from);
  const end = dayEndIso(to);
  return start && end ? { from: start, to: end } : null;
}
