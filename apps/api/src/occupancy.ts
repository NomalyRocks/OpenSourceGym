import { findGymSettings } from "./db.js";
import { redis } from "./redis.js";

// Members inside: field = userId, value = entry time (epoch ms, string)
const INSIDE_KEY = "og:inside";

// Marks a member as "inside" (when entry through the turnstile is allowed)
export async function markInside(userId: string): Promise<void> {
  await redis.hSet(INSIDE_KEY, userId, String(Date.now()));
}

// Marks a member as "outside" (exit turnstile event or account deletion cleanup)
export async function markOutside(userId: string): Promise<void> {
  await redis.hDel(INSIDE_KEY, userId);
}

/** Default when the operator has not configured `autoExitHours`. */
const DEFAULT_AUTO_EXIT_HOURS = 4;

async function autoExitCutoff(): Promise<number> {
  const settings = await findGymSettings();
  const autoExitHours = settings?.autoExitHours ?? DEFAULT_AUTO_EXIT_HOURS;
  return Date.now() - autoExitHours * 60 * 60 * 1000;
}

/**
 * Whether the member currently counts as inside, applying the same
 * autoExitHours expiry as {@link getOccupancy}.
 *
 * Reading through the expiry matters for anti-passback: a member who entered
 * and left without an exit turnstile would otherwise stay "inside" forever and
 * be locked out of their own gym. This function only reads — the stale field is
 * left for getOccupancy to reap, so a gate scan never depends on a write.
 */
export async function isInside(userId: string): Promise<boolean> {
  const enteredAtRaw = await redis.hGet(INSIDE_KEY, userId);
  if (enteredAtRaw === undefined || enteredAtRaw === null) return false;
  const enteredAt = Number(enteredAtRaw);
  if (!Number.isFinite(enteredAt)) return false;
  return enteredAt >= (await autoExitCutoff());
}

// Current gym occupancy: entry records older than autoExitHours (when the exit
// turnstile was skipped or faulty) are treated as expired and removed
export async function getOccupancy(): Promise<number> {
  const entries = await redis.hGetAll(INSIDE_KEY);
  const cutoff = await autoExitCutoff();

  const stale: string[] = [];
  let count = 0;
  for (const [userId, enteredAtRaw] of Object.entries(entries)) {
    const enteredAt = Number(enteredAtRaw);
    if (!Number.isFinite(enteredAt) || enteredAt < cutoff) {
      stale.push(userId);
      continue;
    }
    count += 1;
  }
  if (stale.length > 0) {
    await redis.hDel(INSIDE_KEY, stale);
  }
  return count;
}
