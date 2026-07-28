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
 * Aynı aboneliğe iki hatırlatma arasında geçmesi gereken en kısa süre.
 * Hem elle gönderim hem otomatik süpürme buna uyar: personel az önce aradıysa
 * üyeye aynı gün ikinci bir posta gitmemeli.
 */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const MAX_RENEWAL_WINDOW_DAYS = 90;

interface RenewalReminderFields {
  userId: ObjectId;
  subscriptionId: ObjectId;
  /** Kaç gün kala gönderildi; elle gönderimde null. */
  thresholdDays: number | null;
  /**
   * Otomatik süpürmenin ürettiği kayıtlar tekilleştirilir; elle gönderimler
   * (personel aksiyonu) tekrarlanabilir olduğu için indeksin dışında kalır.
   */
  automatic: boolean;
  sentAt: Date;
  /** Elle gönderen personelin e-postası; otomatikte null. */
  sentBy: string | null;
}

export type RenewalReminderDocument = WithId<RenewalReminderFields>;

export function renewalReminderCollection(
  database: Db = db,
): Collection<RenewalReminderFields> {
  return database.collection<RenewalReminderFields>("renewal_reminders");
}

/**
 * Bitişe kalan TAKVİM günü sayısı (bugün bitiyorsa 0), salonun saat dilimine
 * göre.
 *
 * Ham 24 saatlik fark kullanılamaz: 28 Temmuz 09:00'da 29 Temmuz 08:00'de
 * bitecek bir abonelik 23 saat uzaktadır ve tabana yuvarlanınca 0 çıkar —
 * üyeye "bugün sona eriyor" yazan bir posta giderdi, oysa yarın bitiyor.
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
 * Üyenin EN GEÇ aboneliğini bulan ortak boru hattı.
 *
 * `$max` yerine sıralayıp `$first` alıyoruz: yalnızca bitiş tarihi değil o
 * aboneliğin kimliği de gerekli — hatırlatma tekilliği abonelik kimliğine
 * bağlı, en geç bitişli belge ise `$max: "$_id"` ile bulunamaz.
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
 * Aboneliği `withinDays` gün içinde bitecek üyeleri en yakın bitiş önce
 * sıralayarak sayfalar.
 * @throws InvalidCursorError imleç çözümlenemezse.
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
    // limit + 1: fazladan satır gelirse sonraki sayfa var demektir.
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

/** Bir üyenin en geç aboneliğini hatırlatma için okur. */
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
}

/**
 * Hatırlatma e-postasının gövdesi. Üyeye doğrudan gider ve çeviri yapabilecek
 * bir istemci yoktur; bu yüzden metin Türkçedir (API hata mesajlarının aksine).
 */
export function buildReminderMail(input: ReminderMailInput): {
  subject: string;
  text: string;
} {
  const endsAtLabel = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "long",
    timeZone: "Europe/Istanbul",
  }).format(input.endsAt);
  const greeting = input.firstName ? `Merhaba ${input.firstName},` : "Merhaba,";
  const when =
    input.remainingDays === 0
      ? "bugün sona eriyor"
      : `${input.remainingDays} gün sonra sona eriyor`;
  // Konu satırındaki kalıp gövdede tekrarlanmaz: "31 Temmuz tarihinde 2 gün
  // sonra sona eriyor" bozuk bir cümle olurdu.
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
 * Hatırlatmayı önce kaydeder, sonra postayı gönderir.
 *
 * Sıralama bilinçli: kayıt unique indekse çarparsa aynı eşik için ikinci bir
 * posta hiç gönderilmez. Posta gönderimi başarısız olursa kayıt geri alınır ki
 * bir sonraki süpürme yeniden denesin — aksi halde tek bir SMTP kesintisi
 * üyeyi hatırlatmasız bırakırdı.
 *
 * @returns Gönderildiyse kaydın zamanı; bu eşik için zaten gönderilmişse null.
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
      // Temizlik başarısız olursa en kötü ihtimalle bu eşik atlanır; asıl
      // gönderim hatasını gölgelememesi için yalnızca loglanır.
      console.error("hatırlatma kaydı geri alınamadı:", cleanupError);
    });
    throw err;
  }

  return input.sentAt;
}

/** Bu abonelik için en son gönderilen hatırlatmanın zamanı. */
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

/** Bir hatırlatma denemesinin sonucu. */
export type ReminderOutcome =
  | { status: "sent"; sentAt: Date }
  /** Son 24 saatte zaten hatırlatılmış. */
  | { status: "cooled-down"; lastSentAt: Date }
  /** Bu abonelik + eşik için otomatik posta zaten gönderilmiş. */
  | { status: "already-sent" }
  /** Aynı abonelik için başka bir gönderim tam şu an sürüyor. */
  | { status: "busy" };

export interface SendReminderInput {
  userId: ObjectId;
  subscriptionId: ObjectId;
  endsAt: Date;
  email: string;
  firstName: string;
  gymName: string;
  /** Otomatik süpürmede eşik günü; elle gönderimde null. */
  thresholdDays: number | null;
  automatic: boolean;
  sentBy: string | null;
  now: Date;
}

const SEND_LOCK_LEASE_MS = 30_000;

/**
 * Bir aboneliğe hatırlatma göndermenin TEK giriş noktası.
 *
 * Bekleme süresi kontrolü ile kaydın yazılması arasındaki boşluk abonelik
 * başına bir Redis kilidiyle kapatılır. Kilit olmadan iki personelin aynı anda
 * bastığı düğme (veya elle gönderimle çakışan süpürme turu) kontrolü birlikte
 * geçer ve üyeye iki posta giderdi; elle gönderilen kayıtlar kısmi unique
 * indeksin dışında olduğu için veritabanı bunu kendiliğinden engellemez.
 */
export async function sendRenewalReminder(
  input: SendReminderInput,
  database: Db = db,
): Promise<ReminderOutcome> {
  const key = `og:lock:reminder:${input.subscriptionId.toHexString()}`;
  const token = randomUUID();
  // Beklemeden vazgeçilir: kilit birindeyse o gönderim zaten bu aboneliği
  // ele almış demektir, sıraya girmenin faydası yok.
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
      // Kilit lease ile kendiliğinden düşer; temizlik hatası asıl sonucu
      // gölgelememeli.
      console.error("hatırlatma kilidi bırakılamadı:", err);
    });
  }
}
