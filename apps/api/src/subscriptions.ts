import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { MySubscription, SubscriptionMonths } from "@opengym/shared";
import { ObjectId } from "mongodb";
import type { Db, WithId } from "mongodb";
import { db, gymCollection } from "./db.js";
import { finishPendingCredit } from "./freezeCredit.js";
import { acquireLock, redis, releaseLock } from "./redis.js";
import {
  calculateSubscriptionPeriod,
  planLegacySubscriptionRepairs,
  planSubscriptionCancellation,
  summarizeSubscriptionTimeline,
  type SubscriptionTimelineRecord,
} from "./subscriptionTimeline.js";

export const USER_LOCK_LEASE_MS = 30_000;
export const USER_LOCK_WAIT_MS = 5_000;

/** Redis lock serializing every change to one member's subscription timeline. */
export const subscriptionUserLockKey = (userId: string): string =>
  `og:lock:subscription:${userId}`;
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
  /** Gyms the member may enter during this period */
  gymIds: ObjectId[];
  note: string | null;
  createdBy: string;
  createdAt: Date;
  /** Freezes whose credit was already applied to this period (idempotency marker) */
  freezeCredits?: ObjectId[];
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
  /** Validated, non-empty list of active gyms */
  gymIds: ObjectId[];
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

export async function withRedisLock<T>(
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

export function subscriptionCollection(database: Db = db) {
  return database.collection<SubscriptionFields>("subscriptions");
}

/** Serializes concurrent package additions for the same member through Redis. */
export async function createSequentialSubscription(
  input: CreateSequentialSubscriptionInput,
  database: Db = db,
): Promise<CreatedSequentialSubscription> {
  const userId = input.userId.toHexString();
  return withRedisLock(
    subscriptionUserLockKey(userId),
    USER_LOCK_LEASE_MS,
    USER_LOCK_WAIT_MS,
    async (assertOwned) => {
      // A freeze credit interrupted half-way must land before the new period
      // is planned from the latest end, or it would overlap the late shift.
      await finishPendingCredit(input.userId, assertOwned, database);
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
        gymIds: input.gymIds,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: now,
      });
      return { id: inserted.insertedId, startsAt, endsAt };
    },
  );
}

export type CancelSubscriptionResult =
  | { status: "not-found" }
  | { status: "started" }
  | { status: "out-of-scope" }
  | {
      status: "cancelled";
      cancelled: SubscriptionDocument;
      /** Later periods of the same member with their new dates */
      shifted: SubscriptionDocument[];
    };

/**
 * Cancels a period that has not started and pulls the member's later periods
 * forward by its duration. Read, re-check and write all happen under the same
 * per-user lock as createSequentialSubscription; the delete and the shifts go
 * out as one ordered bulkWrite.
 *
 * `canAccessGyms` is evaluated on the period re-read under the lock, so a
 * concurrent gym edit cannot slip past the scope check.
 */
export async function cancelScheduledSubscription(
  id: ObjectId,
  canAccessGyms: (gymIds: string[]) => boolean,
  database: Db = db,
): Promise<CancelSubscriptionResult> {
  const collection = subscriptionCollection(database);
  // The lock is per member, so the owner must be known before locking.
  const preview = await collection.findOne(
    { _id: id },
    { projection: { userId: 1 } },
  );
  if (!preview) return { status: "not-found" };

  return withRedisLock(
    subscriptionUserLockKey(preview.userId.toHexString()),
    USER_LOCK_LEASE_MS,
    USER_LOCK_WAIT_MS,
    async (assertOwned): Promise<CancelSubscriptionResult> => {
      // Settle an interrupted freeze credit first so the periods read below,
      // and the shift planned from them, are final.
      await finishPendingCredit(preview.userId, assertOwned, database);
      const target = await collection.findOne({ _id: id });
      if (!target || !target.userId.equals(preview.userId)) {
        return { status: "not-found" };
      }
      if (!canAccessGyms((target.gymIds ?? []).map((g) => g.toHexString()))) {
        return { status: "out-of-scope" };
      }
      if (target.startsAt.getTime() <= Date.now()) {
        return { status: "started" };
      }

      const later = await collection
        .find({ userId: target.userId, _id: { $ne: id } })
        .sort({ startsAt: 1, endsAt: 1, _id: 1 })
        .toArray();
      const plan = planSubscriptionCancellation(
        target,
        later.map((doc) => ({
          id: doc._id.toHexString(),
          startsAt: doc.startsAt,
          endsAt: doc.endsAt,
        })),
      );
      const byId = new Map(later.map((doc) => [doc._id.toHexString(), doc]));

      await assertOwned();
      await collection.bulkWrite(
        [
          { deleteOne: { filter: { _id: id } } },
          ...plan.map((change) => ({
            updateOne: {
              filter: { _id: byId.get(change.id)!._id },
              update: {
                $set: { startsAt: change.startsAt, endsAt: change.endsAt },
              },
            },
          })),
        ],
        { ordered: true },
      );

      const shifted = plan.map((change) => ({
        ...byId.get(change.id)!,
        startsAt: change.startsAt,
        endsAt: change.endsAt,
      }));
      return { status: "cancelled", cancelled: target, shifted };
    },
  );
}

