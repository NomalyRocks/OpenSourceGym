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

// BetterAuth parses its own body; it must be mounted BEFORE express.json()
app.all("/api/auth/{*splat}", toNodeHandler(auth));

app.use(express.json());

app.use("/api", openApiRouter);
app.use("/api/admin/devices", devicesRouter);
// BEFORE adminRouter: adminRouter defines broad paths, so the more specific
// prefix must match first.
app.use("/api/admin/reports", reportsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/me", meRouter);

// The registration screen must show consent text before sign-in: this returns
// only operator-published legal document URLs and contains no personal data.
app.get("/api/legal", async (_req, res) => {
  res.json(await getLegalConfig());
});

// Liveness only reports that the process responds. The orchestrator uses it to
// decide whether to restart the process, so it does not probe dependencies.
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
    // Redis socket errors can have an empty message; if the field is absent,
    // the reason for being "down" disappears completely.
    const message = err instanceof Error ? err.message : String(err);
    return { status: "down", error: message || "unknown error" };
  }
}

// A hung dependency must fail the probe rather than hang it: without a timeout
// the orchestrator waits on the response instead of reading the 503 it needs to
// act on, which is the opposite of what readiness is for.
const READINESS_PROBE_TIMEOUT_MS = 2000;

// Readiness probes actual dependencies. If Mongo, Redis, or the turnstile event
// consumer disconnects, return 503 even while the process is alive—no silent failure.
app.get("/health/ready", async (_req, res) => {
  const [mongo, redisCheck] = await Promise.all([
    probe(() =>
      db.command({ ping: 1 }, { timeoutMS: READINESS_PROBE_TIMEOUT_MS }),
    ),
    probe(() =>
      redis.withCommandOptions({ timeout: READINESS_PROBE_TIMEOUT_MS }).ping(),
    ),
  ]);
  const consumerUp = entryEventConsumer?.isHealthy() ?? false;
  const entry: ReadinessCheck = consumerUp
    ? { status: "up" }
    : { status: "down", error: "turnstile event consumer is not running" };

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

// Terminal error handler: responses must always follow the {code, message}
// contract. Otherwise Express's default handler returns HTML and leaks the stack
// trace to the client outside production.
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

    console.error(`request error: ${req.method} ${req.originalUrl}`, error);

    // Once response streaming starts, the body cannot change; let Express close it
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

/** Force-terminates the process when shutdown exceeds this duration. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

let shuttingDown = false;

// Without SIGTERM handling, `docker stop` and deploy cut in-flight requests short
// and leave the turnstile event consumer unfinished. Order matters: first stop
// accepting requests, then stop the background worker, and close data connections last.
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutdown starting`);

  const forceExit = setTimeout(() => {
    console.error("shutdown timed out; force-terminating process");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // The process must still exit if this timer is the only task awaiting shutdown
  forceExit.unref();

  await step("http sunucusu", 5000, () => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive connections may not close on their own
      server.closeIdleConnections();
    });
  });
  // The scheduler uses Redis and Mongo; closing them before the active run ends
  // can leave a reminder record written but not sent.
  await step("reminder scheduler", 10_000, () =>
    reminderScheduler ? reminderScheduler.stop() : Promise.resolve(),
  );
  await step("turnstile event consumer", 5000, () =>
    entryEventConsumer ? entryEventConsumer.stop() : Promise.resolve(),
  );
  await step("redis", 3000, () => redis.quit().then(() => undefined));
  try {
    redis.destroy();
  } catch {
    // The connection is already closed if quit() succeeded
  }
  await step("mongo", 5000, () => mongoClient.close());

  console.log("shutdown complete");
  clearTimeout(forceExit);
  process.exit(0);
}

/**
 * Runs one shutdown step with a time limit. A stuck step (for example, quit()
 * while Redis is unreachable) must not block later steps; otherwise the process
 * reaches force-exit without closing the Mongo connection cleanly.
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
          () => reject(new Error(`did not complete within ${ms}ms`)),
          ms,
        ).unref();
      }),
    ]);
  } catch (err) {
    console.error(`shutdown step failed (${name}):`, err);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});
