import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCalorieIntroArtworkSize } from "./calorieCalculatorLayout";

describe("getCalorieIntroArtworkSize", () => {
  it("makes room for the heading on a 360×720-class small phone", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 360, height: 720, fontScale: 1 }),
      184,
    );
  });

  it("caps the illustration at 228 dp on a standard tall phone", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 390, height: 844, fontScale: 1 }),
      228,
    );
  });

  it("shrinks the illustration with large text", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 390, height: 844, fontScale: 1.4 }),
      156,
    );
  });

  it("prevents horizontal overflow in a narrow window", () => {
    assert.equal(
      getCalorieIntroArtworkSize({ width: 200, height: 720, fontScale: 1 }),
      136,
    );
  });
});
