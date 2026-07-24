import type { GateRejectCode } from "@opengym/shared";
import { db } from "./db.js";
import { redis } from "./redis.js";

const QUEUE_KEY = "og:entry-events";

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kuyruktaki geçiş olaylarını arka planda tüketip entry_events koleksiyonuna yazar
export async function startEntryEventConsumer(): Promise<void> {
  const consumer = redis.duplicate();
  // duplicate() dinleyicileri kopyalamaz. 'error' dinleyicisi olmayan bir
  // EventEmitter'da soket hatası Node tarafından fırlatılır ve TÜM API süreci
  // düşer — Redis kısa süreli kesintiye girdiğinde bu yaşanıyordu.
  consumer.on("error", (err) => {
    console.error("entry event tüketici redis hatası:", err);
  });
  await consumer.connect();

  void (async () => {
    for (;;) {
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

        try {
          await db.collection("entry_events").insertOne({
            ...parsed,
            at: new Date(parsed.at),
          });
        } catch (err) {
          console.error("entry event yazılamadı, kuyruğa geri konuyor:", err);
          await redis.lPush(QUEUE_KEY, raw).catch(console.error);
          await wait(RETRY_DELAY_MS);
        }
      } catch (err) {
        console.error(
          "entry event tüketicisi hata aldı, yeniden denenecek:",
          err,
        );
        await wait(RETRY_DELAY_MS);
      }
    }
  })();
}
