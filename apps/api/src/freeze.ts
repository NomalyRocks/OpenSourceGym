import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  FreezeConfig,
  MemberFreezeState,
  MyFreezeAllowance,
} from "@opengym/shared";
import { findChainSettings, isDuplicateKeyError } from "./db.js";
import {
  subscriptionCollection,
  SubscriptionLockTimeoutError,
  subscriptionUserLockKey,
  USER_LOCK_LEASE_MS,
  USER_LOCK_WAIT_MS,
  withRedisLock,
} from "./subscriptions.js";
import {
  applyFreezeCredit,
  finishPendingCredit,
  freezeCollection,
  type FreezeCreditChange,
  type FreezeDocument,
  type FreezeEndReason,
} from "./freezeCredit.js";

export { freezeCollection } from "./freezeCredit.js";
export type {
  FreezeCreditChange,
  FreezeDocument,
  FreezeEndReason,
} from "./freezeCredit.js";
import { listMemberGymIds, logMemberAudit } from "./memberScope.js";
import {
  calculateFreezeCreditMs,
  evaluateEntryWithFreezeCredit,
  planFreezeCredit,
  type EntryAccess,
} from "./subscriptionTimeline.js";

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365;

export const DEFAULT_FREEZE_CONFIG: FreezeConfig = {
  enabled: true,
  memberSelfService: true,
  maxPerYear: 4,
  maxDays: 30,
};

/** Validation for `ChainSettings.freeze` on PUT /api/admin/settings. */
export const freezeConfigSchema = z
  .object({
    enabled: z.boolean(),
    memberSelfService: z.boolean(),
    maxPerYear: z.number().int().min(0).max(12),
    maxDays: z.number().int().min(1).max(180),
  })
  .strict();

/** Chain freeze rules with the defaults filled in for anything not stored. */
export async function getFreezeConfig(): Promise<FreezeConfig> {
  const stored = (await findChainSettings())?.freeze ?? {};
  return {
    enabled: stored.enabled ?? DEFAULT_FREEZE_CONFIG.enabled,
    memberSelfService:
      stored.memberSelfService ?? DEFAULT_FREEZE_CONFIG.memberSelfService,
    maxPerYear: stored.maxPerYear ?? DEFAULT_FREEZE_CONFIG.maxPerYear,
    maxDays: stored.maxDays ?? DEFAULT_FREEZE_CONFIG.maxDays,
  };
}

export function findOpenFreeze(
  userId: ObjectId,
): Promise<FreezeDocument | null> {
  return freezeCollection().findOne({
    userId,
    endedAt: null,
  }) as Promise<FreezeDocument | null>;
}

function countFreezesInLastYear(userId: ObjectId, now: Date): Promise<number> {
  return freezeCollection().countDocuments({
    userId,
    startedAt: { $gt: new Date(now.getTime() - YEAR_DAYS * DAY_MS) },
  });
}

/** Freeze facts for the panel's member drawer. */
export async function getMemberFreezeState(
  userId: ObjectId,
): Promise<MemberFreezeState> {
  const [config, open, usedInLastYear] = await Promise.all([
    getFreezeConfig(),
    findOpenFreeze(userId),
    countFreezesInLastYear(userId, new Date()),
  ]);
  return {
    active: open
      ? {
          startedAt: open.startedAt.toISOString(),
          maxDays: open.maxDays,
          startedBy: open.startedBy,
        }
      : null,
    usedInLastYear,
    config,
  };
}

/**
 * What the member app may offer. False when freezing (or member self-service)
 * is off, the account is banned, the yearly limit is used up, there is no
 * running period, or the membership is already frozen.
 */
