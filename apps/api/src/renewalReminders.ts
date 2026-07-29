import { randomUUID } from "node:crypto";
import type { ReminderConfig } from "@opengym/shared";
import { ObjectId } from "mongodb";
import type { Db } from "mongodb";
import { db, findGymSettings } from "./db.js";
import { acquireLock, releaseLock } from "./redis.js";
import {
  remainingDays,
  REMINDER_COOLDOWN_MS,
  sendRenewalReminder,
} from "./renewals.js";

export const REMINDER_DEFAULTS: ReminderConfig = {
  // Kapalı başlar: sürüm yükselten bir kurulum, ayarı açıkça açmadan üyelerine
  // toplu e-posta göndermemeli.
  enabled: false,
  daysBefore: [7, 1],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_LOCK_KEY = "og:lock:renewal-reminder-sweep";
const SWEEP_LOCK_LEASE_MS = 10 * 60 * 1000;

/** settings._id: "gym" belgesindeki hatırlatma ayarlarını varsayılanlarla birleştirir. */
export async function findReminderConfig(
  database: Db = db,
): Promise<ReminderConfig> {
  const doc = await findGymSettings(database);
  return { ...REMINDER_DEFAULTS, ...(doc?.reminders ?? {}) };
}

export interface SweepReport {
  /** Hatırlatmalar kapalıysa hiçbir şey yapılmaz. */
  skipped: boolean;
  scanned: number;
  sent: number;
  /** Bu eşik için zaten gönderilmiş olduğu için atlananlar. */
  alreadySent: number;
  /** Son 24 saatte (elle veya otomatik) hatırlatıldığı için atlananlar. */
  cooledDown: number;
  failed: number;
}

interface DueRow {
  _id: ObjectId;
  endsAt: Date;
  subscriptionId: ObjectId;
  user?: { email?: string; firstName?: string } | null;
  lastReminderAt?: Date | null;
}

/**
 * Yaklaşan yenilemeleri tarar ve eşiği geçen her abonelik için bir kez
 * hatırlatma gönderir.
 *
 * Tekillik unique indeksle sağlanır (bkz. `recordAndSendReminder`), bu yüzden
 * süpürme yeniden çalıştırılabilir: yarıda kesilse de gönderilmiş hatırlatma
 * ikinci kez gitmez.
 */
export async function runRenewalReminderSweep(
  database: Db = db,
  now = new Date(),
): Promise<SweepReport> {
  const report: SweepReport = {
    skipped: false,
    scanned: 0,
    sent: 0,
    alreadySent: 0,
    cooledDown: 0,
    failed: 0,
  };

  const settingsDoc = await findGymSettings(database);
  const config: ReminderConfig = {
    ...REMINDER_DEFAULTS,
    ...(settingsDoc?.reminders ?? {}),
  };
  if (!config.enabled || config.daysBefore.length === 0) {
    report.skipped = true;
    return report;
  }

  const gymName = settingsDoc?.gymName?.trim() || "OpenGym";
  // Küçükten büyüğe: bir abonelik birden çok eşiği aşmışsa en dar olanı
  // (yani "1 gün kaldı") kullanılır, çünkü üyeye gösterilecek doğru aciliyet odur.
  const thresholds = [...new Set(config.daysBefore)].sort((a, b) => a - b);
  const horizonDays = thresholds[thresholds.length - 1] ?? 0;
  const horizon = new Date(now.getTime() + (horizonDays + 1) * DAY_MS);

  // Sonuçlar toArray ile toplanmaz: üye sayısı büyüdükçe tek seferde belleğe
  // alınacak liste de büyür, imleç üzerinden akıtmak sabit bellek kullanır.
  const cursor = database.collection("subscriptions").aggregate<DueRow>([
    { $sort: { userId: 1, endsAt: -1, _id: -1 } },
    {
      $group: {
        _id: "$userId",
        endsAt: { $first: "$endsAt" },
        subscriptionId: { $first: "$_id" },
      },
    },
    { $match: { endsAt: { $gte: now, $lte: horizon } } },
    { $sort: { endsAt: 1, _id: 1 } },
    {
      $lookup: {
        from: "user",
        localField: "_id",
        foreignField: "_id",
        as: "userDocs",
      },
    },
    {
      $lookup: {
        from: "renewal_reminders",
        let: { subscriptionId: "$subscriptionId" },
        pipeline: [
          {
            $match: { $expr: { $eq: ["$subscriptionId", "$$subscriptionId"] } },
          },
          { $sort: { sentAt: -1 } },
          { $limit: 1 },
        ],
        as: "reminderDocs",
      },
    },
    {
      $project: {
        endsAt: 1,
        subscriptionId: 1,
        user: { $first: "$userDocs" },
        lastReminderAt: { $first: "$reminderDocs.sentAt" },
      },
    },
  ]);

  for await (const row of cursor) {
    report.scanned++;
    const email = row.user?.email;
    if (!email) continue;

    // Hızlı eleme: bekleme süresini fiilen uygulayan yer sendRenewalReminder
    // (kilit altında), burası yalnızca boşuna kilit almayı önler — satırın
    // son hatırlatma zamanı zaten toplulaştırmadan bedavaya geldi.
    if (
      row.lastReminderAt &&
      now.getTime() - row.lastReminderAt.getTime() < REMINDER_COOLDOWN_MS
    ) {
      report.cooledDown++;
      continue;
    }

    const days = remainingDays(row.endsAt, now);
    const threshold = thresholds.find((value) => days <= value);
    if (threshold === undefined) continue;

    try {
      const outcome = await sendRenewalReminder(
        {
          userId: row._id,
          subscriptionId: row.subscriptionId,
          endsAt: row.endsAt,
          email,
          firstName: row.user?.firstName ?? "",
          gymName,
          thresholdDays: threshold,
          automatic: true,
          sentBy: null,
          now,
        },
        database,
      );
      if (outcome.status === "sent") report.sent++;
      else if (outcome.status === "already-sent") report.alreadySent++;
      else report.cooledDown++;
    } catch (err) {
      // Tek bir başarısız gönderim süpürmeyi durdurmamalı; kayıt geri alındığı
      // için bir sonraki turda yeniden denenir.
      report.failed++;
      console.error("yenileme hatırlatması gönderilemedi:", err);
    }
  }

  if (report.sent > 0 || report.failed > 0) {
    console.info(
      `[reminders] ${report.sent} gönderildi, ${report.failed} başarısız, ${report.scanned} tarandı`,
    );
  }
  return report;
}

export interface RenewalReminderScheduler {
  /** Zamanlayıcıyı durdurur ve süren turun bitmesini bekler. */
  stop(): Promise<void>;
  /** Testler ve elle tetikleme için: kilidi alıp tek tur çalıştırır. */
  runOnce(now?: Date): Promise<SweepReport | null>;
}

/**
 * Saatlik süpürmeyi başlatır. Zamanlayıcı `unref` edilir: bekleyen bir tick
 * SIGTERM sonrası sürecin kapanmasını geciktirmemeli.
 */
export function startRenewalReminderScheduler(
  database: Db = db,
): RenewalReminderScheduler {
  let stopped = false;
  // Süren tur kapanışta beklenir. Bir hatırlatma kaydı yazılıp SMTP yanıtı
  // beklenirken süreç kapanırsa kayıt "gönderildi" olarak kalır ve unique
  // indeks yüzünden o eşik bir daha denenmez — üye sessizce hatırlatmasız
  // kalırdı. (kill -9 bu boşluğu yine açık bırakır; graceful kapanış kapatır.)
  let inFlight: Promise<unknown> = Promise.resolve();

  async function runOnce(now = new Date()): Promise<SweepReport | null> {
    // Kilit, örnek çoğaltıldığında veya bir tur uzayıp bir sonrakiyle
    // çakıştığında aynı üyeye iki posta gitmesini önler. Unique indeks son
    // savunma hattıdır; kilit gereksiz işi baştan engeller.
    const token = randomUUID();
    if (!(await acquireLock(SWEEP_LOCK_KEY, token, SWEEP_LOCK_LEASE_MS))) {
      return null;
    }
    try {
      return await runRenewalReminderSweep(database, now);
    } finally {
      await releaseLock(SWEEP_LOCK_KEY, token).catch((err: unknown) => {
        console.error("hatırlatma süpürme kilidi bırakılamadı:", err);
      });
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = runOnce().catch((err: unknown) => {
      console.error("yenileme hatırlatma süpürmesi başarısız:", err);
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
    runOnce,
  };
}
