/**
 * Member weight history: a timestamped record is added whenever `weightKg` in
 * the profile changes. The full history is read so the calendar can show the
 * value in effect since the latest change when the selected day has no record.
 */

import { weightHistoryCollection } from "./db.js";

/** Record only changes to avoid bloating history with repeated values. */
export function shouldRecordWeightChange(
  lastWeightKg: number | null,
  nextWeightKg: number,
): boolean {
  return lastWeightKg == null || lastWeightKg !== nextWeightKg;
}

/** Called from the BetterAuth `user.update.after` hook. */
export async function recordWeightHistoryIfChanged(
  userId: string,
  weightKg: number,
): Promise<void> {
  const last = await weightHistoryCollection()
    .find({ userId })
    .sort({ at: -1 })
    .limit(1)
    .next();
  if (!shouldRecordWeightChange(last?.weightKg ?? null, weightKg)) return;
  await weightHistoryCollection().insertOne({
    userId,
    weightKg,
    at: new Date(),
  });
  await pruneWeightHistory(userId);
}

const WEIGHT_HISTORY_LIMIT = 500;

/**
 * History is limited per member; otherwise, a member repeatedly changing their
 * weight could grow the health data store without bound. Reads already apply
 * the same limit, so excess records would never be displayed.
 */
async function pruneWeightHistory(userId: string): Promise<void> {
  const oldest = await weightHistoryCollection()
    .find({ userId })
    .sort({ at: -1 })
    .skip(WEIGHT_HISTORY_LIMIT)
    .limit(1)
    .next();
  if (!oldest) return;
  await weightHistoryCollection().deleteMany({
    userId,
    at: { $lte: oldest.at },
  });
}

/** Member weight history sorted by ascending time. */
export async function listWeightHistory(
  userId: string,
): Promise<{ weightKg: number; at: Date }[]> {
  const rows = await weightHistoryCollection()
    .find({ userId })
    .sort({ at: -1 })
    .limit(WEIGHT_HISTORY_LIMIT)
    .toArray();
  return rows.reverse().map((row) => ({ weightKg: row.weightKg, at: row.at }));
}
