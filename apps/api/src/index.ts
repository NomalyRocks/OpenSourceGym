import { createServer } from "node:http";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import type {
  HealthResponse,
  ReadinessCheck,
  ReadinessResponse,
} from "@opengym/shared";
import { env } from "./env.js";
import { connectRedis, redis } from "./redis.js";
import { db, mongoClient } from "./db.js";
import { auth } from "./auth.js";
import { seedInitialAdmin } from "./seed.js";
import { ensureIndexes } from "./indexes.js";
import { adminRouter } from "./routes/admin.js";
import { meRouter } from "./routes/me.js";
import { devicesRouter } from "./routes/devices.js";
import { reportsRouter } from "./routes/reports.js";
import {
  startRenewalReminderScheduler,
  type RenewalReminderScheduler,
} from "./renewalReminders.js";
import { attachDeviceGateway } from "./gateway.js";
import {
  startEntryEventConsumer,
  type EntryEventConsumer,
} from "./eventQueue.js";
import { renameLegacyConsentFields } from "./consentFieldRename.js";
import { getLegalConfig } from "./legal.js";
import { backfillLegacyUserPhones } from "./phoneBackfill.js";
import { repairLegacySubscriptionOverlaps } from "./subscriptions.js";
import { assertProductionProfilePhotoConfig } from "./profilePhoto.js";
import { sendApiError } from "./apiError.js";
import { openApiRouter } from "./openapi/router.js";

const app = express();

// BetterAuth kendi body parsing'ini yapar; express.json()'dan ÖNCE mount edilmeli
app.all("/api/auth/{*splat}", toNodeHandler(auth));

app.use(express.json());

app.use("/api", openApiRouter);
app.use("/api/admin/devices", devicesRouter);
// adminRouter'dan ÖNCE: adminRouter geniş yollar tanımlıyor, daha özel olan
// önek önce eşleşmeli.
app.use("/api/admin/reports", reportsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/me", meRouter);

// Kayıt ekranı oturum açmadan onay metinlerini göstermek zorunda: yalnızca
// operatörün yayımladığı hukuki belge adresleri döner, kişisel veri içermez.
app.get("/api/legal", async (_req, res) => {
  res.json(await getLegalConfig());
});

// Liveness: yalnızca sürecin yanıt verdiğini söyler. Orchestrator'ın süreci
// yeniden başlatmasına karar verdiği uçtur, bu yüzden bağımlılık yoklamaz.
app.get("/health", (_req, res) => {
  const body: HealthResponse = {
    status: "ok",
    service: "opengym-api",
    timestamp: new Date().toISOString(),
  };
  res.json(body);
});

async function probe(check: () => Promise<unknown>): Promise<ReadinessCheck> {
  try {
    await check();
    return { status: "up" };
  } catch (err) {
    // Redis soket hataları boş message ile gelebiliyor; alan hiç yoksa
    // "down" sebebi tamamen kaybolur.
    const message = err instanceof Error ? err.message : String(err);
    return { status: "down", error: message || "bilinmeyen hata" };
  }
}

// Readiness: bağımlılıklar gerçekten yoklanır. Mongo, Redis veya geçiş olayı
// tüketicisi koptuysa süreç ayakta olsa bile 503 döner — sessiz arıza olmaz.
app.get("/health/ready", async (_req, res) => {
  const [mongo, redisCheck] = await Promise.all([
    probe(() => db.command({ ping: 1 })),
    probe(() => redis.ping()),
  ]);
  const consumerUp = entryEventConsumer?.isHealthy() ?? false;
  const entry: ReadinessCheck = consumerUp
    ? { status: "up" }
    : { status: "down", error: "geçiş olayı tüketicisi çalışmıyor" };

  const checks = { mongo, redis: redisCheck, entryEventConsumer: entry };
  const healthy = Object.values(checks).every((c) => c.status === "up");
  const body: ReadinessResponse = {
    status: healthy ? "ok" : "degraded",
    service: "opengym-api",
    timestamp: new Date().toISOString(),
    checks,
  };
  res.status(healthy ? 200 : 503).json(body);
});

function bodyParserErrorType(error: unknown): string | null {
  return typeof error === "object" && error !== null && "type" in error
    ? String(error.type)
    : null;
}

// Terminal hata handler'ı: yanıtlar her koşulda {code, message} sözleşmesine
// uymalı. Aksi halde Express'in varsayılan handler'ı HTML döndürür ve
// production dışında yığın izini (stack trace) istemciye sızdırır.
app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const parserErrorType = bodyParserErrorType(error);
    if (
      parserErrorType === "entity.too.large" &&
      req.originalUrl.startsWith("/api/me/profile-photo")
    ) {
      sendApiError(
        res,
        413,
        "PAYLOAD_TOO_LARGE",
        "Photo must be at most 10 MB.",
      );
      return;
    }

    console.error(`istek hatası: ${req.method} ${req.originalUrl}`, error);

    // Yanıt akışı başladıysa gövde değiştirilemez; bağlantıyı Express kapatsın
    if (res.headersSent) {
      next(error);
      return;
    }
    if (parserErrorType === "entity.parse.failed") {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid request body.");
      return;
    }
    sendApiError(
      res,
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred. Please try again.",
    );
  },
);

