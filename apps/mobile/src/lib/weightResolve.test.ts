import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWeightForDay, type WeightEntry } from "./weightResolve";

describe("resolveWeightForDay", () => {
  const entries: WeightEntry[] = [
    { weightKg: 80, at: "2026-07-29T08:00:00.000Z" },
    { weightKg: 78, at: "2026-08-01T08:00:00.000Z" },
  ];

  it("kaydı olmayan gün, kendinden önceki en son kaydı taşır", () => {
    // 29 Temmuz'da giriş var, 30'da yok — 30 seçilince 29'un değeri geçerli.
    assert.equal(resolveWeightForDay(entries, "2026-07-30"), 80);
  });

  it("tam kayıt günü kendi değerini döner", () => {
    assert.equal(resolveWeightForDay(entries, "2026-07-29"), 80);
    assert.equal(resolveWeightForDay(entries, "2026-08-01"), 78);
  });

  it("sonraki bir kayıt geçmişe taşınmaz", () => {
    // 31 Temmuz'da hâlâ 29'un değeri geçerli, 1 Ağustos'un değeri değil.
    assert.equal(resolveWeightForDay(entries, "2026-07-31"), 80);
  });

  it("ilk kayıttan önceki gün için veri yoktur", () => {
    assert.equal(resolveWeightForDay(entries, "2026-07-01"), null);
  });

  it("boş geçmişte her zaman null döner", () => {
    assert.equal(resolveWeightForDay([], "2026-08-02"), null);
  });
});
