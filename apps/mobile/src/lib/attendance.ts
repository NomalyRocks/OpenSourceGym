/**
 * Takvimin geliş katmanı.
 *
 * Üye tarafında geçiş geçmişini döndüren bir uç nokta henüz yok: `entry_events`
 * koleksiyonu yalnızca yönetim rotalarından (`/api/admin/entries`) okunuyor.
 * Ekranın tamamı bu sözleşmeye göre çizildi; uç nokta eklendiğinde değişmesi
 * gereken tek yer `fetchAttendance`.
 *
 * Bağlarken:
 *   1. API'ye `GET /api/me/entries?from=…&to=…` ekle (yalnızca oturumdaki
 *      kullanıcının `entry_events` kayıtları; `requireRole` + `logAudit`).
 *   2. Yanıt tipini `@opengym/shared` içine koy.
 *   3. Aşağıdaki gövdeyi `api<…>("/api/me/entries?…")` çağrısıyla değiştir ve
 *      günlere indirgeyip döndür.
 */

export interface AttendanceDay {
  /** Yerel takvim günü, `YYYY-MM-DD`. */
  date: string;
  /** O gün oluşan giriş sayısı. */
  entries: number;
}

export interface AttendanceRange {
  /** Ayın ilk günü (yerel), `YYYY-MM-DD`. */
  from: string;
  /** Ayın son günü (yerel), `YYYY-MM-DD`. */
  to: string;
}

export interface AttendanceResult {
  days: AttendanceDay[];
  /**
   * Kaynak henüz bağlı değil. Ekran bunu "veri yok"tan ayırt eder: boş bir ay
   * ile bağlanmamış bir katman aynı şey değildir.
   */
  connected: boolean;
}

export async function fetchAttendance(
  range: AttendanceRange,
): Promise<AttendanceResult> {
  // Uç nokta bağlanınca: `api<...>(\`/api/me/entries?from=${range.from}&to=${range.to}\`)`
  void range;
  return { days: [], connected: false };
}
