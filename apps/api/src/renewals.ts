import { randomUUID } from "node:crypto";
import type { RenewalDueMember } from "@opengym/shared";
import { ObjectId } from "mongodb";
import type { Collection, Db, Document, WithId } from "mongodb";
import { db, isDuplicateKeyError } from "./db.js";
import { env } from "./env.js";
import { sendMail } from "./mailer.js";
import { acquireLock, releaseLock } from "./redis.js";
import { localDayLabel } from "./reports.js";
import {
  cursorFilter,
  decodeCursor,
  InvalidCursorError,
  sortSpec,
  toPage,
} from "./pagination.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum interval between two reminders for the same subscription. Manual
 * sends and automatic sweeps both honor it: if staff just called, the member
 * must not receive a second email that day.
 */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const MAX_RENEWAL_WINDOW_DAYS = 90;

interface RenewalReminderFields {
  userId: ObjectId;
  subscriptionId: ObjectId;
  /** Days remaining when sent; null for manual sends. */
  thresholdDays: number | null;
  /**
   * Records produced by the automatic sweep are unique; manual sends (a staff
   * action) are excluded from the index because they must be repeatable.
   */
  automatic: boolean;
  sentAt: Date;
  /** Email of the staff member who sent it manually; null when automatic. */
  sentBy: string | null;
}

export type RenewalReminderDocument = WithId<RenewalReminderFields>;

export function renewalReminderCollection(
  database: Db = db,
): Collection<RenewalReminderFields> {
  return database.collection<RenewalReminderFields>("renewal_reminders");
}

/**
 * Number of CALENDAR days until expiration (0 when ending today), in the gym's
 * time zone.
 *
 * A raw 24-hour difference cannot be used: at 09:00 on July 28, a subscription
 * ending at 08:00 on July 29 is 23 hours away and floors to 0—an email would say
 * it ends today even though it ends tomorrow.
 */
export function remainingDays(
  endsAt: Date,
  now: Date,
  timeZone = env.reportsTimeZone,
): number {
  const today = Date.parse(`${localDayLabel(now, timeZone)}T00:00:00Z`);
  const end = Date.parse(`${localDayLabel(endsAt, timeZone)}T00:00:00Z`);
  return Math.max(0, Math.round((end - today) / DAY_MS));
}

/**
 * Shared pipeline that finds the member's LATEST subscription.
 *
 * Sort and take `$first` rather than `$max`: both the end date and subscription
 * identity are needed—reminder uniqueness depends on the subscription ID, and
 * `$max: "$_id"` cannot identify the document with the latest end date.
 */
function latestSubscriptionStages(): Document[] {
  return [
    { $sort: { userId: 1, endsAt: -1, _id: -1 } },
    {
      $group: {
        _id: "$userId",
        endsAt: { $first: "$endsAt" },
        subscriptionId: { $first: "$_id" },
      },
    },
  ];
}

interface RenewalAggregateRow {
  _id: ObjectId;
  endsAt: Date;
  subscriptionId: ObjectId;
  user?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  } | null;
  lastReminderAt?: Date | null;
}

export interface ListRenewalsParams {
  withinDays: number;
  cursor?: string | undefined;
  limit: number;
  now?: Date;
}

export interface RenewalsPage {
  items: RenewalDueMember[];
  nextCursor: string | null;
}

/**
 * Pages members whose subscriptions end within `withinDays`, nearest end first.
 * @throws InvalidCursorError when the cursor cannot be decoded.
 */
