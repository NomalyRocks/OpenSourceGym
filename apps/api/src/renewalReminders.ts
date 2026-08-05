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
  // Starts disabled: an upgraded installation must not send bulk email to
  // members until the operator explicitly enables it.
  enabled: false,
  daysBefore: [7, 1],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_LOCK_KEY = "og:lock:renewal-reminder-sweep";
const SWEEP_LOCK_LEASE_MS = 10 * 60 * 1000;

/** Merges reminder settings in settings._id: "gym" with defaults. */
export async function findReminderConfig(
  database: Db = db,
): Promise<ReminderConfig> {
  const doc = await findGymSettings(database);
  return { ...REMINDER_DEFAULTS, ...(doc?.reminders ?? {}) };
}

export interface SweepReport {
  /** No action is taken when reminders are disabled. */
  skipped: boolean;
  scanned: number;
  sent: number;
  /** Skipped because already sent for this threshold. */
  alreadySent: number;
  /** Skipped because a manual or automatic reminder was sent in the last 24 hours. */
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
 * Scans upcoming renewals and sends one reminder for each subscription that
 * crosses a threshold.
 *
 * A unique index enforces uniqueness (see `recordAndSendReminder`), so the sweep
 * is rerunnable: even if interrupted, a sent reminder will not be sent twice.
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
  // Ascending order: if a subscription has crossed multiple thresholds, use the
  // narrowest one (for example, "1 day left") because it reflects the correct urgency.
  const thresholds = [...new Set(config.daysBefore)].sort((a, b) => a - b);
  const horizonDays = thresholds[thresholds.length - 1] ?? 0;
  const horizon = new Date(now.getTime() + (horizonDays + 1) * DAY_MS);

  // Do not collect results with toArray: as member count grows, so does the list
  // loaded into memory at once; streaming through the cursor uses constant memory.
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

    // Fast rejection: sendRenewalReminder enforces the cooldown under the lock;
    // this only avoids acquiring a pointless lock—the row's latest reminder time
    // already came free from the aggregation.
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
      // One failed send must not stop the sweep; because its record is rolled
      // back, the next run retries it.
      report.failed++;
      console.error("renewal reminder could not be sent:", err);
    }
  }

  if (report.sent > 0 || report.failed > 0) {
    console.info(
      `[reminders] ${report.sent} sent, ${report.failed} failed, ${report.scanned} scanned`,
    );
  }
  return report;
}

export interface RenewalReminderScheduler {
  /** Stops the scheduler and waits for the active run to finish. */
  stop(): Promise<void>;
  /** For tests and manual triggers: acquires the lock and runs one sweep. */
  runOnce(now?: Date): Promise<SweepReport | null>;
}

/**
 * Starts the hourly sweep. The timer is `unref`ed: a pending tick must not delay
 * process shutdown after SIGTERM.
 */
export function startRenewalReminderScheduler(
  database: Db = db,
): RenewalReminderScheduler {
  let stopped = false;
  // Wait for the active run during shutdown. If the process exits after writing
  // a reminder record but while awaiting SMTP, the record remains "sent," and
  // the unique index prevents retrying that threshold—the member silently gets
  // no reminder. (kill -9 still leaves this gap; graceful shutdown closes it.)
  let inFlight: Promise<unknown> = Promise.resolve();

  async function runOnce(now = new Date()): Promise<SweepReport | null> {
    // The lock prevents duplicate email to a member when instances scale out or
    // one run overlaps the next. The unique index is the last line of defense;
    // the lock avoids unnecessary work up front.
    const token = randomUUID();
    if (!(await acquireLock(SWEEP_LOCK_KEY, token, SWEEP_LOCK_LEASE_MS))) {
      return null;
    }
    try {
      return await runRenewalReminderSweep(database, now);
    } finally {
      await releaseLock(SWEEP_LOCK_KEY, token).catch((err: unknown) => {
        console.error("reminder sweep lock could not be released:", err);
      });
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = runOnce().catch((err: unknown) => {
      console.error("renewal reminder sweep failed:", err);
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
