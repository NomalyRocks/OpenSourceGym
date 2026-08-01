export type Sex = "female" | "male";

export type ActivityLevel =
  "sedentary" | "light" | "moderate" | "active" | "veryActive";

export type CalorieGoal = "loseFat" | "maintain" | "gainMuscle";

export interface CalorieInput {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activity: ActivityLevel;
  goal: CalorieGoal;
}

export interface MacroTarget {
  percent: number;
  grams: number;
}

export interface CalorieResult {
  bmr: number;
  maintenanceCalories: number;
  targetCalories: number;
  activityMultiplier: number;
  goalFactor: number;
  macros: {
    protein: MacroTarget;
    carbohydrate: MacroTarget;
    fat: MacroTarget;
  };
}

export const CALORIE_LIMITS = {
  age: { min: 18, max: 80 },
  heightCm: { min: 120, max: 230 },
  weightKg: { min: 35, max: 300 },
} as const;

export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  veryActive: 1.9,
} satisfies Record<ActivityLevel, number>;

const GOAL_FACTORS = {
  loseFat: 0.85,
  maintain: 1,
  gainMuscle: 1.1,
} satisfies Record<CalorieGoal, number>;

const MACRO_SPLITS = {
  loseFat: { protein: 30, carbohydrate: 45, fat: 25 },
  maintain: { protein: 25, carbohydrate: 45, fat: 30 },
  gainMuscle: { protein: 25, carbohydrate: 50, fat: 25 },
} satisfies Record<
  CalorieGoal,
  { protein: number; carbohydrate: number; fat: number }
>;

function assertRange(
  name: string,
  value: number,
  range: { min: number; max: number },
) {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new RangeError(
      `${name} must be between ${range.min} and ${range.max}`,
    );
  }
}

function roundToNearestTen(value: number) {
  return Math.round(value / 10) * 10;
}

function macroTarget(
  targetCalories: number,
  percent: number,
  caloriesPerGram: number,
): MacroTarget {
  return {
    percent,
    grams: Math.round((targetCalories * (percent / 100)) / caloriesPerGram),
  };
}

/**
 * Mifflin–St Jeor denklemiyle bakım kalorisi ve hedefe göre makro tahmini.
 *
 * Fonksiyon yalnızca doğrulanmış yetişkin girdileri kabul eder; kullanıcıya
 * gösterilecek hata metinleri ekran katmanında yerelleştirilir.
 */
export function calculateCaloriePlan(input: CalorieInput): CalorieResult {
  assertRange("age", input.age, CALORIE_LIMITS.age);
  if (!Number.isInteger(input.age)) {
    throw new RangeError("age must be an integer");
  }
  assertRange("heightCm", input.heightCm, CALORIE_LIMITS.heightCm);
  assertRange("weightKg", input.weightKg, CALORIE_LIMITS.weightKg);

  const sexConstant = input.sex === "male" ? 5 : -161;
  const rawBmr =
    10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age + sexConstant;
  const activityMultiplier = ACTIVITY_MULTIPLIERS[input.activity];
  const goalFactor = GOAL_FACTORS[input.goal];
  const maintenanceCalories = roundToNearestTen(rawBmr * activityMultiplier);
  const targetCalories = roundToNearestTen(
    rawBmr * activityMultiplier * goalFactor,
  );
  const split = MACRO_SPLITS[input.goal];

  return {
    bmr: Math.round(rawBmr),
    maintenanceCalories,
    targetCalories,
    activityMultiplier,
    goalFactor,
    macros: {
      protein: macroTarget(targetCalories, split.protein, 4),
      carbohydrate: macroTarget(targetCalories, split.carbohydrate, 4),
      fat: macroTarget(targetCalories, split.fat, 9),
    },
  };
}

/** Virgül veya noktalı, pozitif ondalık kullanıcı girişini güvenle çözer. */
export function parseLocalizedNumber(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function poundsToKg(pounds: number): number {
  return pounds * 0.45359237;
}

export function kgToPounds(kilograms: number): number {
  return kilograms / 0.45359237;
}

export function feetAndInchesToCm(feet: number, inches: number): number {
  return (feet * 12 + inches) * 2.54;
}

export function cmToFeetAndInches(centimeters: number): {
  feet: number;
  inches: number;
} {
  const totalInches = centimeters / 2.54;
  const feet = Math.floor(totalInches / 12);
  return { feet, inches: totalInches - feet * 12 };
}