export async function listRenewalsDue(
  params: ListRenewalsParams,
  database: Db = db,
): Promise<RenewalsPage> {
  const now = params.now ?? new Date();
  const horizon = new Date(now.getTime() + params.withinDays * DAY_MS);

  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  if (params.cursor && !cursor) throw new InvalidCursorError();

  const match: Document = { endsAt: { $gte: now, $lte: horizon } };
  const stages: Document[] = [
    ...latestSubscriptionStages(),
    {
      $match: cursor
        ? { $and: [match, cursorFilter("endsAt", cursor, "asc")] }
        : match,
    },
    { $sort: sortSpec("endsAt", "asc") },
    // limit + 1: an extra row means another page exists.
    { $limit: params.limit + 1 },
    {
      $lookup: {
        from: "user",
        localField: "_id",
        foreignField: "_id",
        as: "userDocs",
      },
    },
    {
      $lookup: {
        from: "renewal_reminders",
        let: { subscriptionId: "$subscriptionId" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$subscriptionId", "$$subscriptionId"] },
            },
          },
          { $sort: { sentAt: -1 } },
          { $limit: 1 },
        ],
        as: "reminderDocs",
      },
    },
    {
      $project: {
        endsAt: 1,
        subscriptionId: 1,
        user: { $first: "$userDocs" },
        lastReminderAt: { $first: "$reminderDocs.sentAt" },
      },
    },
  ];

  const rows = await database
    .collection("subscriptions")
    .aggregate<RenewalAggregateRow>(stages)
    .toArray();

  const page = toPage(rows, "endsAt", params.limit);

  return {
    items: (page.docs as unknown as RenewalAggregateRow[]).map((row) => ({
      userId: row._id.toHexString(),
      firstName: row.user?.firstName ?? "",
      lastName: row.user?.lastName ?? "",
      email: row.user?.email ?? "",
      phone: row.user?.phone ?? "",
      endsAt: row.endsAt.toISOString(),
      remainingDays: remainingDays(row.endsAt, now),
      lastReminderAt: row.lastReminderAt?.toISOString() ?? null,
    })),
    nextCursor: page.nextCursor,
  };
}

export interface RenewalTarget {
  userId: ObjectId;
  subscriptionId: ObjectId;
  endsAt: Date;
  email: string;
  firstName: string;
}

/** Reads a member's latest subscription for a reminder. */
export async function findRenewalTarget(
  userId: ObjectId,
  database: Db = db,
): Promise<RenewalTarget | null> {
  const [row] = await database
    .collection("subscriptions")
    .aggregate<RenewalAggregateRow>([
      { $match: { userId } },
      ...latestSubscriptionStages(),
      {
        $lookup: {
          from: "user",
          localField: "_id",
          foreignField: "_id",
          as: "userDocs",
        },
      },
      {
        $project: {
          endsAt: 1,
          subscriptionId: 1,
          user: { $first: "$userDocs" },
        },
      },
    ])
    .toArray();

  if (!row?.user?.email) return null;
  return {
    userId: row._id,
    subscriptionId: row.subscriptionId,
    endsAt: row.endsAt,
    email: row.user.email,
    firstName: row.user.firstName ?? "",
  };
}

export interface ReminderMailInput {
  gymName: string;
  firstName: string;
  endsAt: Date;
  remainingDays: number;
  /** Time zone used for the date label; defaults to the gym's zone. */
  timeZone?: string;
}

/**
 * Reminder email body. It goes directly to the member with no client available
 * to translate it, so the localized Turkish content is retained intentionally.
 *
 * The date label must use the SAME time zone as `remainingDays`. If the zone is
 * fixed, an operator running the gym in another region could show "2 days left"
 * beside a date one day apart, making the email contradict itself.
 */
export function buildReminderMail(input: ReminderMailInput): {
  subject: string;
  text: string;
} {
  const endsAtLabel = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "long",
    timeZone: input.timeZone ?? env.reportsTimeZone,
  }).format(input.endsAt);
  const greeting = input.firstName ? `Merhaba ${input.firstName},` : "Merhaba,";
  const when =
    input.remainingDays === 0
      ? "bugün sona eriyor"
      : `${input.remainingDays} gün sonra sona eriyor`;
  // Do not repeat the subject pattern in the body: combining an explicit date
  // with "ends in 2 days" in the same clause would be ungrammatical.
  const sentence =
    input.remainingDays === 0
      ? `${input.gymName} üyeliğiniz bugün (${endsAtLabel}) sona eriyor.`
      : `${input.gymName} üyeliğiniz ${endsAtLabel} tarihinde sona eriyor — ${input.remainingDays} gün kaldı.`;

  return {
    subject: `${input.gymName} üyeliğiniz ${when}`,
    text: [
      greeting,
      "",
      sentence,
      "Yenilemek için salon resepsiyonuna uğrayabilirsiniz.",
      "",
      "İyi antrenmanlar!",
    ].join("\n"),
  };
}

export interface RecordReminderInput {
  userId: ObjectId;
  subscriptionId: ObjectId;
  thresholdDays: number | null;
  automatic: boolean;
  sentBy: string | null;
  sentAt: Date;
}

