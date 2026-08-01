import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateCaloriePlan,
  cmToFeetAndInches,
  feetAndInchesToCm,
  kgToPounds,
  parseLocalizedNumber,
  poundsToKg,
} from "./calorieCalculator";

describe("calculateCaloriePlan", () => {
  it("erkek bakım kalorisi ve makrolarını hesaplar", () => {
    const result = calculateCaloriePlan({
      sex: "male",
      age: 30,
      heightCm: 180,
      weightKg: 80,
      activity: "moderate",
      goal: "maintain",
    });

    assert.equal(result.bmr, 1780);
    assert.equal(result.maintenanceCalories, 2760);
    assert.equal(result.targetCalories, 2760);
    assert.deepEqual(result.macros, {
      protein: { percent: 25, grams: 173 },
      carbohydrate: { percent: 45, grams: 311 },
      fat: { percent: 30, grams: 92 },
    });
  });

  it("kadın yağ kaybı hedefini yüzde 15 açıkla hesaplar", () => {
    const result = calculateCaloriePlan({
      sex: "female",
      age: 40,
      heightCm: 165,
      weightKg: 65,
      activity: "sedentary",
      goal: "loseFat",
    });

    assert.equal(result.bmr, 1320);
    assert.equal(result.maintenanceCalories, 1580);
    assert.equal(result.targetCalories, 1350);
    assert.deepEqual(result.macros, {
      protein: { percent: 30, grams: 101 },
      carbohydrate: { percent: 45, grams: 152 },
      fat: { percent: 25, grams: 38 },
    });
  });

  it("kas kazanımı hedefini yüzde 10 artırır", () => {
    const result = calculateCaloriePlan({
      sex: "male",
      age: 30,
      heightCm: 180,
      weightKg: 80,
      activity: "moderate",
      goal: "gainMuscle",
    });

    assert.equal(result.targetCalories, 3030);
    assert.equal(result.macros.carbohydrate.percent, 50);
  });

  it("beş hareket seviyesini artan bakım kalorisine dönüştürür", () => {
    const levels = [
      "sedentary",
      "light",
      "moderate",
      "active",
      "veryActive",
    ] as const;
    const values = levels.map(
      (activity) =>
        calculateCaloriePlan({
          sex: "female",
          age: 28,
          heightCm: 168,
          weightKg: 60,
          activity,
          goal: "maintain",
        }).maintenanceCalories,
    );

    assert.deepEqual(values, [1620, 1850, 2090, 2330, 2560]);
  });

  it("desteklenen yaş, boy ve kilo sınırlarını zorunlu kılar", () => {
    const valid = {
      sex: "male" as const,
      age: 30,
      heightCm: 180,
      weightKg: 80,
      activity: "light" as const,
      goal: "maintain" as const,
    };

    assert.throws(() => calculateCaloriePlan({ ...valid, age: 17 }));
    assert.throws(() => calculateCaloriePlan({ ...valid, age: 30.5 }));
    assert.throws(() => calculateCaloriePlan({ ...valid, heightCm: 231 }));
    assert.throws(() => calculateCaloriePlan({ ...valid, weightKg: 301 }));
  });
});

describe("birim ve sayı yardımcıları", () => {
  it("Türkçe ve İngilizce ondalık girişlerini çözer", () => {
    assert.equal(parseLocalizedNumber("80,5"), 80.5);
    assert.equal(parseLocalizedNumber("80.5"), 80.5);
    assert.equal(parseLocalizedNumber("1,2,3"), null);
    assert.equal(parseLocalizedNumber("-2"), null);
  });

  it("kg/lb dönüşümünde fiziksel değeri korur", () => {
    const pounds = kgToPounds(80);
    assert.ok(Math.abs(poundsToKg(pounds) - 80) < 0.000001);
  });

  it("cm ile ft/in dönüşümünde fiziksel değeri korur", () => {
    const imperial = cmToFeetAndInches(180);
    assert.ok(
      Math.abs(feetAndInchesToCm(imperial.feet, imperial.inches) - 180) <
        0.000001,
    );
  });
});
