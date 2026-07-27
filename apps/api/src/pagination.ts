import { ObjectId } from "mongodb";
import type { Collection, Document, WithId } from "mongodb";
import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Tüm sayfalanan liste uçlarının ortak sorgu parametreleri. */
export const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
});

export interface PageCursor {
  at: Date;
  id: ObjectId;
}

/** Geçersiz/bozuk imleç. Route katmanı bunu 400'e çevirir. */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

// İmleç istemciye opak görünmeli: içeriği sözleşme değildir, sunucu sıralama
// anahtarını değiştirdiğinde biçimi de değişebilir.
export function encodeCursor(at: Date, id: ObjectId): string {
  return Buffer.from(`${at.getTime()}:${id.toHexString()}`).toString(
    "base64url",
  );
}

export function decodeCursor(raw: string): PageCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  const milliseconds = Number(decoded.slice(0, separator));
  const hex = decoded.slice(separator + 1);
  // ObjectId.isValid 12 karakterlik ham string'i de kabul eder; oradan üretilen
  // kimlik imleçtekinden farklı olur, bu yüzden hex biçimini kendimiz doğrularız.
  if (!Number.isSafeInteger(milliseconds) || !OBJECT_ID_HEX.test(hex)) {
    return null;
  }
  return { at: new Date(milliseconds), id: new ObjectId(hex) };
}

/**
 * Sıralama anahtarına göre imleçten SONRAKİ kayıtları seçen filtre.
 * Sıralama `{ [timeField]: -1, _id: -1 }` olduğundan eşit zaman damgalarında
 * _id ile kırılır; aksi halde aynı milisaniyeye düşen kayıtlar sayfalar
 * arasında tekrarlanır veya atlanırdı.
 */
export function cursorFilter(timeField: string, cursor: PageCursor): Document {
  return {
    $or: [
      { [timeField]: { $lt: cursor.at } },
      { [timeField]: cursor.at, _id: { $lt: cursor.id } },
    ],
  };
}

export interface FindPageParams {
  /** Sıralama ve imleç için kullanılan tarih alanı (ör. "at", "requestedAt"). */
  timeField: string;
  /** Uca özgü ek filtreler; imleç filtresiyle $and ile birleştirilir. */
  filter?: Document;
  cursor?: string | undefined;
  limit: number;
}

export interface PageResult {
  docs: WithId<Document>[];
  nextCursor: string | null;
}

/**
 * Bir koleksiyondan tek sayfa okur ve sonraki sayfanın imlecini üretir.
 * @throws InvalidCursorError imleç çözümlenemezse.
 */
export async function findPage(
  collection: Collection<Document>,
  params: FindPageParams,
): Promise<PageResult> {
  const { timeField, limit } = params;
  const filter = params.filter ?? {};

  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  if (params.cursor && !cursor) {
    throw new InvalidCursorError();
  }

  const query: Document = cursor
    ? { $and: [filter, cursorFilter(timeField, cursor)] }
    : filter;

  // limit + 1 okunur: fazladan kayıt gelirse sonraki sayfa var demektir.
  // Ayrı bir countDocuments çağrısı hem pahalı hem de yarışa açık olurdu.
  const docs = await collection
    .find(query)
    .sort({ [timeField]: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last && last[timeField] instanceof Date
      ? encodeCursor(last[timeField] as Date, last._id)
      : null;

  return { docs: page, nextCursor };
}

/** `from`/`to` sorgu parametrelerini Mongo aralık filtresine çevirir. */
export function dateRangeFilter(
  field: string,
  from?: Date,
  to?: Date,
): Document {
  if (!from && !to) return {};
  const range: Document = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return { [field]: range };
}
