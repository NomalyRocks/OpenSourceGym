import * as SecureStore from "expo-secure-store";
import type { ActivityLevel, CalorieGoal, Sex } from "./calorieCalculator";

const STORAGE_KEY = "opengym.calorieCalculator.state";

export type CalorieUnitSystem = "metric" | "imperial";

/**
 * Hesaplayıcının son girdileri: bir dahaki açılışta akış boş başlamasın diye
 * yalnızca bu cihazda (SecureStore) saklanır — API'ye veya Profil gibi başka
 * bir ekrana yansıtılmaz. Boy/kilo bu kuralın dışında: onlar ayrıca üyenin
 * kendi profiline de yazılır (bkz. CalorieCalculator.tsx), çünkü sunucu
 * tarafında da tutulmaları kabul edildi.
 */
export interface StoredCalorieState {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activity: ActivityLevel;
  goal: CalorieGoal;
  heightUnit: CalorieUnitSystem;
  weightUnit: CalorieUnitSystem;
}

function isSex(value: unknown): value is Sex {
  return value === "female" || value === "male";
}

function isActivityLevel(value: unknown): value is ActivityLevel {
  return (
    value === "sedentary" ||
    value === "light" ||
    value === "moderate" ||
    value === "active" ||
    value === "veryActive"
  );
}

function isCalorieGoal(value: unknown): value is CalorieGoal {
  return value === "loseFat" || value === "maintain" || value === "gainMuscle";
}

function isUnitSystem(value: unknown): value is CalorieUnitSystem {
  return value === "metric" || value === "imperial";
}

export async function loadCalorieCalculatorState(): Promise<StoredCalorieState | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      !isSex(record.sex) ||
      typeof record.age !== "number" ||
      typeof record.heightCm !== "number" ||
      typeof record.weightKg !== "number" ||
      !isActivityLevel(record.activity) ||
      !isCalorieGoal(record.goal) ||
      !isUnitSystem(record.heightUnit) ||
      !isUnitSystem(record.weightUnit)
    ) {
      return null;
    }
    return {
      sex: record.sex,
      age: record.age,
      heightCm: record.heightCm,
      weightKg: record.weightKg,
      activity: record.activity,
      goal: record.goal,
      heightUnit: record.heightUnit,
      weightUnit: record.weightUnit,
    };
  } catch {
    return null;
  }
}

export async function saveCalorieCalculatorState(
  state: StoredCalorieState,
): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Yazma başarısız olursa bir dahaki açılış boş başlar; kritik değil.
  }
}
