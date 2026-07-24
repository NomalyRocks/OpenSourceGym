import { createServer } from "node:http";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import type { HealthResponse } from "@opengym/shared";
import { env } from "./env.js";
import { connectRedis } from "./redis.js";
import { mongoClient } from "./db.js";
import { auth } from "./auth.js";
import { seedInitialAdmin } from "./seed.js";
import { ensureIndexes } from "./indexes.js";
import { adminRouter } from "./routes/admin.js";
import { meRouter } from "./routes/me.js";
import { devicesRouter } from "./routes/devices.js";
import { attachDeviceGateway } from "./gateway.js";
import { startEntryEventConsumer } from "./eventQueue.js";
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
app.use("/api/admin", adminRouter);
app.use("/api/me", meRouter);

app.get("/health", (_req, res) => {
  const body: HealthResponse = {
    status: "ok",
    service: "opengym-api",
    timestamp: new Date().toISOString(),
  };
  res.json(body);
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
        "Fotoğraf en fazla 10 MB olabilir.",
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
      sendApiError(res, 400, "INVALID_REQUEST", "Geçersiz istek gövdesi.");
      return;
    }
    sendApiError(
      res,
      500,
      "INTERNAL_ERROR",
      "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.",
    );
  },
);

const server = createServer(app);

async function main() {
  assertProductionProfilePhotoConfig();
  await mongoClient.connect();
  await backfillLegacyUserPhones();
  await ensureIndexes();
  await connectRedis();
  await repairLegacySubscriptionOverlaps();
  await seedInitialAdmin();
  attachDeviceGateway(server);
  await startEntryEventConsumer();
  server.listen(env.port, () => {
    console.log(`opengym-api listening on :${env.port}`);
  });
}

main().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});
