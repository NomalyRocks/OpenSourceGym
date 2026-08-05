import type { DeviceDirection, GateRejectCode } from "@opengym/shared";
import { db } from "./db.js";
import { redis } from "./redis.js";

const QUEUE_KEY = "og:entry-events";
const DEAD_LETTER_KEY = "og:entry-events:dead";

export interface EntryEventInput {
  deviceId: string;
  deviceName: string;
  userId: string | null;
  memberName: string | null;
  allowed: boolean;
  reason: GateRejectCode | null;
  at: Date;
  /**
   * Scan direction from the device record at event time. Persisted so deleting
   * the device later does not corrupt the historical scan's entry/exit
   * classification, even though `/api/me/entries` can no longer look it up.
   */
  direction: DeviceDirection;
}

// Pushes a turnstile event to the Redis queue (fire-and-forget)—does not delay the API response
export function enqueueEntryEvent(ev: EntryEventInput): void {
  const serialized = JSON.stringify({ ...ev, at: ev.at.toISOString() });
  redis.lPush(QUEUE_KEY, serialized).catch(console.error);
}

const RETRY_DELAY_MS = 1000;
/** An event moves to the dead-letter list after this many attempts. */
const MAX_WRITE_ATTEMPTS = 5;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EntryEventConsumer {
  /** Stops the loop and closes the consumer's Redis connection. */
  stop(): Promise<void>;
  /** For readiness: whether the loop is running and Redis is connected. */
  isHealthy(): boolean;
}

// Consumes queued turnstile events in the background and writes them to entry_events
export async function startEntryEventConsumer(): Promise<EntryEventConsumer> {
  // These two flags must be defined BEFORE the 'error' listener: if Redis errors
  // during connect(), the listener fires immediately, and flags in the TDZ would
  // make the handler throw ReferenceError and crash the process—the exact event
  // the listener is intended to prevent.
  let stopping = false;
  let running = true;

  const consumer = redis.duplicate();
  // duplicate() does not copy listeners. An EventEmitter socket error without
  // an 'error' listener is thrown by Node and crashes the ENTIRE API
  // process—this occurred during brief Redis outages.
  consumer.on("error", (err) => {
    if (stopping) return; // Expected socket error during shutdown; stay quiet
    console.error("entry event consumer Redis error:", err);
  });
  await consumer.connect();

  const loop = (async () => {
    while (!stopping) {
      // Guard the ENTIRE loop: brPop rejects when the connection drops, and an
      // unhandled promise would crash the entire API process in Node.
      try {
        const result = await consumer.brPop(QUEUE_KEY, 5);
        if (!result) {
          continue;
        }
        const raw = result.element;

        let parsed: EntryEventInput & { at: string };
        try {
          parsed = JSON.parse(raw) as EntryEventInput & { at: string };
        } catch (err) {
          // Do not log raw: the content may contain member identity data (PII)
          console.error("unparseable entry event skipped:", err);
          continue;
        }

        await writeEvent(raw, parsed);
      } catch (err) {
        if (stopping) break;
        console.error("entry event consumer failed; retrying:", err);
        await wait(RETRY_DELAY_MS);
      }
    }
    running = false;
  })();

  // An event that cannot be persisted must not return to the queue head forever:
  // one bad record would stop the entire turnstile event stream.
  async function writeEvent(
    raw: string,
    parsed: EntryEventInput & { at: string },
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      try {
        await db
          .collection("entry_events")
          .insertOne({ ...parsed, at: new Date(parsed.at) });
        return;
      } catch (err) {
        console.error(
          `entry event write failed (attempt ${attempt}/${MAX_WRITE_ATTEMPTS}):`,
          err,
        );
        if (stopping) {
          // Shutting down: return the event to the queue to avoid losing it
          await redis.lPush(QUEUE_KEY, raw).catch(console.error);
          return;
        }
        await wait(RETRY_DELAY_MS);
      }
    }
    console.error("entry event moved to the dead-letter list");
    await redis.lPush(DEAD_LETTER_KEY, raw).catch(console.error);
  }

  return {
    async stop() {
      stopping = true;
      // quit() tries to send a server command; while Redis is unreachable it can
      // hang indefinitely and block shutdown. Wait briefly, then sever the socket
      // with destroy()—shutdown must be most reliable when Redis is unhealthy.
      await Promise.race([consumer.quit().catch(() => {}), wait(2000)]);
      try {
        consumer.destroy();
      } catch {
        // Fine if already closed
      }
      await Promise.race([loop, wait(2000)]);
    },
    isHealthy() {
      return running && !stopping;
    },
  };
}