export async function getFreezeAllowance(
  userId: ObjectId,
  member: { isMember: boolean; banned: boolean },
): Promise<MyFreezeAllowance> {
  const now = new Date();
  const [config, open, usedInLastYear, running] = await Promise.all([
    getFreezeConfig(),
    findOpenFreeze(userId),
    countFreezesInLastYear(userId, now),
    subscriptionCollection().findOne(
      { userId, startsAt: { $lte: now }, endsAt: { $gt: now } },
      { projection: { _id: 1 } },
    ),
  ]);
  return {
    canFreeze:
      member.isMember &&
      !member.banned &&
      config.enabled &&
      config.memberSelfService &&
      !open &&
      running !== null &&
      usedInLastYear < config.maxPerYear,
    usedInLastYear,
    maxPerYear: config.maxPerYear,
    maxDays: config.maxDays,
  };
}

/**
 * Entry decision for a frozen member as if the freeze ended now, without
 * touching anything. Same answers as `checkEntrySubscription`.
 */
export async function checkEntryDuringFreeze(
  userId: string,
  gymId: string,
  freeze: Pick<FreezeDocument, "startedAt" | "maxDays">,
): Promise<EntryAccess> {
  const periods = await subscriptionCollection()
    .find({ userId: new ObjectId(userId), endsAt: { $gt: freeze.startedAt } })
    .toArray();
  return evaluateEntryWithFreezeCredit(
    periods.map((p) => ({
      id: p._id.toHexString(),
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      gymIds: (p.gymIds ?? []).map((g) => g.toHexString()),
    })),
    freeze,
    new Date(),
    gymId,
  );
}

export type StartFreezeResult =
  | { status: "started"; freeze: FreezeDocument }
  | {
      status:
        | "disabled"
        | "out-of-scope"
        | "already-frozen"
        | "no-active-period"
        | "limit-reached";
    };

/** Freezes the member's running period (`selfService`: the member asked from the app). Throws SubscriptionLockTimeoutError. */
export async function startFreeze(
  userId: ObjectId,
  startedBy: string,
  options: {
    selfService?: boolean;
    /** Scope check run under the lock against the gyms on all of the member's periods */
    canManage?: (memberGymIds: string[]) => boolean;
  } = {},
): Promise<StartFreezeResult> {
  return withRedisLock(
    subscriptionUserLockKey(userId.toHexString()),
    USER_LOCK_LEASE_MS,
    USER_LOCK_WAIT_MS,
    async (assertOwned): Promise<StartFreezeResult> => {
      // Settle any interrupted credit first so the periods are final.
      await finishPendingCredit(userId, assertOwned);
      if (
        options.canManage &&
        !options.canManage(await listMemberGymIds(userId))
      ) {
        return { status: "out-of-scope" };
      }
      const config = await getFreezeConfig();
      if (!config.enabled) return { status: "disabled" };
      // Staff may still freeze when members cannot do it themselves.
      if (options.selfService && !config.memberSelfService) {
        return { status: "disabled" };
      }
      if (await findOpenFreeze(userId)) return { status: "already-frozen" };

      const now = new Date();
      const running = await subscriptionCollection().findOne(
        { userId, startsAt: { $lte: now }, endsAt: { $gt: now } },
        { projection: { _id: 1 } },
      );
      if (!running) return { status: "no-active-period" };

      if ((await countFreezesInLastYear(userId, now)) >= config.maxPerYear) {
        return { status: "limit-reached" };
      }

      const doc: Omit<FreezeDocument, "_id"> = {
        userId,
        startedAt: now,
        startedBy,
        maxDays: config.maxDays,
        endedAt: null,
        endedBy: null,
        endReason: null,
        creditedMs: null,
        plan: null,
        creditApplied: false,
      };
      await assertOwned();
      try {
        const inserted = await freezeCollection().insertOne(doc);
        return {
          status: "started",
          freeze: { _id: inserted.insertedId, ...doc },
        };
      } catch (error) {
        // The unique partial index is the real guard against two open freezes.
        if (isDuplicateKeyError(error)) return { status: "already-frozen" };
        throw error;
      }
    },
  );
}

export type EndFreezeResult =
  | { status: "not-frozen" }
  | { status: "out-of-scope" }
  | { status: "ended"; freeze: FreezeDocument; creditedMs: number };