const server = createServer(app);

let entryEventConsumer: EntryEventConsumer | null = null;
let reminderScheduler: RenewalReminderScheduler | null = null;

async function main() {
  assertProductionProfilePhotoConfig();
  await mongoClient.connect();
  await backfillLegacyUserPhones();
  await renameLegacyConsentFields();
  await ensureIndexes();
  await connectRedis();
  await repairLegacySubscriptionOverlaps();
  await seedInitialAdmin();
  attachDeviceGateway(server);
  entryEventConsumer = await startEntryEventConsumer();
  reminderScheduler = startRenewalReminderScheduler();
  server.listen(env.port, () => {
    console.log(`opengym-api listening on :${env.port}`);
  });
}

/** Kapanış bu süreden uzun sürerse süreç zorla sonlandırılır. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

let shuttingDown = false;

// SIGTERM olmadan `docker stop`/deploy uçuşan istekleri ortasından keser ve
// geçiş olayı tüketicisi yarım kalır. Sıra önemli: önce yeni istek kabulünü
// durdur, sonra arka plan işçisini, en son veri bağlantılarını kapat.
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} alındı, kapanış başlıyor`);

  const forceExit = setTimeout(() => {
    console.error("kapanış zaman aşımına uğradı, süreç zorla sonlandırılıyor");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Kapanışı bekleyen tek iş bu zamanlayıcıysa süreç yine de çıkabilmeli
  forceExit.unref();

  await step("http sunucusu", 5000, () => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive bağlantıları kendiliğinden kapanmayabilir
      server.closeIdleConnections();
    });
  });
  // Zamanlayıcı Redis ve Mongo'yu kullanıyor; süren tur bitmeden onlar
  // kapanırsa yazılmış ama gönderilmemiş bir hatırlatma kaydı kalabilir.
  await step("hatırlatma zamanlayıcısı", 10_000, () =>
    reminderScheduler ? reminderScheduler.stop() : Promise.resolve(),
  );
  await step("geçiş olayı tüketicisi", 5000, () =>
    entryEventConsumer ? entryEventConsumer.stop() : Promise.resolve(),
  );
  await step("redis", 3000, () => redis.quit().then(() => undefined));
  try {
    redis.destroy();
  } catch {
    // quit() başarılı olduysa bağlantı zaten kapalıdır
  }
  await step("mongo", 5000, () => mongoClient.close());

  console.log("kapanış tamamlandı");
  clearTimeout(forceExit);
  process.exit(0);
}

/**
 * Tek bir kapanış adımını süre sınırıyla çalıştırır. Bir adımın takılması
 * (ör. Redis erişilemezken quit()) sonraki adımları engellememeli; aksi halde
 * süreç force-exit'e düşer ve Mongo bağlantısı düzgün kapanmaz.
 */
async function step(
  name: string,
  ms: number,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`${ms}ms içinde tamamlanmadı`)),
          ms,
        ).unref();
      }),
    ]);
  } catch (err) {
    console.error(`kapanış adımı başarısız (${name}):`, err);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});
