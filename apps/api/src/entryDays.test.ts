import assert from "node:assert/strict";
import { test } from "node:test";
import { dayLabelSpan, entryQueryWindow, toEntryDays } from "./entryDays.js";

test("dayLabelSpan gün farkını verir", () => {
  assert.equal(dayLabelSpan("2026-08-01", "2026-08-31"), 30);
  assert.equal(dayLabelSpan("2026-08-01", "2026-08-01"), 0);
  assert.equal(dayLabelSpan("2026-08-31", "2026-08-01"), -30);
});

test("dayLabelSpan yaz saati geçişini atlamaz", () => {
  // 2026-03-29 Avrupa'da saat ileri alınır; etiket aritmetiği UTC üzerinden
  // yapıldığı için 31 günlük mart ayı 30 gün farkı vermelidir.
  assert.equal(dayLabelSpan("2026-03-01", "2026-03-31"), 30);
});

test("entryQueryWindow aralığı saat dilimi sapması kadar genişletir", () => {
  const { start, end } = entryQueryWindow("2026-08-01", "2026-08-31");
  // UTC+14'te yerel 1 Ağustos, UTC'de 31 Temmuz 10:00'da başlar.
  assert.equal(start.toISOString(), "2026-07-31T10:00:00.000Z");
  // UTC-12'de yerel 31 Ağustos, UTC'de 1 Eylül 14:00'te biter.
  assert.equal(end.toISOString(), "2026-09-01T14:00:00.000Z");
});

test("toEntryDays pencere dışındaki günleri eler ve sıralar", () => {
  const days = toEntryDays(
    [
      { _id: "2026-08-15", entries: 2 },
      { _id: "2026-09-01", entries: 1 },
      { _id: "2026-07-31", entries: 3 },
      { _id: "2026-08-02", entries: 1 },
    ],
    "2026-08-01",
    "2026-08-31",
  );
  assert.deepEqual(days, [
    { date: "2026-08-02", entries: 1 },
    { date: "2026-08-15", entries: 2 },
  ]);
});

test("toEntryDays boş günü yanıta koymaz", () => {
  assert.deepEqual(
    toEntryDays(
      [{ _id: "2026-08-10", entries: 0 }],
      "2026-08-01",
      "2026-08-31",
    ),
    [],
  );
});
