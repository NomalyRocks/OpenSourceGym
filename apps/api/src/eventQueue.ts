import type { GateRejectCode } from "@opengym/shared";
import { db } from "./db.js";
import { redis } from "./redis.js";

const QUEUE_KEY = "og:entry-events";
const DEAD_LETTER_KEY = "og:entry-events:dead";

export interface EntryEventInput {
  deviceId: string;
  deviceName: string;
  userId: string | null;
  memberName: string | null;
  allowed: boolean;
  reason: GateRejectCode | null;
  at: Date;
}

// Turnike geçiş olayını Redis kuyruğuna iter (fire-and-forget) — API yanıtını bekletmez
export function enqueueEntryEvent(ev: EntryEventInput): void {
  const serialized = JSON.stringify({ ...ev, at: ev.at.toISOString() });
  redis.lPush(QUEUE_KEY, serialized).catch(console.error);
}

const RETRY_DELAY_MS = 1000;
/** Bir olay bu kadar denemeden sonra dead-letter listesine taşınır. */
const MAX_WRITE_ATTEMPTS = 5;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EntryEventConsumer {
  /** Döngüyü durdurup tüketiciye ait Redis bağlantısını kapatır. */
  stop(): Promise<void>;
  /** Readiness için: döngü ayakta ve Redis bağlantısı açık mı. */
  isHealthy(): boolean;
}

// Kuyruktaki geçiş olaylarını arka planda tüketip entry_events koleksiyonuna yazar
export async function startEntryEventConsumer(): Promise<EntryEventConsumer> {
  // Bu iki bayrak 'error' dinleyicisinden ÖNCE tanımlanmalı: connect() sırasında
  // Redis hata verirse dinleyici hemen tetiklenir ve bayraklar TDZ'de olsaydı
  // handler ReferenceError fırlatıp süreci düşürürdü — yani dinleyicinin
  // engellemesi gereken şeyin ta kendisini yapardı.
  let stopping = false;
  let running = true;

  const consumer = redis.duplicate();
  // duplicate() dinleyicileri kopyalamaz. 'error' dinleyicisi olmayan bir
  // EventEmitter'da soket hatası Node tarafından fırlatılır ve TÜM API süreci
  // düşer — Redis kısa süreli kesintiye girdiğinde bu yaşanıyordu.
  consumer.on("error", (err) => {
    if (stopping) return; // kapanışta beklenen soket hatası, gürültü yapma
    console.error("entry event tüketici redis hatası:", err);
  });
  await consumer.connect();

  const loop = (async () => {
    while (!stopping) {
      // Döngünün TAMAMI korunur: brPop bağlantı düştüğünde reject eder ve
      // yakalanmayan bir promise Node'da tüm API sürecini düşürürdü.
      try {
        const result = await consumer.brPop(QUEUE_KEY, 5);
        if (!result) {
          continue;
        }
        const raw = result.element;

        let parsed: EntryEventInput & { at: string };
        try {
          parsed = JSON.parse(raw) as EntryEventInput & { at: string };
        } catch (err) {
          // raw loglanmaz: içerik üye kimlik bilgisi (PII) taşıyabilir
          console.error("çözümlenemeyen entry event, atlanıyor:", err);
          continue;
        }

        await writeEvent(raw, parsed);
      } catch (err) {
        if (stopping) break;
        console.error(
          "entry event tüketicisi hata aldı, yeniden denenecek:",
          err,
        );
        await wait(RETRY_DELAY_MS);
      }
    }
    running = false;
  })();

  // Kalıcı olarak yazılamayan olay kuyruğun başına sonsuza dek geri konmamalı:
  // tek bir bozuk kayıt tüm geçiş olay akışını durdururdu.
  async function writeEvent(
    raw: string,
    parsed: EntryEventInput & { at: string },
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      try {
        await db
          .collection("entry_events")
          .insertOne({ ...parsed, at: new Date(parsed.at) });
        return;
      } catch (err) {
        console.error(
          `entry event yazılamadı (deneme ${attempt}/${MAX_WRITE_ATTEMPTS}):`,
          err,
        );
        if (stopping) {
          // Kapanıyoruz: olayı kaybetmemek için kuyruğa geri koy
          await redis.lPush(QUEUE_KEY, raw).catch(console.error);
          return;
        }
        await wait(RETRY_DELAY_MS);
      }
    }
    console.error("entry event dead-letter listesine taşındı");
    await redis.lPush(DEAD_LETTER_KEY, raw).catch(console.error);
  }

  return {
    async stop() {
      stopping = true;
      // quit() sunucuya komut göndermeye çalışır; Redis erişilemezken süresiz
      // asılır ve kapanışı kilitler. Kısa süre bekleyip destroy() ile soketi
      // koparıyoruz — kapanış en çok Redis bozukken güvenilir olmalı.
      await Promise.race([consumer.quit().catch(() => {}), wait(2000)]);
      try {
        consumer.destroy();
      } catch {
        // zaten kapalıysa sorun değil
      }
      await Promise.race([loop, wait(2000)]);
    },
    isHealthy() {
      return running && !stopping;
    },
  };
}