/**
 * Ends the member's open freeze and credits the frozen time back: the running
 * period gets a later end and later periods are repacked behind it (see
 * {@link planFreezeCredit}). Runs under the same per-user lock as every other
 * timeline change.
 *
 * Order matters. The plan is computed first, then the freeze is closed with the
 * plan stored on it (an atomic claim of the open row, so a retry can never
 * credit it twice), then the plan is applied. If the apply fails part-way the
 * claim is NOT reopened: some periods may already be shifted, and reopening
 * would credit them again. The freeze stays closed with `creditApplied: false`
 * and the stored plan is finished by the next end/reap for this member.
 *
 * `max-days` ends the freeze at exactly `startedAt + maxDays` and credits
 * exactly `maxDays`, however late the reaper ran.
 */
export async function endFreeze(
  userId: ObjectId,
  how: {
    reason: FreezeEndReason;
    endedBy: string | null;
    /** Scope check run under the lock against the gyms on all of the member's periods */
    canManage?: (memberGymIds: string[]) => boolean;
    /** How long to wait for the user lock; defaults to USER_LOCK_WAIT_MS */
    lockWaitMs?: number;
  },
): Promise<EndFreezeResult> {
  return withRedisLock(
    subscriptionUserLockKey(userId.toHexString()),
    USER_LOCK_LEASE_MS,
    how.lockWaitMs ?? USER_LOCK_WAIT_MS,
    async (assertOwned): Promise<EndFreezeResult> => {
      // A half-applied earlier credit must land before this plan reads periods.
      await finishPendingCredit(userId, assertOwned);
      if (how.canManage && !how.canManage(await listMemberGymIds(userId))) {
        return { status: "out-of-scope" };
      }

      const open = await findOpenFreeze(userId);
      if (!open) return { status: "not-frozen" };

      const endedAt =
        how.reason === "max-days"
          ? new Date(open.startedAt.getTime() + open.maxDays * DAY_MS)
          : new Date();
      const creditedMs = calculateFreezeCreditMs(
        open.startedAt,
        endedAt,
        open.maxDays,
      );

      const periods = await subscriptionCollection()
        .find({ userId, endsAt: { $gt: open.startedAt } })
        .toArray();
      const byId = new Map(periods.map((p) => [p._id.toHexString(), p]));
      const plan: FreezeCreditChange[] = planFreezeCredit(
        periods.map((p) => ({
          id: p._id.toHexString(),
          startsAt: p.startsAt,
          endsAt: p.endsAt,
        })),
        open.startedAt,
        creditedMs,
      )
        .filter((change) => {
          const current = byId.get(change.id)!;
          return (
            change.startsAt.getTime() !== current.startsAt.getTime() ||
            change.endsAt.getTime() !== current.endsAt.getTime()
          );
        })
        .map((change) => ({
          subscriptionId: byId.get(change.id)!._id,
          startsAt: change.startsAt,
          endsAt: change.endsAt,
        }));

      await assertOwned();
      const claimed = (await freezeCollection().findOneAndUpdate(
        { _id: open._id, endedAt: null },
        {
          $set: {
            endedAt,
            endedBy: how.endedBy,
            endReason: how.reason,
            creditedMs,
            plan,
            creditApplied: false,
          },
        },
        { returnDocument: "after" },
      )) as FreezeDocument | null;
      if (!claimed) return { status: "not-frozen" };

      await applyFreezeCredit(claimed, assertOwned);
      return {
        status: "ended",
        freeze: { ...claimed, creditApplied: true },
        creditedMs,
      };
    },
  );
}

/**
 * Finishes this member's interrupted credit, if one exists, so the periods a
 * gate decision reads are final. The lookup uses the unsettled-freeze index's
 * filter, so members without a pending credit never take the user lock.
 * Throws SubscriptionLockTimeoutError when the lock stays busy.
 */
