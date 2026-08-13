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
 * Floor for how long an entry record survives at all, independent of
 * `autoExitHours`.
 *
 * `autoExitHours` answers "should this member still be COUNTED inside", which is
 * an occupancy question and is deliberately short. Whether they may open the
 * EXIT turnstile is a different question: a member who has been in the building
 * longer than the occupancy window is still in the building, and deleting their
 * record would leave them unable to scan their way out. So records live far
 * longer than they are counted, and only truly ancient ones are reaped.
 */
const INSIDE_RETENTION_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export interface InsideCutoffs {
  /** Entries at or after this instant are counted in the occupancy figure. */
  count: number;
  /** Entries before this instant are deleted outright. */
  drop: number;
}

/**
 * The two cutoffs an entry record is measured against. Pure so the relationship
 * between them can be tested without Mongo or Redis.
 *
 * `drop` is never later than `count`: `autoExitHours` is operator-supplied and
 * the settings schema accepts up to 48, so a fixed 24-hour retention would reap
 * records the occupancy window still counts. All three consequences are bad, and
 * the last one is the worst — it is exactly the trap the split lifetimes were
 * introduced to avoid:
 *
 * - the member silently drops out of the occupancy figure;
 * - strict anti-passback stops applying to them, because {@link isInside} reads
 *   a record that no longer exists;
 * - {@link hasInsideRecord} refuses the EXIT turnstile to someone who is
 *   genuinely still in the building.
 *
 * Retention is therefore the LONGER of the two windows, which as instants means
 * the EARLIER cutoff.
 */
export function insideCutoffs(
  autoExitHours: number | undefined,
  now: number,
): InsideCutoffs {
  const hours =
    typeof autoExitHours === "number" && Number.isFinite(autoExitHours)
      ? autoExitHours
      : DEFAULT_AUTO_EXIT_HOURS;
  return {
    count: now - hours * HOUR_MS,
    drop: now - Math.max(INSIDE_RETENTION_HOURS, hours) * HOUR_MS,
  };
}

/** Loads the configured `autoExitHours` and applies {@link insideCutoffs}. */
async function loadCutoffs(): Promise<InsideCutoffs> {
  const settings = await findGymSettings();
  return insideCutoffs(settings?.autoExitHours, Date.now());
}

/**
 * Whether the member currently counts as inside, applying the same
 * autoExitHours expiry as {@link getOccupancy}.
 *
 * Reading through the expiry matters for anti-passback: a member who entered
 * and left without an exit turnstile would otherwise stay "inside" forever and
 * be locked out of their own gym. This function only reads — reaping is left to
 * {@link reapExpiredInsideRecords}, so a gate scan never depends on a write.
 */
export async function isInside(userId: string): Promise<boolean> {
  const enteredAt = await readEnteredAt(userId);
  if (enteredAt === null) return false;
  return enteredAt >= (await loadCutoffs()).count;
}

/**
 * Whether an entry record exists at all, within the retention window.
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
  if (enteredAt === null) return false;
  return enteredAt >= (await loadCutoffs()).drop;
}

async function readEnteredAt(userId: string): Promise<number | null> {
  const raw = await redis.hGet(INSIDE_KEY, userId);
  if (raw === undefined || raw === null) return null;
  const enteredAt = Number(raw);
  return Number.isFinite(enteredAt) ? enteredAt : null;
}

/**
 * Whether a stored entry instant is past retention and may be deleted.
 *
 * The single definition both sweepers apply — {@link reapExpiredInsideRecords}
 * and the pass {@link getOccupancy} still makes while it has the hash in hand.
 * A non-finite value is expired by definition: {@link readEnteredAt} already
 * refuses to interpret it, so it can never satisfy any reader again.
 */
function isExpiredEntry(enteredAt: number, dropCutoff: number): boolean {
  return !Number.isFinite(enteredAt) || enteredAt < dropCutoff;
}

/**
 * Deletes entry records past the retention window and reports how many went.
 *
 * Reaping is a housekeeping job rather than a side effect of reading the
 * occupancy figure: `og:inside` is a single Redis hash with no per-field TTL, so
 * when it was only pruned inside {@link getOccupancy} an installation whose
 * panel is never opened grew the hash without bound. Correctness never depended
 * on it — every reader applies the cutoffs itself — but memory did.
 */
export async function reapExpiredInsideRecords(): Promise<number> {
  const entries = await redis.hGetAll(INSIDE_KEY);
  const { drop } = await loadCutoffs();
  const expired = Object.entries(entries)
    .filter(([, raw]) => isExpiredEntry(Number(raw), drop))
    .map(([userId]) => userId);
  if (expired.length === 0) return 0;
  await redis.hDel(INSIDE_KEY, expired);
  return expired.length;
}

/** How often {@link startOccupancyReaper} sweeps the hash. */
const REAP_INTERVAL_MS = 60 * 60 * 1000;

export interface OccupancyReaper {
  /** Stops the sweep and waits for an in-flight run. */
  stop(): Promise<void>;
  /** For tests and manual triggers: runs one sweep now. */
  runOnce(): Promise<number>;
}

/**
 * Starts the hourly reap of expired entry records.
 *
 * No lock: {@link reapExpiredInsideRecords} only issues an idempotent HDEL of
 * fields it has already decided are expired, so two instances sweeping at once
 * cost a duplicate command and nothing else. The timer is `unref`ed — a pending
 * tick must not delay shutdown after SIGTERM.
 */
export function startOccupancyReaper(): OccupancyReaper {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function runOnce(): Promise<number> {
    const removed = await reapExpiredInsideRecords();
    if (removed > 0) {
      console.info(`[occupancy] reaped ${removed} expired entry records`);
    }
    return removed;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = runOnce().catch((err: unknown) => {
      console.error("occupancy reap failed:", err);
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

// Current gym occupancy: entries older than autoExitHours (when the exit
// turnstile was skipped or faulty) stop being counted. They are NOT deleted at
// that point — see INSIDE_RETENTION_HOURS; a member who is still in the building
// must keep being able to scan out.
export async function getOccupancy(): Promise<number> {
  const entries = await redis.hGetAll(INSIDE_KEY);
  const { count: countCutoff, drop: dropCutoff } = await loadCutoffs();

  const expired: string[] = [];
  let count = 0;
  for (const [userId, enteredAtRaw] of Object.entries(entries)) {
    const enteredAt = Number(enteredAtRaw);
    if (isExpiredEntry(enteredAt, dropCutoff)) {
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
