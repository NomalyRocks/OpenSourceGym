import { ObjectId } from "mongodb";
import type { Collection, Document, WithId } from "mongodb";
import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Shared query parameters for all paginated list endpoints. */
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

/** Invalid or malformed cursor. The route layer converts this to a 400. */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

// The cursor must appear opaque to clients: its content is not a contract, and
// its format may change when the server changes the sort key.
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
  // ObjectId.isValid also accepts raw 12-character strings; the resulting ID
  // differs from the cursor value, so validate the hex format ourselves.
  if (!Number.isSafeInteger(milliseconds) || !OBJECT_ID_HEX.test(hex)) {
    return null;
  }
  const at = new Date(milliseconds);
  // The safe-integer range is wider than the ±8.64e15 ms Date supports. An
  // Invalid Date reaching Mongo silently matches nothing or the wrong page.
  if (!Number.isFinite(at.getTime())) return null;
  return { at, id: new ObjectId(hex) };
}

/**
 * Pagination direction. Most lists want newest first (`desc`); forward-looking
 * lists such as upcoming renewals want nearest first (`asc`).
 */
export type PageDirection = "asc" | "desc";

/** Sort key: time field plus _id (to break equal timestamps). */
export function sortSpec(
  timeField: string,
  direction: PageDirection = "desc",
): Document {
  const order = direction === "asc" ? 1 : -1;
  return { [timeField]: order, _id: order };
}

/**
 * Filter selecting records AFTER the cursor according to the sort key. Because
 * sorting is `{ [timeField]: direction, _id: direction }`, _id breaks equal
 * timestamps; otherwise records in the same millisecond would repeat or be
 * skipped across pages.
 */
export function cursorFilter(
  timeField: string,
  cursor: PageCursor,
  direction: PageDirection = "desc",
): Document {
  const beyond = direction === "asc" ? "$gt" : "$lt";
  return {
    $or: [
      { [timeField]: { [beyond]: cursor.at } },
      { [timeField]: cursor.at, _id: { [beyond]: cursor.id } },
    ],
  };
}

export interface FindPageParams {
  /** Date field used for sorting and the cursor (for example, "at", "requestedAt"). */
  timeField: string;
  /** Endpoint-specific filters; combined with the cursor filter using $and. */
  filter?: Document;
  cursor?: string | undefined;
  limit: number;
  /** Defaults to "desc" (newest first). */
  direction?: PageDirection;
}

export interface PageResult {
  docs: WithId<Document>[];
  nextCursor: string | null;
}

/**
 * Reads one page from a collection and produces the next page cursor.
 * @throws InvalidCursorError when the cursor cannot be decoded.
 */
export async function findPage(
  collection: Collection<Document>,
  params: FindPageParams,
): Promise<PageResult> {
  const { timeField, limit } = params;
  const direction = params.direction ?? "desc";
  const filter = params.filter ?? {};

  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  if (params.cursor && !cursor) {
    throw new InvalidCursorError();
  }

  const query: Document = cursor
    ? { $and: [filter, cursorFilter(timeField, cursor, direction)] }
    : filter;

  // Read limit + 1: an extra record means another page exists. A separate
  // countDocuments call would be both expensive and race-prone.
  const docs = await collection
    .find(query)
    .sort(sortSpec(timeField, direction))
    .limit(limit + 1)
    .toArray();

  return toPage(docs, timeField, limit);
}

/**
 * Splits an array read with `limit + 1` into a page and produces the next cursor.
 * Endpoints using aggregation cannot use `findPage`, but must share the same
 * cursor contract; this is the common point.
 */
export function toPage(
  docs: WithId<Document>[],
  timeField: string,
  limit: number,
): PageResult {
  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last && last[timeField] instanceof Date
      ? encodeCursor(last[timeField] as Date, last._id)
      : null;

  return { docs: page, nextCursor };
}

/** Converts `from`/`to` query parameters into a Mongo range filter. */
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