/**
 * Records the reminder before sending the email.
 *
 * The order is intentional: if the record hits the unique index, no second email
 * is sent for the same threshold. If sending fails, roll back the record so the
 * next sweep retries—otherwise one SMTP outage would leave the member without a
 * reminder.
 *
 * @returns Record time when sent, or null if already sent for this threshold.
 */
export async function recordAndSendReminder(
  input: RecordReminderInput,
  mail: { to: string; subject: string; text: string },
  database: Db = db,
): Promise<Date | null> {
  const collection = renewalReminderCollection(database);
  let insertedId: ObjectId;
  try {
    const result = await collection.insertOne({
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      thresholdDays: input.thresholdDays,
      automatic: input.automatic,
      sentAt: input.sentAt,
      sentBy: input.sentBy,
    });
    insertedId = result.insertedId;
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }

  try {
    await sendMail(mail);
  } catch (err) {
    await collection.deleteOne({ _id: insertedId }).catch((cleanupError) => {
      // If cleanup fails, this threshold is skipped in the worst case; only log
      // it so it does not obscure the underlying send error.
      console.error("reminder record could not be rolled back:", cleanupError);
    });
    throw err;
  }

  return input.sentAt;
}

/** Time of the latest reminder sent for this subscription. */
export async function findLastReminderAt(
  subscriptionId: ObjectId,
  database: Db = db,
): Promise<Date | null> {
  const doc = await renewalReminderCollection(database).findOne(
    { subscriptionId },
    { sort: { sentAt: -1 } },
  );
  return doc?.sentAt ?? null;
}

/** Outcome of a reminder attempt. */
export type ReminderOutcome =
  | { status: "sent"; sentAt: Date }
  /** Already reminded within the last 24 hours. */
  | { status: "cooled-down"; lastSentAt: Date }
  /** Automatic email already sent for this subscription and threshold. */
  | { status: "already-sent" }
  /** Another send for the same subscription is currently in progress. */
  | { status: "busy" };

export interface SendReminderInput {
  userId: ObjectId;
  subscriptionId: ObjectId;
  endsAt: Date;
  email: string;
  firstName: string;
  gymName: string;
  /** Threshold day in an automatic sweep; null for a manual send. */
  thresholdDays: number | null;
  automatic: boolean;
  sentBy: string | null;
  now: Date;
}

const SEND_LOCK_LEASE_MS = 30_000;

/**
 * SINGLE entry point for sending a subscription reminder.
 *
 * A per-subscription Redis lock closes the gap between the cooldown check and
 * record creation. Without it, two staff clicks at once (or a sweep overlapping
 * a manual send) could both pass the check and send two emails; because manual
 * records are outside the partial unique index, the database cannot prevent it.
 */
export async function sendRenewalReminder(
  input: SendReminderInput,
  database: Db = db,
): Promise<ReminderOutcome> {
  const key = `og:lock:reminder:${input.subscriptionId.toHexString()}`;
  const token = randomUUID();
  // Give up without waiting: a held lock means that send is already handling
  // this subscription, so queuing provides no benefit.
  if (!(await acquireLock(key, token, SEND_LOCK_LEASE_MS))) {
    return { status: "busy" };
  }

  try {
    const lastSentAt = await findLastReminderAt(input.subscriptionId, database);
    if (
      lastSentAt &&
      input.now.getTime() - lastSentAt.getTime() < REMINDER_COOLDOWN_MS
    ) {
      return { status: "cooled-down", lastSentAt };
    }

    const days = remainingDays(input.endsAt, input.now);
    const mail = buildReminderMail({
      gymName: input.gymName,
      firstName: input.firstName,
      endsAt: input.endsAt,
      remainingDays: days,
    });

    const sentAt = await recordAndSendReminder(
      {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        thresholdDays: input.thresholdDays,
        automatic: input.automatic,
        sentBy: input.sentBy,
        sentAt: input.now,
      },
      { to: input.email, ...mail },
      database,
    );
    return sentAt ? { status: "sent", sentAt } : { status: "already-sent" };
  } finally {
    await releaseLock(key, token).catch((err: unknown) => {
      // The lease releases the lock automatically; a cleanup error must not
      // obscure the underlying result.
      console.error("reminder lock could not be released:", err);
    });
  }
}
