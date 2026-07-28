import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dayLabels, localDayLabel } from "./reports.js";

describe("localDayLabel fonksiyonu", () => {
  it("Istanbul uç noktası için bir anın bir sonraki yerel gününü döndürür", () => {
    const result = localDayLabel(
      new Date("2026-03-01T21:30:00.000Z"),
      "Europe/Istanbul",
    );
    assert.strictEqual(result, "2026-03-02");
  });

  it("aynı anı UTC saat dilimi için doğru lokal günü döndürür", () => {
    const result = localDayLabel(new Date("2026-03-01T21:30:00.000Z"), "UTC");
    assert.strictEqual(result, "2026-03-01");
  });
});

describe("dayLabels fonksiyonu", () => {
  it("bütünleşik bir lokal gün için aralık için tam olarak bir etiket döndürür", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-01T10:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], "2026-03-01");
  });

  it("veya üç günlük bir aralık için doğru etiketleri döndürür", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-03T23:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.deepStrictEqual(result, ["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("ay sınırını doğru şekilde geçer", () => {
    const from = new Date("2026-01-30T00:00:00.000Z");
    const to = new Date("2026-02-02T00:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.deepStrictEqual(result, [
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("sonucu kapatır ve hiçbir zaman sonsuz döngüye girmemesi garantilidir", () => {
    const from = new Date("2025-01-01T00:00:00.000Z");
    const to = new Date("2026-02-05T00:00:00.000Z");
    const result = dayLabels(from, to, "UTC");
    assert.strictEqual(result.length <= 367, true);
    assert.strictEqual(result[0], "2025-01-01");
  });
});
