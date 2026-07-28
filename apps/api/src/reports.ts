import type {
  EntryTrend,
  EntryTrendPoint,
  ReportSummary,
} from "@opengym/shared";
import type { Db, Document } from "mongodb";
import { db } from "./db.js";
import { env } from "./env.js";

/** Rapor aralığının azami uzunluğu — grafikte kova sayısını sınırlar. */
export const MAX_REPORT_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWAL_WINDOW_DAYS = 7;

/**
 * Bir anın verilen saat dilimindeki takvim gününü `YYYY-MM-DD` olarak verir.
 * `en-CA` tam olarak bu biçimi üretir; elle parça birleştirmeye gerek yok.
 */
export function localDayLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Aralığın kapsadığı yerel günlerin etiketlerini sırayla üretir.
 *
 * Adımlama etiketin kendisi üzerinde yapılır, zaman damgası üzerinde değil:
 * "24 saat ekle" yaz saati geçişlerinde bir günü atlar veya tekrarlar. Takvim
 * günü üzerinden ilerlemek saat dilimi kurallarından bağımsızdır.
 */
export function dayLabels(from: Date, to: Date, timeZone: string): string[] {
  const labels: string[] = [];
  const last = localDayLabel(to, timeZone);
  let current = localDayLabel(from, timeZone);

  // Bozuk bir aralık sonsuz döngüye dönüşmemeli; üst sınır kova tavanıdır.
  for (let guard = 0; guard <= MAX_REPORT_RANGE_DAYS; guard++) {
    labels.push(current);
    if (current >= last) break;
    current = nextDayLabel(current);
  }
  return labels;
}

function nextDayLabel(label: string): string {
  const [year, month, day] = label.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

async function countFrom(
  database: Db,
  collection: string,
  pipeline: Document[],
): Promise<number> {
  const [result] = await database
    .collection(collection)
    .aggregate<{ n: number }>([...pipeline, { $count: "n" }])
    .toArray();
  return result?.n ?? 0;
}

/**
 * Üyenin EN GEÇ aboneliğinin bitişine bakar. `distinct` ile "herhangi bir aktif
 * abonelik" saymak yanıltıcı olurdu: peşine yeni paket eklenmiş bir üye hâlâ
 * "yenilemesi yaklaşıyor" görünürdü.
 */
function latestEndPipeline(match: Document): Document[] {
  return [
    { $group: { _id: "$userId", latestEnd: { $max: "$endsAt" } } },
    { $match: { latestEnd: match } },
  ];
}

/** Aboneliği önümüzdeki 7 gün içinde bitecek benzersiz üye sayısı. */
export async function countRenewalsDue(
  database: Db = db,
  now = new Date(),
): Promise<number> {
  return countFrom(
    database,
    "subscriptions",
    latestEndPipeline({
      $gte: now,
      $lte: new Date(now.getTime() + RENEWAL_WINDOW_DAYS * DAY_MS),
    }),
  );
}

/** Şu an aktif aboneliği olan benzersiz üye sayısı. */
export async function countActiveMembers(
  database: Db = db,
  now = new Date(),
): Promise<number> {
  return countFrom(database, "subscriptions", [
    { $match: { startsAt: { $lte: now }, endsAt: { $gte: now } } },
    { $group: { _id: "$userId" } },
  ]);
}

export interface ReportRangeInput {
  from: Date;
  to: Date;
}

export async function buildReportSummary(
  { from, to }: ReportRangeInput,
  database: Db = db,
  now = new Date(),
): Promise<ReportSummary> {
  const [
    activeMembers,
    renewalsDue,
    newMembers,
    newSubscriptions,
    lapsedMembers,
    entries,
  ] = await Promise.all([
    countActiveMembers(database, now),
    countRenewalsDue(database, now),
    database
      .collection("user")
      .countDocuments({ role: "member", createdAt: { $gte: from, $lte: to } }),
    database
      .collection("subscriptions")
      .countDocuments({ createdAt: { $gte: from, $lte: to } }),
    // Aralıkta biten VE aralık sonuna kadar yenilenmeyen üyeler: en geç bitiş
    // aralığın içinde kalıyorsa üye aralık sonunda aboneliksizdir.
    countFrom(
      database,
      "subscriptions",
      latestEndPipeline({ $gte: from, $lte: to }),
    ),
    aggregateEntryTotals(database, from, to),
  ]);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    timeZone: env.reportsTimeZone,
    activeMembers,
    newMembers,
    newSubscriptions,
    lapsedMembers,
    renewalsDue,
    entries,
  };
}

interface EntryTotals {
  total: number;
  allowed: number;
  denied: number;
  uniqueMembers: number;
}

/**
 * Toplamlar ve benzersiz üye sayısı tek geçişte alınır. Benzersiz üyeler
 * `$addToSet` ile toplanmaz: dizi belge boyutu sınırına dayanabilir, ayrı bir
 * `$group` + `$count` dalı sabit bellek kullanır.
 */
async function aggregateEntryTotals(
  database: Db,
  from: Date,
  to: Date,
): Promise<EntryTotals> {
  const [result] = await database
    .collection("entry_events")
    .aggregate<{
      totals: { total: number; allowed: number }[];
      members: { n: number }[];
    }>([
      { $match: { at: { $gte: from, $lte: to } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                allowed: {
                  $sum: { $cond: [{ $eq: ["$allowed", true] }, 1, 0] },
                },
              },
            },
          ],
          members: [
            { $match: { userId: { $ne: null } } },
            { $group: { _id: "$userId" } },
            { $count: "n" },
          ],
        },
      },
    ])
    .toArray();

  const total = result?.totals[0]?.total ?? 0;
  const allowed = result?.totals[0]?.allowed ?? 0;
  return {
    total,
    allowed,
    denied: total - allowed,
    uniqueMembers: result?.members[0]?.n ?? 0,
  };
}

export async function buildEntryTrend(
  { from, to }: ReportRangeInput,
  database: Db = db,
): Promise<EntryTrend> {
  const timeZone = env.reportsTimeZone;
  const rows = await database
    .collection("entry_events")
    .aggregate<{ _id: string; total: number; allowed: number }>([
      { $match: { at: { $gte: from, $lte: to } } },
      {
        $group: {
          // Kova sınırı salonun yerel günüdür: UTC'ye göre gruplayınca gece
          // yarısına yakın geçişler komşu güne kayardı.
          _id: {
            $dateToString: {
              date: "$at",
              format: "%Y-%m-%d",
              timezone: timeZone,
            },
          },
          total: { $sum: 1 },
          allowed: { $sum: { $cond: [{ $eq: ["$allowed", true] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  const byDay = new Map(rows.map((row) => [row._id, row]));
  // Boş günler de noktaya dönüşür: eksik kovalar grafikte "o gün hiç kimse
  // gelmedi"yi değil "veri yok"u gösterir ve trendi yanlış okutur.
  const points: EntryTrendPoint[] = dayLabels(from, to, timeZone).map(
    (date) => {
      const row = byDay.get(date);
      const total = row?.total ?? 0;
      const allowed = row?.allowed ?? 0;
      return { date, total, allowed, denied: total - allowed };
    },
  );

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    timeZone,
    points,
  };
}
