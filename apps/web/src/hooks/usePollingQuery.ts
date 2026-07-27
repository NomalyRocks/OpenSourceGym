import { useEffect, useRef } from "react";

/**
 * Belirli aralıkla veri tazeleyen ekranlar için ortak yükleme döngüsü.
 *
 * Elle kurulan `setInterval` desenlerinin üç sorunu vardı ve bu hook üçünü de
 * kapatır:
 * - istek bitmeden bir sonraki tik başlıyordu (yavaş ağda istekler üst üste binerdi),
 * - unmount sonrası uçuşan istek iptal edilmiyordu,
 * - geç dönen eski yanıt yeni state'i ezebiliyordu.
 *
 * `load` kendi hatalarını kendisi ele almalıdır (kullanıcıya mesaj göstermek
 * çağıranın işi). İptal edilen istekler `AbortError` fırlatır; çağıran bunu
 * `isAbortError` ile ayıklamalıdır.
 */
export function usePollingQuery(
  load: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  /**
   * Değişince uçuşan istek iptal edilir, veri hemen yeniden yüklenir ve
   * zamanlayıcı sıfırdan kurulur. Filtre değişiminde bir sonraki tiki
   * beklememek için kullanılır.
   */
  resetKey?: string,
): void {
  // `load` her render'da yeniden oluşur; ref olmadan effect her render'da
  // yeniden kurulur ve zamanlayıcı sıfırlanırdı.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    let stopped = false;

    async function tick(): Promise<void> {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        await loadRef.current(controller.signal);
      } catch (err) {
        // Buraya yalnızca çağıranın yakalamadığı hatalar düşer; sessizce
        // yutmak yerine logla, yoksa unhandled rejection olur.
        console.error("polling yüklemesi başarısız:", err);
      } finally {
        inFlight = false;
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);

    return () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [intervalMs, resetKey]);
}
