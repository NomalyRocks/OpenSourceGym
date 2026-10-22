import type { ObjectId, Db, Document } from "mongodb";
import { db } from "./db.js";
import { freezeCollection } from "./freezeCredit.js";

/**
 * Members with an open freeze (`endedAt: null`, at most one per member).
 *
 * The single definition behind every "frozen members are excluded from
 * renewals and active counts" rule in reports and reminders. Open freezes are
 * few by nature (bounded by the members currently paused), so reading the ids
 * once and filtering with `$nin` is cheaper and simpler than joining per row.
 */
async function listFrozenUserIds(database: Db = db): Promise<ObjectId[]> {
  // `$type: "null"` rather than `endedAt: null`: the latter also matches a
  // missing field, so the planner could not use the partial unique index.
  const docs = await freezeCollection(database)
    .find({ endedAt: { $type: "null" } }, { projection: { userId: 1 } })
    .toArray();
  return docs.map((doc) => doc.userId);
}

/** `$match` keeping only subscription periods of members who are not frozen. */
export function excludeFrozenStages(frozenIds: readonly ObjectId[]) {
  return frozenIds.length > 0
    ? [{ $match: { userId: { $nin: [...frozenIds] } } }]
    : [];
}

/**
 * `$match` stages that keep only members who are not frozen. Every count or
 * listing of entitled members must start with these stages: a frozen member is
 * paused, so counting them as active, renewing or reminding them is wrong.
 */
export async function excludeFrozenMembersStages(
  database: Db = db,
): Promise<Document[]> {
  return excludeFrozenStages(await listFrozenUserIds(database));
}

/** Whether the member has an open freeze right now. */
export async function isMemberFrozen(
  userId: ObjectId,
  database: Db = db,
): Promise<boolean> {
  const open = await freezeCollection(database).findOne(
    { userId, endedAt: { $type: "null" } },
    { projection: { _id: 1 } },
  );
  return open !== null;
}

export interface StartedPeriod {
  endsAt: Date;
  gymIds: readonly ObjectId[];
}

/**
 * Gyms a frozen member belongs to: those of their currently active periods, or
 * - when the nominal end passed during the freeze - those of the latest started
 * period(s). Same rule as the user directory. `periods` must already be
 * limited to periods that have started.
 */
export function frozenMemberGymIds(
  periods: readonly StartedPeriod[],
  now: Date,
): string[] {
  const active = periods.filter((p) => p.endsAt > now);
  let basis = active;
  if (basis.length === 0 && periods.length > 0) {
    const latest = Math.max(...periods.map((p) => p.endsAt.getTime()));
    basis = periods.filter((p) => p.endsAt.getTime() === latest);
  }
  return [
    ...new Set(basis.flatMap((p) => p.gymIds.map((g) => g.toHexString()))),
  ];
}

export interface FrozenCounts {
  /** Unique frozen members with at least one started period (chain-wide) */
  chain: number;
  /** Unique frozen members per gym id */
  byGym: Map<string, number>;
}

export async function countFrozenMembers(
  database: Db = db,
  now = new Date(),
): Promise<FrozenCounts> {
  const frozenIds = await listFrozenUserIds(database);
  const byGym = new Map<string, number>();
  if (frozenIds.length === 0) return { chain: 0, byGym };
  const periods = await database
    .collection("subscriptions")
    .find(
      { userId: { $in: frozenIds }, startsAt: { $lte: now } },
      { projection: { userId: 1, endsAt: 1, gymIds: 1 } },
    )
    .toArray();
  const perUser = new Map<string, StartedPeriod[]>();
  for (const p of periods) {
    const key = (p.userId as ObjectId).toHexString();
    const list = perUser.get(key) ?? [];
    list.push({
      endsAt: p.endsAt as Date,
      gymIds: (p.gymIds as ObjectId[] | undefined) ?? [],
    });
    perUser.set(key, list);
  }
  for (const list of perUser.values()) {
    for (const gymId of frozenMemberGymIds(list, now)) {
      byGym.set(gymId, (byGym.get(gymId) ?? 0) + 1);
    }
  }
  return { chain: perUser.size, byGym };
}