export async function settlePendingCredit(userId: ObjectId): Promise<void> {
  const pending = await freezeCollection().findOne(
    { userId, endedAt: { $ne: null }, creditApplied: false },
    { projection: { _id: 1 } },
  );
  if (!pending) return;
  await withRedisLock(
    subscriptionUserLockKey(userId.toHexString()),
    USER_LOCK_LEASE_MS,
    USER_LOCK_WAIT_MS,
    (assertOwned) => finishPendingCredit(userId, assertOwned),
  );
}

/**
 * Finishes every interrupted credit. Each member is handled under their lock;
 * a busy member is retried on the next sweep.
 */
export async function finishInterruptedCredits(): Promise<number> {
  const userIds = await freezeCollection().distinct("userId", {
    endedAt: { $ne: null },
    creditApplied: false,
  });
  let finished = 0;
  for (const userId of userIds) {
    try {
      await withRedisLock(
        subscriptionUserLockKey(userId.toHexString()),
        USER_LOCK_LEASE_MS,
        USER_LOCK_WAIT_MS,
        (assertOwned) => finishPendingCredit(userId, assertOwned),
      );
      finished += 1;
    } catch (error) {
      if (!(error instanceof SubscriptionLockTimeoutError)) {
        console.error("freeze credit recovery failed:", error);
      }
    }
  }
  return finished;
}

/** Audit actor for sweeps that no person triggered. */
const REAPER_ACTOR = { id: "system", email: "system" };

/**
 * Ends every freeze that has outlived its `maxDays` and writes the same
 * `subscription-unfrozen` audit rows as a manual end. Returns how many ended.
 */
export async function reapExpiredFreezes(now = new Date()): Promise<number> {
  await finishInterruptedCredits();
  const due = await freezeCollection()
    .find(
      {
        endedAt: null,
        creditApplied: false,
        $expr: {
          $lte: [
            { $add: ["$startedAt", { $multiply: ["$maxDays", DAY_MS] }] },
            now,
          ],
        },
      },
      { projection: { userId: 1 } },
    )
    .toArray();
  let ended = 0;
  for (const row of due) {
    try {
      const result = await endFreeze(row.userId, {
        reason: "max-days",
        endedBy: null,
      });
      if (result.status === "ended") {
        ended += 1;
        try {
          await logMemberAudit(
            REAPER_ACTOR,
            "subscription-unfrozen",
            row.userId,
            {
              freezeId: result.freeze._id.toHexString(),
              startedAt: result.freeze.startedAt.toISOString(),
              endedAt: result.freeze.endedAt?.toISOString() ?? null,
              creditedMs: result.creditedMs,
              reason: "max-days",
            },
          );
        } catch (error) {
          // The freeze is already credited; a missing row must not stop the sweep.
          console.error("freeze reap audit failed:", error);
        }
      }
    } catch (error) {
      // A busy member is retried on the next sweep; other members must not wait.
      if (!(error instanceof SubscriptionLockTimeoutError)) {
        console.error("freeze reap failed:", error);
      }
    }
  }
  return ended;
}

const REAP_INTERVAL_MS = 60 * 60 * 1000;

export interface FreezeReaper {
  /** Stops the sweep and waits for an in-flight run. */
  stop(): Promise<void>;
  /** For tests and manual triggers: runs one sweep now. */
  runOnce(): Promise<number>;
}

/**
 * Starts the hourly sweep that ends freezes left open past their `maxDays`.
 * Each member is handled under the per-user subscription lock, so overlapping
 * instances are safe: the loser finds the freeze already closed. The timer is
 * `unref`ed so a pending tick never delays shutdown.
 */
export function startFreezeReaper(): FreezeReaper {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function runOnce(): Promise<number> {
    const ended = await reapExpiredFreezes();
    if (ended > 0) console.info(`[freeze] ended ${ended} expired freezes`);
    return ended;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = runOnce().catch((err: unknown) => {
      console.error("freeze reap failed:", err);
    });
  }, REAP_INTERVAL_MS);
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