export function findSubscription(
  id: ObjectId,
): Promise<SubscriptionDocument | null> {
  return subscriptionCollection().findOne({ _id: id });
}

/** Replaces the gyms of one period; dates and the sequence are untouched. */
export async function setSubscriptionGymIds(
  id: ObjectId,
  gymIds: readonly ObjectId[],
): Promise<SubscriptionDocument | null> {
  return subscriptionCollection().findOneAndUpdate(
    { _id: id },
    { $set: { gymIds: [...gymIds] } },
    { returnDocument: "after" },
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

export type EntrySubscriptionStatus = "ok" | "none" | "other-gym";

/**
 * Entry check against the subscription periods covering now: "ok" when one of
 * them lists the gym, "other-gym" when the member is subscribed but not for
 * this gym, "none" when there is no active period at all.
 */
export async function checkEntrySubscription(
  userId: string,
  gymId: string,
): Promise<EntrySubscriptionStatus> {
  if (!ObjectId.isValid(userId) || !ObjectId.isValid(gymId)) return "none";
  const now = new Date();
  const docs = await subscriptionCollection()
    .find(
      {
        userId: new ObjectId(userId),
        startsAt: { $lte: now },
        endsAt: { $gte: now },
      },
      { projection: { gymIds: 1 } },
    )
    .toArray();
  if (docs.length === 0) return "none";
  const gymOid = new ObjectId(gymId);
  return docs.some((doc) => (doc.gymIds ?? []).some((id) => id.equals(gymOid)))
    ? "ok"
    : "other-gym";
}

/** Gyms listed on the periods covering now (empty when not subscribed). */
export async function listActiveSubscriptionGymIds(
  userId: string,
  now = new Date(),
): Promise<ObjectId[]> {
  if (!ObjectId.isValid(userId)) return [];
  const docs = await subscriptionCollection()
    .find(
      {
        userId: new ObjectId(userId),
        startsAt: { $lte: now },
        endsAt: { $gte: now },
      },
      { projection: { gymIds: 1 } },
    )
    .toArray();
  const seen = new Map<string, ObjectId>();
  for (const doc of docs) {
    for (const id of doc.gymIds ?? []) seen.set(id.toHexString(), id);
  }
  return [...seen.values()];
}

/** Converts the active subscription and contiguous future packages to a mobile summary. */
export async function getSubscriptionSummary(
  userId: string,
  now = new Date(),
): Promise<Omit<MySubscription, "freezeAllowance">> {
  if (!ObjectId.isValid(userId)) {
    return {
      active: false,
      startsAt: null,
      endsAt: null,
      remainingDays: 0,
      gymIds: [],
      gyms: [],
      freeze: null,
    };
  }
  const docs = await subscriptionCollection()
    .find({ userId: new ObjectId(userId), endsAt: { $gte: now } })
    .sort({ startsAt: 1, endsAt: 1, createdAt: 1, _id: 1 })
    .toArray();
  const summary = summarizeSubscriptionTimeline(docs, now);
  // Read directly (not via freeze.ts, which imports this module for the lock).
  const openFreeze = await db
    .collection<{ userId: ObjectId; startedAt: Date; endedAt: Date | null }>(
      "subscription_freezes",
    )
    .findOne(
      { userId: new ObjectId(userId), endedAt: null },
      { projection: { startedAt: 1 } },
    );
  const gymIds = summary.active
    ? await listActiveSubscriptionGymIds(userId, now)
    : [];
  const gymDocs =
    gymIds.length > 0
      ? await gymCollection()
          .find({ _id: { $in: gymIds } })
          .sort({ createdAt: 1, _id: 1 })
          .toArray()
      : [];
  return {
    active: summary.active,
    startsAt: summary.startsAt?.toISOString() ?? null,
    endsAt: summary.endsAt?.toISOString() ?? null,
    remainingDays: summary.remainingDays,
    gymIds: gymDocs.map((gym) => gym._id.toHexString()),
    gyms: gymDocs.map((gym) => ({
      id: gym._id.toHexString(),
      name: gym.name,
      active: gym.active,
    })),
    freeze: openFreeze
      ? { startedAt: openFreeze.startedAt.toISOString() }
      : null,
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
