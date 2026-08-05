import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import type { Collection, Document } from "mongodb";
import {
  dateRangeFilter,
  findPage,
  InvalidCursorError,
  type PageDirection,
} from "../pagination.js";

const mongoUri = process.env.TEST_MONGODB_URI;

const BASE = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * Records sharing a timestamp are intentional: equal timestamps are the main
 * failure point for keyset pagination. Without an _id tie-breaker, records in
 * the same millisecond are duplicated or skipped between pages, a bug visible
 * only under real sorting rather than in unit tests.
 */
const FIXTURES = [
  { offset: 0, kind: "a" },
  { offset: 0, kind: "b" },
  { offset: 0, kind: "a" },
  { offset: 0, kind: "b" },
  { offset: 60_000, kind: "a" },
  { offset: 60_000, kind: "a" },
  { offset: 60_000, kind: "b" },
  { offset: 120_000, kind: "b" },
  { offset: 120_000, kind: "a" },
  { offset: 120_000, kind: "b" },
].map((row) => ({
  _id: new ObjectId(),
  at: new Date(BASE + row.offset),
  kind: row.kind,
}));

type Fixture = (typeof FIXTURES)[number];

/** Expected order is calculated independently: lexicographic (at, _id) order. */
function expectedOrder(
  direction: PageDirection,
  rows: Fixture[] = FIXTURES,
): string[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows]
    .sort((left, right) => {
      const byTime = left.at.getTime() - right.at.getTime();
      if (byTime !== 0) return sign * byTime;
      return sign * (left._id.toHexString() < right._id.toHexString() ? -1 : 1);
    })
    .map((row) => row._id.toHexString());
}

interface DrainResult {
  ids: string[];
  pages: number;
}

/** Follows the cursor to the end with a hard cap against infinite loops. */
async function drain(
  collection: Collection<Document>,
  options: { limit: number; direction?: PageDirection; filter?: Document },
): Promise<DrainResult> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const page = await findPage(collection, {
      timeField: "at",
      limit: options.limit,
      ...(options.direction ? { direction: options.direction } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
      cursor,
    });
    pages += 1;
    ids.push(...page.docs.map((doc) => doc._id.toHexString()));

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    // Each page must advance at least one record; otherwise the cursor filter is broken.
    assert.ok(pages <= FIXTURES.length + 2, "pagination did not terminate");
  }

  return { ids, pages };
}

test(
  "keyset pagination neither duplicates nor skips records with equal timestamps",
  { skip: mongoUri ? false : "TEST_MONGODB_URI is not defined" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_pagination_${randomUUID().replaceAll("-", "")}`,
    );
    const events = database.collection("events");

    try {
      await client.connect();
      // Insertion order intentionally differs from sort order: the result must
      // depend only on the sort key, not natural collection order.
      await events.insertMany([...FIXTURES].reverse());

      for (const direction of ["desc", "asc"] as const) {
        const expected = expectedOrder(direction);

        for (const limit of [1, 3, 4, FIXTURES.length]) {
          const { ids } = await drain(events, { limit, direction });
          assert.deepEqual(
            ids,
            expected,
            `${direction}/limit=${limit} order is incorrect`,
          );
          assert.equal(
            new Set(ids).size,
            ids.length,
            `${direction}/limit=${limit} duplicated a record`,
          );
        }
      }

      // A result fitting on one page must not produce a next cursor.
      const single = await drain(events, { limit: FIXTURES.length });
      assert.equal(single.pages, 1);

      // If the total is an exact multiple of the limit, no trailing empty page
      // should be read; fetching limit + 1 distinguishes this without a count.
      const exact = await drain(events, { limit: FIXTURES.length / 2 });
      assert.equal(exact.pages, 2);

      // The endpoint-specific filter must remain when combined with the cursor filter.
      const filtered = await drain(events, {
        limit: 2,
        filter: { kind: "a" },
      });
      assert.deepEqual(
        filtered.ids,
        expectedOrder(
          "desc",
          FIXTURES.filter((row) => row.kind === "a"),
        ),
      );

      // The date range filter must combine in the same way.
      const ranged = await drain(events, {
        limit: 2,
        filter: dateRangeFilter("at", new Date(BASE + 60_000)),
      });
      assert.deepEqual(
        ranged.ids,
        expectedOrder(
          "desc",
          FIXTURES.filter((row) => row.at.getTime() >= BASE + 60_000),
        ),
      );
    } finally {
      await database.dropDatabase();
      await client.close();
    }
  },
);

test(
  "a malformed cursor is rejected without running a query",
  { skip: mongoUri ? false : "TEST_MONGODB_URI is not defined" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_pagination_cursor_${randomUUID().replaceAll("-", "")}`,
    );
    const events = database.collection("events");

    try {
      await client.connect();
      await events.insertMany(FIXTURES.slice(0, 3));

      const invalid = [
        "no-separator",
        // The timestamp is not numeric.
        Buffer.from("abc:507f1f77bcf86cd799439011").toString("base64url"),
        // A raw 12-character form accepted by ObjectId.isValid; the resulting
        // id differs from the one referenced by the cursor.
        Buffer.from(`${BASE}:aaaaaaaaaaaa`).toString("base64url"),
        // Hexadecimal, but too short.
        Buffer.from(`${BASE}:507f1f77bcf86cd7994390`).toString("base64url"),
      ];

      for (const cursor of invalid) {
        await assert.rejects(
          () => findPage(events, { timeField: "at", limit: 5, cursor }),
          InvalidCursorError,
          `cursor was not rejected: ${cursor}`,
        );
      }
    } finally {
      await database.dropDatabase();
      await client.close();
    }
  },
);
