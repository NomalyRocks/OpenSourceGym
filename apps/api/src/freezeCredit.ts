import type { Collection, Db, ObjectId } from "mongodb";
import { db } from "./db.js";

/**
 * Persistence of freezes and the (idempotent) application of their credit.
 * Kept free of imports from subscriptions.ts so that subscriptions.ts can
 * settle an unsettled credit before it plans a timeline change, inside its
 * own per-user lock, without a module cycle.
 */

export type FreezeEndReason = "resumed" | "gate-scan" | "max-days";

/** One row of `subscription_freezes`. */
export interface FreezeDocument {
  _id: ObjectId;
  userId: ObjectId;
  startedAt: Date;
  /** Id of the staff member who froze the membership */
  startedBy: string;
  /** Snapshot of the chain setting at start, so a later change cannot shrink or grow it */
  maxDays: number;
  endedAt: Date | null;
  /** Staff id, the member's id for a gate scan, or null for the reaper */
  endedBy: string | null;
  endReason: FreezeEndReason | null;
  creditedMs: number | null;
  /**
   * Period dates decided when the freeze closed. Persisted so that a credit
   * interrupted half-way is finished from the same plan, never recomputed from
   * a timeline that is already partly shifted.
   */
  plan: FreezeCreditChange[] | null;
  /** False from start until the plan has been fully written to the periods */
  creditApplied: boolean;
}

export interface FreezeCreditChange {
  subscriptionId: ObjectId;
  startsAt: Date;
  endsAt: Date;
}

export function freezeCollection(
  database: Db = db,
): Collection<Omit<FreezeDocument, "_id">> {
  return database.collection<Omit<FreezeDocument, "_id">>(
    "subscription_freezes",
  );
}

interface PeriodFields {
  startsAt: Date;
  endsAt: Date;
  freezeCredits?: ObjectId[];
}

function periodCollection(database: Db = db): Collection<PeriodFields> {
  return database.collection<PeriodFields>("subscriptions");
}

/**
 * Writes a closed freeze's plan to the periods and marks it applied.
 *
 * Idempotent: each period is updated only while it lacks this freeze's id in
 * `freezeCredits`, and the update adds the id, so running it twice (a retry
 * after a crash, or two instances) can never credit a period twice. The latest
 * period goes first so the timeline never overlaps mid-write.
 */
export async function applyFreezeCredit(
  freeze: FreezeDocument,
  assertOwned: () => Promise<void>,
  database: Db = db,
): Promise<void> {
  const changes = freeze.plan ?? [];
  if (changes.length > 0) {
    await assertOwned();
    await periodCollection(database).bulkWrite(
      [...changes].reverse().map((change) => ({
        updateOne: {
          filter: {
            _id: change.subscriptionId,
            freezeCredits: { $ne: freeze._id },
          },
          update: {
            $set: { startsAt: change.startsAt, endsAt: change.endsAt },
            $addToSet: { freezeCredits: freeze._id },
          },
        },
      })),
      { ordered: true },
    );
  }
  await freezeCollection(database).updateOne(
    { _id: freeze._id },
    { $set: { creditApplied: true } },
  );
}

/** Finishes credits of freezes that closed but whose period writes did not complete. */
export async function finishPendingCredit(
  userId: ObjectId,
  assertOwned: () => Promise<void>,
  database: Db = db,
): Promise<void> {
  const pending = (await freezeCollection(database)
    .find({ userId, endedAt: { $ne: null }, creditApplied: false })
    .sort({ startedAt: 1 })
    .toArray()) as FreezeDocument[];
  for (const freeze of pending) {
    await applyFreezeCredit(freeze, assertOwned, database);
  }
}
