import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";

import {
  decodeCursor,
  encodeCursor,
  cursorFilter,
  dateRangeFilter,
  pageQuerySchema,
  sortSpec,
  toPage,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "./pagination.js";

test("encodeCursor round-trips through decodeCursor", () => {
  const at = new Date();
  const id = new ObjectId();
  const encoded = encodeCursor(at, id);
  const decoded = decodeCursor(encoded);
  assert.ok(decoded != null);
  assert.equal(decoded.at.getTime(), at.getTime());
  assert.equal(decoded.id.toHexString(), id.toHexString());
});

test("decodeCursor returns null for invalid base64url content", () => {
  assert.equal(decodeCursor("!!!notvalid!!!"), null);
});

test("decodeCursor returns null for a value without ':'", () => {
  const encoded = Buffer.from("no-separator-here", "utf8").toString(
    "base64url",
  );
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor returns null for a non-numeric timestamp", () => {
  const encoded = Buffer.from(
    "invalid:0123456789abcdef01234567",
    "utf8",
  ).toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor returns null for a hex id that is not 24 characters", () => {
  const encoded = Buffer.from("1234567890:123", "utf8").toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor returns null for a hex id shorter than 24 characters", () => {
  const encoded = Buffer.from("1234567890:12", "utf8").toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor returns null for a hex id longer than 24 characters", () => {
  const encoded = Buffer.from(
    "1234567890:123456789012345678901234567890",
    "utf8",
  ).toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor returns null for a short ASCII id accepted by ObjectId.isValid", () => {
  const encoded = Buffer.from("1234567890:abcdefghijkl", "utf8").toString(
    "base64url",
  );
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor decodes a valid cursor", () => {
  const at = new Date(1700000000000);
  const id = new ObjectId("0123456789abcdef01234567");
  const encoded = Buffer.from(
    `${at.getTime()}:${id.toHexString()}`,
    "utf8",
  ).toString("base64url");
  const decoded = decodeCursor(encoded);
  assert.ok(decoded != null);
  assert.equal(decoded.at.getTime(), 1700000000000);
});

test("cursorFilter returns the explicit correct $or structure", () => {
  const at = new Date();
  const id = new ObjectId();
  const cursor = { at, id };
  const filter = cursorFilter("testField", cursor);
  assert.deepEqual(filter, {
    $or: [{ testField: { $lt: at } }, { testField: at, _id: { $lt: id } }],
  });
});

test("cursorFilter uses $gt in ascending order", () => {
  const at = new Date();
  const id = new ObjectId();
  // The renewal list is sorted by nearest expiry first; the record AFTER the
  // cursor is GREATER in ascending order. Keeping $lt would empty page two.
  const filter = cursorFilter("endsAt", { at, id }, "asc");
  assert.deepEqual(filter, {
    $or: [{ endsAt: { $gt: at } }, { endsAt: at, _id: { $gt: id } }],
  });
});

test("sortSpec flips both keys according to direction", () => {
  assert.deepEqual(sortSpec("at"), { at: -1, _id: -1 });
  assert.deepEqual(sortSpec("endsAt", "asc"), { endsAt: 1, _id: 1 });
});

test("toPage does not produce a next cursor when exactly limit records arrive", () => {
  const docs = [
    { _id: new ObjectId(), at: new Date(2) },
    { _id: new ObjectId(), at: new Date(1) },
  ];
  const page = toPage(docs, "at", 2);
  assert.equal(page.docs.length, 2);
  assert.equal(page.nextCursor, null);
});

test("toPage produces a cursor from the last visible record when an extra record arrives", () => {
  const last = { _id: new ObjectId(), at: new Date(2) };
  const docs = [
    { _id: new ObjectId(), at: new Date(3) },
    last,
    // The limit + 1 record only signals that more exist; it is not in the page.
    { _id: new ObjectId(), at: new Date(1) },
  ];
  const page = toPage(docs, "at", 2);
  assert.equal(page.docs.length, 2);
  assert.ok(page.nextCursor);
  const decoded = decodeCursor(page.nextCursor);
  assert.ok(decoded != null);
  assert.equal(decoded.at.getTime(), last.at.getTime());
  assert.equal(decoded.id.toHexString(), last._id.toHexString());
});

test("dateRangeFilter returns {} when both from and to are undefined", () => {
  const filter = dateRangeFilter("testField");
  assert.deepEqual(filter, {});
});

test("dateRangeFilter returns { field: { $gte } } when only from is provided", () => {
  const from = new Date("2023-01-01");
  const filter = dateRangeFilter("testField", from);
  assert.deepEqual(filter, { testField: { $gte: from } });
});

test("dateRangeFilter returns { field: { $lte } } when only to is provided", () => {
  const to = new Date("2024-01-01");
  const filter = dateRangeFilter("testField", undefined, to);
  assert.deepEqual(filter, { testField: { $lte: to } });
});

test("dateRangeFilter returns the correct range when both from and to are provided", () => {
  const from = new Date("2023-01-01");
  const to = new Date("2024-01-01");
  const filter = dateRangeFilter("testField", from, to);
  assert.deepEqual(filter, { testField: { $gte: from, $lte: to } });
});

test("pageQuerySchema sets limit === 50 when parsing an empty object", () => {
  const result = pageQuerySchema.parse({});
  assert.equal(result.limit, DEFAULT_PAGE_LIMIT);
});

test("pageQuerySchema handles string '10' as the limit", () => {
  const result = pageQuerySchema.parse({ limit: "10" });
  assert.equal(result.limit, 10);
});

test("pageQuerySchema fails with limit '0'", () => {
  assert.throws(() => pageQuerySchema.parse({ limit: "0" }));
});

test("pageQuerySchema fails with limit '101' (MAX_PAGE_LIMIT)", () => {
  const maxStr = String(MAX_PAGE_LIMIT + 1);
  assert.throws(() => pageQuerySchema.parse({ limit: maxStr }));
});

test("pageQuerySchema accepts MAX_PAGE_LIMIT as the limit", () => {
  const result = pageQuerySchema.parse({ limit: String(MAX_PAGE_LIMIT) });
  assert.equal(result.limit, MAX_PAGE_LIMIT);
});
