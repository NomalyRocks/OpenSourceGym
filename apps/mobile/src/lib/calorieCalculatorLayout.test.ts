import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCalorieIntroArtworkSize } from "./calorieCalculatorLayout";

describe("getCalorieIntroArtworkSize", () => {
  it("360×720 sınıfı küçük telefonda başlık için alan açar", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 360, height: 720, fontScale: 1 }),
      184,
    );
  });

  it("standart uzun telefonda görseli 228 dp ile sınırlar", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 390, height: 844, fontScale: 1 }),
      228,
    );
  });

  it("büyük yazıda görseli küçültür", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 390, height: 844, fontScale: 1.4 }),
      156,
    );
  });

  it("dar pencerede yatay taşmayı önler", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 200, height: 720, fontScale: 1 }),
      136,
    );
  });
});
