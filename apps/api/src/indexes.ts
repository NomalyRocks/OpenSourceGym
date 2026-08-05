import {
  MongoServerError,
  ObjectId,
  type Db,
  type CreateIndexesOptions,
  type IndexDirection,
} from "mongodb";
import { db } from "./db.js";

// createIndex is idempotent with the same keys and options, but if options CHANGE
// (for example, a TTL update), Mongo throws IndexOptionsConflict (85) or
// IndexKeySpecsConflict (86), which would crash the API at startup. In that case,
// drop the old index and create the new one. dropIndex requires a name; use the
// custom name (options.name) when provided, otherwise Mongo's default naming
// (the "field_direction" combination) can be derived safely.
async function ensureIndex(
  database: Db,
  collection: string,
  keys: Record<string, IndexDirection>,
  options?: CreateIndexesOptions,
): Promise<void> {
  try {
    await database.collection(collection).createIndex(keys, options);
  } catch (err) {
    if (
      err instanceof MongoServerError &&
      (err.code === 85 || err.code === 86)
    ) {
      const indexName =
        options?.name ??
        Object.entries(keys)
          .map(([field, dir]) => `${field}_${String(dir)}`)
          .join("_");
      await database.collection(collection).dropIndex(indexName);
      await database.collection(collection).createIndex(keys, options);
      return;
    }
    throw err;
  }
}

// The repository previously had no Mongo indexes—this is the initial index
// bootstrap. ensureIndex is idempotent and recreates conflicting options, so it
// can safely run at every startup.
export async function ensureIndexes(database: Db = db): Promise<void> {
  // phoneE164 exists only on validated and deduplicated documents. Because old
  // duplicate documents lack the field, the partial index preserves them while
  // atomically preventing new races.
  await ensureIndex(
    database,
    "user",
    { phoneE164: 1 },
    {
      name: "user_phone_e164_unique",
      unique: true,
      partialFilterExpression: { phoneE164: { $type: "string" } },
    },
  );

  // Subscription creation, QR checks, and the admin timeline frequently read
  // the latest end date per user.
  await ensureIndex(
    database,
    "subscriptions",
    { userId: 1, endsAt: -1 },
    { name: "subscriptions_user_ends_at" },
  );

  // weight_history: both recording (reading the latest value) and calendar
  // listing use the find({ userId }).sort({ at: -1 }) pattern.
  await ensureIndex(
    database,
    "weight_history",
    { userId: 1, at: -1 },
    { name: "weight_history_user_at" },
  );

  // sharing_signals: automatically deleted after 30 days (TTL) plus a per-user query index
  await ensureIndex(
    database,
    "sharing_signals",
    { at: 1 },
    { expireAfterSeconds: 30 * 24 * 3600 },
  );
  await ensureIndex(database, "sharing_signals", { userId: 1, at: -1 });
  // session: for enforceSessionPolicy session-count and eviction queries
  await ensureIndex(database, "session", { userId: 1 });

  // For sorting the audit list newest first.
  // _id is part of the sort key: cursor pagination breaks equal timestamps with
  // _id, so the index must contain the same key.
  await ensureIndex(database, "audit_logs", { at: -1, _id: -1 });
  // To anonymize a user's audit records during account deletion.
  await ensureIndex(database, "audit_logs", { actorId: 1 });
  // When action filtering and time sorting are used together.
  await ensureIndex(database, "audit_logs", { action: 1, at: -1, _id: -1 });

  // For sorting the turnstile event list newest first.
  await ensureIndex(database, "entry_events", { at: -1, _id: -1 });
  // To find a user's turnstile events during account deletion; also supports
  // the paginated list query with a member filter.
  await ensureIndex(database, "entry_events", {
    userId: 1,
    at: -1,
    _id: -1,
  });
  // When device filtering and time sorting are used together.
  await ensureIndex(database, "entry_events", {
    deviceId: 1,
    at: -1,
    _id: -1,
  });

  // For sorting the deletion-request list newest first.
  await ensureIndex(database, "deletion_requests", {
    requestedAt: -1,
    _id: -1,
  });
  // When status filtering and time sorting are used together.
  await ensureIndex(database, "deletion_requests", {
    status: 1,
    requestedAt: -1,
    _id: -1,
  });
  // To find a user's latest deletion request.
  await ensureIndex(database, "deletion_requests", {
    userId: 1,
    requestedAt: -1,
  });

  // A member cannot have multiple PENDING deletion requests at once. The route's
  // read-then-write check is not atomic; this partial unique index enforces
  // uniqueness. It must be partial because resolved requests accumulate as
  // multiple historical records per user.
  await dedupePendingDeletionRequests(database);
  await ensureIndex(
    database,
    "deletion_requests",
    { userId: 1 },
    {
      name: "deletion_requests_pending_unique",
      unique: true,
      partialFilterExpression: { status: "pending" },
    },
  );

  // For sorting the device list newest first.
  await ensureIndex(database, "devices", { createdAt: -1 });

  // Phase E—reporting: range counts and CSV exports filter and sort by createdAt.
  await ensureIndex(database, "subscriptions", { createdAt: 1 });
  await ensureIndex(database, "user", { role: 1, createdAt: 1 });

  // Phase E—reminder uniqueness. The automatic sweep must not send another
  // email for the same subscription and threshold; this index enforces that,
  // not the read-then-write check. It must be partial because staff-sent
  // reminders (automatic: false) must remain repeatable.
  await ensureIndex(
    database,
    "renewal_reminders",
    { subscriptionId: 1, thresholdDays: 1 },
    {
      name: "renewal_reminders_threshold_unique",
      unique: true,
      partialFilterExpression: { automatic: true },
    },
  );
  // To read a subscription's latest reminder (manual-send cooldown and list column).
  await ensureIndex(database, "renewal_reminders", {
    subscriptionId: 1,
    sentAt: -1,
  });
}

/**
 * Cleans up duplicate pending requests left by races before the unique index
 * existed: keep the user's OLDEST request (the original intent) and delete
 * concurrent duplicates created later. Without this step, createIndex would
 * fail startup with E11000.
 */
async function dedupePendingDeletionRequests(database: Db): Promise<void> {
  const duplicates = await database
    .collection("deletion_requests")
    .aggregate<{ _id: ObjectId; ids: ObjectId[] }>([
      { $match: { status: "pending" } },
      // Sorting must precede $group: this guarantees that the first element in
      // the ids array is the oldest request.
      { $sort: { requestedAt: 1, _id: 1 } },
      { $group: { _id: "$userId", ids: { $push: "$_id" } } },
      { $match: { $expr: { $gt: [{ $size: "$ids" }, 1] } } },
    ])
    .toArray();

  for (const group of duplicates) {
    // slice(1): ObjectIds cannot be compared with === (reference equality), so
    // separate the record to preserve by position rather than filtering.
    const stale = group.ids.slice(1);
    if (stale.length === 0) continue;
    await database
      .collection("deletion_requests")
      .deleteMany({ _id: { $in: stale } });
    console.warn(
      `duplicate pending deletion requests removed: ${stale.length} records`,
    );
  }
}
