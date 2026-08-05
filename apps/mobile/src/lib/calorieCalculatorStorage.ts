import * as SecureStore from "expo-secure-store";
import type { ActivityLevel, CalorieGoal, Sex } from "./calorieCalculator";

const STORAGE_KEY_PREFIX = "opengym.calorieCalculator.state";

/**
 * The key is member-specific: when A signs out and B signs in on the same device,
 * B's flow must not contain A's sex, age, or measurements. For an unexpected ID
 * format, return `null` instead of sanitizing and continuing: character removal
 * is not injective, so two different IDs could map to the same key and cross-feed
 * data. SecureStore keys already accept only letters, digits, ".", "-", and "_";
 * the user ID is an ObjectId hex string.
 */
function storageKey(userId: string): string | null {
  if (!/^[a-f0-9]{24}$/i.test(userId)) return null;
  return `${STORAGE_KEY_PREFIX}.${userId}`;
}

export type CalorieUnitSystem = "metric" | "imperial";

/**
 * The calculator's latest inputs are stored only on this device (SecureStore)
 * and under the relevant member's key so the flow is not empty next time. Height
 * and weight are exceptions: they are also written to the member's profile (see
 * CalorieCalculator.tsx) because server-side storage is accepted for them.
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

/**
 * Single shared entry written before keys became member-specific. Its owner
 * cannot be determined, so it cannot be migrated or left on the device; it is
 * deleted on first access.
 */
async function dropLegacyUnscopedState(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY_PREFIX);
  } catch {
    // If deletion fails, it is retried on the next access.
  }
}

export async function loadCalorieCalculatorState(
  userId: string,
): Promise<StoredCalorieState | null> {
  await dropLegacyUnscopedState();
  const key = storageKey(userId);
  if (key == null) return null;
  try {
    const raw = await SecureStore.getItemAsync(key);
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
  userId: string,
  state: StoredCalorieState,
): Promise<void> {
  const key = storageKey(userId);
  if (key == null) return;
  try {
    await SecureStore.setItemAsync(key, JSON.stringify(state));
  } catch {
    // If the write fails, the next opening starts empty; this is not critical.
  }
}

/**
 * Called when the session is lost (see App.tsx): manual sign-out, account
 * deletion approval, session revocation after sharing detection, or expiry.
 * Health data must not outlive the session on the device.
 */
export async function clearCalorieCalculatorState(
  userId: string,
): Promise<void> {
  await dropLegacyUnscopedState();
  const key = storageKey(userId);
  if (key == null) return;
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // If deletion fails, it is retried on the next sign-out.
  }
}
