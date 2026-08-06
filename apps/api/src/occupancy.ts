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

/**
 * How long an entry record survives at all, independent of `autoExitHours`.
 *
 * `autoExitHours` answers "should this member still be COUNTED inside", which is
 * an occupancy question and is deliberately short. Whether they may open the
 * EXIT turnstile is a different question: a member who has been in the building
 * longer than the occupancy window is still in the building, and deleting their
 * record would leave them unable to scan their way out. So records live far
 * longer than they are counted, and only truly ancient ones are reaped.
 */
const INSIDE_RETENTION_HOURS = 24;

async function autoExitCutoff(): Promise<number> {
  const settings = await findGymSettings();
  const autoExitHours = settings?.autoExitHours ?? DEFAULT_AUTO_EXIT_HOURS;
  return Date.now() - autoExitHours * 60 * 60 * 1000;
}

function retentionCutoff(): number {
  return Date.now() - INSIDE_RETENTION_HOURS * 60 * 60 * 1000;
}

/**
 * Whether the member currently counts as inside, applying the same
 * autoExitHours expiry as {@link getOccupancy}.
 *
 * Reading through the expiry matters for anti-passback: a member who entered
 * and left without an exit turnstile would otherwise stay "inside" forever and
 * be locked out of their own gym. This function only reads — reaping is left to
 * getOccupancy, so a gate scan never depends on a write.
 */
export async function isInside(userId: string): Promise<boolean> {
  const enteredAt = await readEnteredAt(userId);
  return enteredAt !== null && enteredAt >= (await autoExitCutoff());
}

/**
 * Whether an entry record exists at all, within {@link INSIDE_RETENTION_HOURS}.
 *
 * This is what gates the EXIT turnstile. Without it a member — or anyone holding
 * a photograph of the exit QR — could open the exit gate on demand having never
 * come in, and each of those scans also cleared the inside flag, handing back a
 * free reset of strict anti-passback.
 *
 * Deliberately looser than {@link isInside}: refusing an exit is only safe while
 * we are confident the member is not in the building, and an occupancy window
 * that has merely lapsed is not that evidence.
 */
export async function hasInsideRecord(userId: string): Promise<boolean> {
  const enteredAt = await readEnteredAt(userId);
  return enteredAt !== null && enteredAt >= retentionCutoff();
}

async function readEnteredAt(userId: string): Promise<number | null> {
  const raw = await redis.hGet(INSIDE_KEY, userId);
  if (raw === undefined || raw === null) return null;
  const enteredAt = Number(raw);
  return Number.isFinite(enteredAt) ? enteredAt : null;
}

// Current gym occupancy: entries older than autoExitHours (when the exit
// turnstile was skipped or faulty) stop being counted. They are NOT deleted at
// that point — see INSIDE_RETENTION_HOURS; a member who is still in the building
// must keep being able to scan out.
export async function getOccupancy(): Promise<number> {
  const entries = await redis.hGetAll(INSIDE_KEY);
  const countCutoff = await autoExitCutoff();
  const dropCutoff = retentionCutoff();

  const expired: string[] = [];
  let count = 0;
  for (const [userId, enteredAtRaw] of Object.entries(entries)) {
    const enteredAt = Number(enteredAtRaw);
    if (!Number.isFinite(enteredAt) || enteredAt < dropCutoff) {
      expired.push(userId);
      continue;
    }
    if (enteredAt >= countCutoff) count += 1;
  }
  if (expired.length > 0) {
    await redis.hDel(INSIDE_KEY, expired);
  }
  return count;
}
