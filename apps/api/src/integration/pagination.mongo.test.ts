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
 * Aynı zaman damgasını paylaşan kayıtlar kasıtlıdır: keyset sayfalamanın asıl
 * kırılma noktası eşit damgalardır. _id ile kırılmazsa aynı milisaniyeye düşen
 * kayıtlar sayfalar arasında ya tekrarlanır ya da atlanır — birim testlerin
 * göremediği, yalnızca gerçek sıralama altında ortaya çıkan bir hata.
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

/** Beklenen sıra uygulamadan bağımsız hesaplanır: (at, _id) sözlük sırası. */
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

/** İmleci sonuna kadar takip eder; sonsuz döngüye karşı sert bir tavan koyar. */
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
    // Her sayfa en az bir kayıt ilerlemeli; ilerlemezse imleç filtresi bozuktur.
    assert.ok(pages <= FIXTURES.length + 2, "sayfalama sonlanmadı");
  }

  return { ids, pages };
}

test(
  "keyset sayfalama eşit zaman damgalarında kayıt tekrarlamaz ve atlamaz",
  { skip: mongoUri ? false : "TEST_MONGODB_URI tanımlı değil" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_pagination_${randomUUID().replaceAll("-", "")}`,
    );
    const events = database.collection("events");

    try {
      await client.connect();
      // Ekleme sırası bilinçli olarak sıralamayla aynı değil: sonuç yalnızca
      // sort anahtarına bağlı olmalı, doğal koleksiyon sırasına değil.
      await events.insertMany([...FIXTURES].reverse());

      for (const direction of ["desc", "asc"] as const) {
        const expected = expectedOrder(direction);

        for (const limit of [1, 3, 4, FIXTURES.length]) {
          const { ids } = await drain(events, { limit, direction });
          assert.deepEqual(
            ids,
            expected,
            `${direction}/limit=${limit} sırası bozuk`,
          );
          assert.equal(
            new Set(ids).size,
            ids.length,
            `${direction}/limit=${limit} kayıt tekrarladı`,
          );
        }
      }

      // Tek sayfaya sığan sonuç sonraki imleç üretmemeli.
      const single = await drain(events, { limit: FIXTURES.length });
      assert.equal(single.pages, 1);

      // Toplam limitin tam katıysa sondaki boş sayfa okunmamalı:
      // limit + 1 okuması bunu ayırt eder, ayrı bir sayım gerekmez.
      const exact = await drain(events, { limit: FIXTURES.length / 2 });
      assert.equal(exact.pages, 2);

      // Uca özgü filtre imleç filtresiyle birleşince de korunmalı.
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

      // Tarih aralığı filtresi de aynı şekilde birleşmeli.
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
  "bozuk imleç sorgu çalıştırmadan reddedilir",
  { skip: mongoUri ? false : "TEST_MONGODB_URI tanımlı değil" },
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
        "ayraç-yok",
        // Damga sayı değil.
        Buffer.from("abc:507f1f77bcf86cd799439011").toString("base64url"),
        // ObjectId.isValid'in kabul ettiği 12 karakterlik ham biçim; buradan
        // üretilen kimlik imlecin işaret ettiğinden başkasıdır.
        Buffer.from(`${BASE}:aaaaaaaaaaaa`).toString("base64url"),
        // Hex ama kısa.
        Buffer.from(`${BASE}:507f1f77bcf86cd7994390`).toString("base64url"),
      ];

      for (const cursor of invalid) {
        await assert.rejects(
          () => findPage(events, { timeField: "at", limit: 5, cursor }),
          InvalidCursorError,
          `imleç reddedilmedi: ${cursor}`,
        );
      }
    } finally {
      await database.dropDatabase();
      await client.close();
    }
  },
);
