import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { MySubscription, SubscriptionMonths } from "@opengym/shared";
import { ObjectId } from "mongodb";
import type { Db, WithId } from "mongodb";
import { db } from "./db.js";
import { acquireLock, redis, releaseLock } from "./redis.js";
import {
  calculateSubscriptionPeriod,
  planLegacySubscriptionRepairs,
  summarizeSubscriptionTimeline,
  type SubscriptionTimelineRecord,
} from "./subscriptionTimeline.js";

const USER_LOCK_LEASE_MS = 30_000;
const USER_LOCK_WAIT_MS = 5_000;
const REPAIR_LOCK_LEASE_MS = 60_000;
const REPAIR_LOCK_WAIT_MS = 15 * 60_000;
const REPAIR_MARKER_ID = "subscription-overlap-repair-v1";

const EXTEND_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

interface SubscriptionFields {
  userId: ObjectId;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

export type SubscriptionDocument = WithId<SubscriptionFields>;

interface SubscriptionRepairMarker {
  _id: string;
  completedAt: Date;
  scannedCount: number;
  repairedCount: number;
  invalidCount: number;
}

export interface SubscriptionRepairReport {
  skipped: boolean;
  scannedCount: number;
  repairedCount: number;
  invalidCount: number;
}

export interface CreateSequentialSubscriptionInput {
  userId: ObjectId;
  months: SubscriptionMonths;
  note: string | null;
  createdBy: string;
}

export interface CreatedSequentialSubscription {
  id: ObjectId;
  startsAt: Date;
  endsAt: Date;
}

export class SubscriptionLockTimeoutError extends Error {
  constructor() {
    super("A subscription operation is being processed by another request.");
    this.name = "SubscriptionLockTimeoutError";
  }
}

class SubscriptionLockLostError extends SubscriptionLockTimeoutError {
  constructor() {
    super();
    this.message = "Subscription operation lock ownership was lost.";
    this.name = "SubscriptionLockLostError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function withRedisLock<T>(
  key: string,
  leaseMs: number,
  waitMs: number,
  work: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;

  while (true) {
    if (await acquireLock(key, token, leaseMs)) break;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new SubscriptionLockTimeoutError();
    await delay(Math.min(50 + Math.floor(Math.random() * 50), remainingMs));
  }

  let lostError: SubscriptionLockLostError | null = null;
  const assertOwned = async (): Promise<void> => {
    if (lostError) throw lostError;
    try {
      const extended = await redis.eval(EXTEND_LOCK_SCRIPT, {
        keys: [key],
        arguments: [token, String(leaseMs)],
      });
      if (Number(extended) !== 1) {
        lostError = new SubscriptionLockLostError();
        throw lostError;
      }
    } catch (error) {
      if (error instanceof SubscriptionLockLostError) throw error;
      lostError = new SubscriptionLockLostError();
      throw lostError;
    }
  };

  const renewalController = new AbortController();
  const renewalIntervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const renewal = (async () => {
    while (!renewalController.signal.aborted && !lostError) {
      try {
        await delay(renewalIntervalMs, undefined, {
          signal: renewalController.signal,
        });
      } catch (error) {
        if (isAbortError(error)) return;
        lostError = new SubscriptionLockLostError();
        return;
      }
      try {
        await assertOwned();
      } catch {
        return;
      }
    }
  })();

  try {
    await assertOwned();
    return await work(assertOwned);
  } finally {
    renewalController.abort();
    await renewal;
    await releaseLock(key, token).catch((error: unknown) => {
      // If Redis is unavailable, the lease clears the lock automatically; do
      // not obscure the underlying Mongo operation with a cleanup error.
      console.error("subscription lock release failed:", error);
    });
  }
}

function subscriptionCollection(database: Db = db) {
  return database.collection<SubscriptionFields>("subscriptions");
}

/** Serializes concurrent package additions for the same member through Redis. */
export async function createSequentialSubscription(
  input: CreateSequentialSubscriptionInput,
  database: Db = db,
): Promise<CreatedSequentialSubscription> {
  const userId = input.userId.toHexString();
  return withRedisLock(
    `og:lock:subscription:${userId}`,
    USER_LOCK_LEASE_MS,
    USER_LOCK_WAIT_MS,
    async (assertOwned) => {
      const latest = await subscriptionCollection(database).findOne(
        { userId: input.userId },
        { sort: { endsAt: -1, createdAt: -1, _id: -1 } },
      );
      const now = new Date();
      const { startsAt, endsAt } = calculateSubscriptionPeriod(
        now,
        latest?.endsAt ?? null,
        input.months,
      );
      await assertOwned();
      const inserted = await subscriptionCollection(database).insertOne({
        userId: input.userId,
        startsAt,
        endsAt,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: now,
      });
      return { id: inserted.insertedId, startsAt, endsAt };
    },
  );
}

export async function listUserSubscriptions(
  userId: ObjectId,
  limit = 50,
): Promise<SubscriptionDocument[]> {
  return subscriptionCollection()
    .find({ userId })
    .sort({ endsAt: -1, createdAt: -1, _id: -1 })
    .limit(limit)
    .toArray();
}

/** Whether the user currently has an active subscription interval (QR check). */
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  if (!ObjectId.isValid(userId)) return false;
  const now = new Date();
  const doc = await subscriptionCollection().findOne({
    userId: new ObjectId(userId),
    startsAt: { $lte: now },
    endsAt: { $gte: now },
  });
  return doc !== null;
}

/** Converts the active subscription and contiguous future packages to a mobile summary. */
export async function getSubscriptionSummary(
  userId: string,
  now = new Date(),
): Promise<MySubscription> {
  if (!ObjectId.isValid(userId)) {
    return { active: false, startsAt: null, endsAt: null, remainingDays: 0 };
  }
  const docs = await subscriptionCollection()
    .find({ userId: new ObjectId(userId), endsAt: { $gte: now } })
    .sort({ startsAt: 1, endsAt: 1, createdAt: 1, _id: 1 })
    .toArray();
  const summary = summarizeSubscriptionTimeline(docs, now);
  return {
    active: summary.active,
    startsAt: summary.startsAt?.toISOString() ?? null,
    endsAt: summary.endsAt?.toISOString() ?? null,
    remainingDays: summary.remainingDays,
  };
}

function isValidSubscriptionDocument(
  doc: SubscriptionDocument,
): doc is SubscriptionDocument {
  return (
    doc._id instanceof ObjectId &&
    doc.userId instanceof ObjectId &&
    doc.startsAt instanceof Date &&
    Number.isFinite(doc.startsAt.getTime()) &&
    doc.endsAt instanceof Date &&
    Number.isFinite(doc.endsAt.getTime()) &&
    doc.endsAt > doc.startsAt &&
    doc.createdAt instanceof Date &&
    Number.isFinite(doc.createdAt.getTime())
  );
}

/**
 * Repairs overlaps in legacy date-based subscriptions once. The marker is
 * written only after all updates finish; an interrupted run safely resumes at
 * the next startup.
 */
export async function repairLegacySubscriptionOverlaps(
  database: Db = db,
): Promise<SubscriptionRepairReport> {
  const markers =
    database.collection<SubscriptionRepairMarker>("migration_markers");
  const existingMarker = await markers.findOne({ _id: REPAIR_MARKER_ID });
  if (existingMarker) {
    return {
      skipped: true,
      scannedCount: existingMarker.scannedCount,
      repairedCount: existingMarker.repairedCount,
      invalidCount: existingMarker.invalidCount,
    };
  }

  return withRedisLock(
    `og:lock:migration:${REPAIR_MARKER_ID}`,
    REPAIR_LOCK_LEASE_MS,
    REPAIR_LOCK_WAIT_MS,
    async (assertOwned) => {
      const markerAfterLock = await markers.findOne({
        _id: REPAIR_MARKER_ID,
      });
      if (markerAfterLock) {
        return {
          skipped: true,
          scannedCount: markerAfterLock.scannedCount,
          repairedCount: markerAfterLock.repairedCount,
          invalidCount: markerAfterLock.invalidCount,
        };
      }

      const docs = await subscriptionCollection(database).find({}).toArray();
      const validDocs = docs.filter(isValidSubscriptionDocument);
      const invalidCount = docs.length - validDocs.length;
      const records: SubscriptionTimelineRecord[] = validDocs.map((doc) => ({
        id: doc._id.toHexString(),
        userId: doc.userId.toHexString(),
        startsAt: doc.startsAt,
        endsAt: doc.endsAt,
        createdAt: doc.createdAt,
      }));
      const repairs = planLegacySubscriptionRepairs(records);
      const objectIds = new Map(
        validDocs.map((doc) => [doc._id.toHexString(), doc._id] as const),
      );

      if (repairs.length > 0) {
        await assertOwned();
        await subscriptionCollection(database).bulkWrite(
          repairs.map((repair) => ({
            updateOne: {
              filter: { _id: objectIds.get(repair.id)! },
              update: {
                $set: {
                  startsAt: repair.startsAt,
                  endsAt: repair.endsAt,
                },
              },
            },
          })),
          { ordered: true },
        );
      }

      const report: SubscriptionRepairReport = {
        skipped: false,
        scannedCount: docs.length,
        repairedCount: repairs.length,
        invalidCount,
      };
      await assertOwned();
      await markers.insertOne({
        _id: REPAIR_MARKER_ID,
        completedAt: new Date(),
        scannedCount: report.scannedCount,
        repairedCount: report.repairedCount,
        invalidCount: report.invalidCount,
      });

      if (repairs.length > 0 || invalidCount > 0) {
        console.info(
          `[subscriptions] legacy timeline repair: ${repairs.length} repaired, ${invalidCount} invalid`,
        );
      }
      return report;
    },
  );
}
