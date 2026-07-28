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

test("encodeCursor sonra decodeCursor ile turu dönüşüm", () => {
  const at = new Date();
  const id = new ObjectId();
  const encoded = encodeCursor(at, id);
  const decoded = decodeCursor(encoded);
  assert.ok(decoded != null);
  assert.equal(decoded.at.getTime(), at.getTime());
  assert.equal(decoded.id.toHexString(), id.toHexString());
});

test("decodeCursor, geçersiz base64url içeriği için null döner", () => {
  assert.equal(decodeCursor("!!!notvalid!!!"), null);
});

test("decodeCursor, ':' içermeyen bir değer için null döner", () => {
  const encoded = Buffer.from("no-separator-here", "utf8").toString(
    "base64url",
  );
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor, numaratik olmayan bir zaman damgası için null döner", () => {
  const encoded = Buffer.from(
    "invalid:0123456789abcdef01234567",
    "utf8",
  ).toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor, 24 karakterden farklı bir hex id için null döner", () => {
  const encoded = Buffer.from("1234567890:123", "utf8").toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor, 24 karakterin altında bir hex id için null döner", () => {
  const encoded = Buffer.from("1234567890:12", "utf8").toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor, 24 karakterin üzerinde bir hex id için null döner", () => {
  const encoded = Buffer.from(
    "1234567890:123456789012345678901234567890",
    "utf8",
  ).toString("base64url");
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor, 24 karakterinin altında bir ASCII id için null döner (ObjectId.isValid kabul eder)", () => {
  const encoded = Buffer.from("1234567890:abcdefghijkl", "utf8").toString(
    "base64url",
  );
  assert.equal(decodeCursor(encoded), null);
});

test("decodeCursor, geçerli bir imleci çözer", () => {
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

test("cursorFilter, açık doğru $or yapısını döner", () => {
  const at = new Date();
  const id = new ObjectId();
  const cursor = { at, id };
  const filter = cursorFilter("testField", cursor);
  assert.deepEqual(filter, {
    $or: [{ testField: { $lt: at } }, { testField: at, _id: { $lt: id } }],
  });
});

test("cursorFilter, artan yönde $gt kullanır", () => {
  const at = new Date();
  const id = new ObjectId();
  // Yenileme listesi "en yakın bitiş önce" sıralanır; imleçten SONRAKİ kayıt
  // artan yönde daha BÜYÜK olandır. $lt kalsaydı ikinci sayfa hep boş dönerdi.
  const filter = cursorFilter("endsAt", { at, id }, "asc");
  assert.deepEqual(filter, {
    $or: [{ endsAt: { $gt: at } }, { endsAt: at, _id: { $gt: id } }],
  });
});

test("sortSpec, yöne göre her iki anahtarı da çevirir", () => {
  assert.deepEqual(sortSpec("at"), { at: -1, _id: -1 });
  assert.deepEqual(sortSpec("endsAt", "asc"), { endsAt: 1, _id: 1 });
});

test("toPage, limit kadar kayıt gelirse sonraki imleci üretmez", () => {
  const docs = [
    { _id: new ObjectId(), at: new Date(2) },
    { _id: new ObjectId(), at: new Date(1) },
  ];
  const page = toPage(docs, "at", 2);
  assert.equal(page.docs.length, 2);
  assert.equal(page.nextCursor, null);
});

test("toPage, fazladan kayıt geldiğinde son görünen kayıttan imleç üretir", () => {
  const last = { _id: new ObjectId(), at: new Date(2) };
  const docs = [
    { _id: new ObjectId(), at: new Date(3) },
    last,
    // limit + 1'inci kayıt yalnızca "devamı var" sinyalidir, sayfaya girmez.
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

test("dateRangeFilter, hem from hem to tanımsızsa {} döner", () => {
  const filter = dateRangeFilter("testField");
  assert.deepEqual(filter, {});
});

test("dateRangeFilter, yalnızca from verildiğinde { field: { $gte } } döner", () => {
  const from = new Date("2023-01-01");
  const filter = dateRangeFilter("testField", from);
  assert.deepEqual(filter, { testField: { $gte: from } });
});

test("dateRangeFilter, yalnızca to verildiğinde { field: { $lte } } döner", () => {
  const to = new Date("2024-01-01");
  const filter = dateRangeFilter("testField", undefined, to);
  assert.deepEqual(filter, { testField: { $lte: to } });
});

test("dateRangeFilter, hem from hem to verildiğinde doğru aralığı döner", () => {
  const from = new Date("2023-01-01");
  const to = new Date("2024-01-01");
  const filter = dateRangeFilter("testField", from, to);
  assert.deepEqual(filter, { testField: { $gte: from, $lte: to } });
});

test("pageQuerySchema, boş bir nesneyi çözerken limit === 50", () => {
  const result = pageQuerySchema.parse({});
  assert.equal(result.limit, DEFAULT_PAGE_LIMIT);
});

test("pageQuerySchema, limit olarak string '10'u işler", () => {
  const result = pageQuerySchema.parse({ limit: "10" });
  assert.equal(result.limit, 10);
});

test("pageQuerySchema, limit '0' ifadesiyle başarısız olur", () => {
  assert.throws(() => pageQuerySchema.parse({ limit: "0" }));
});

test("pageQuerySchema, limit '101' ifadesiyle başarısız olur (MAX_PAGE_LIMIT)", () => {
  const maxStr = String(MAX_PAGE_LIMIT + 1);
  assert.throws(() => pageQuerySchema.parse({ limit: maxStr }));
});

test("pageQuerySchema, limit MAX_PAGE_LIMIT değerini kabul eder", () => {
  const result = pageQuerySchema.parse({ limit: String(MAX_PAGE_LIMIT) });
  assert.equal(result.limit, MAX_PAGE_LIMIT);
});
