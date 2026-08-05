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

// Current gym occupancy: entry records older than autoExitHours (when the exit
// turnstile was skipped or faulty) are treated as expired and removed
export async function getOccupancy(): Promise<number> {
  const entries = await redis.hGetAll(INSIDE_KEY);
  const settings = await findGymSettings();
  const autoExitHours = settings?.autoExitHours ?? 4;
  const cutoff = Date.now() - autoExitHours * 60 * 60 * 1000;

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
