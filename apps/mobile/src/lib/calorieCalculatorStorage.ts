import * as SecureStore from "expo-secure-store";
import type { ActivityLevel, CalorieGoal, Sex } from "./calorieCalculator";

const STORAGE_KEY_PREFIX = "opengym.calorieCalculator.state";

/**
 * Anahtar üyeye özeldir: aynı cihazda A çıkıp B girdiğinde B'nin akışı A'nın
 * cinsiyet/yaş/ölçüleriyle dolmasın. Beklenmeyen bir kimlik biçiminde
 * temizleyip devam etmek yerine `null` döneriz: karakter ayıklamak enjektif
 * değildir, iki farklı kimlik aynı anahtara düşüp veriyi çapraz besleyebilir.
 * SecureStore anahtarları zaten yalnızca harf, rakam, ".", "-" ve "_" kabul
 * eder; kullanıcı kimliği ObjectId hex'idir.
 */
function storageKey(userId: string): string | null {
  if (!/^[a-f0-9]{24}$/i.test(userId)) return null;
  return `${STORAGE_KEY_PREFIX}.${userId}`;
}

export type CalorieUnitSystem = "metric" | "imperial";

/**
 * Hesaplayıcının son girdileri: bir dahaki açılışta akış boş başlamasın diye
 * yalnızca bu cihazda (SecureStore) ve yalnızca ilgili üyenin anahtarı altında
 * saklanır. Boy/kilo bu kuralın dışında: onlar ayrıca üyenin kendi profiline
 * de yazılır (bkz. CalorieCalculator.tsx), çünkü sunucu tarafında da
 * tutulmaları kabul edildi.
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
 * Anahtar üyeye özel hale gelmeden önce yazılmış tek ortak kayıt. Sahibi
 * bilinemediği için taşınamaz, cihazda da bırakılamaz: ilk erişimde silinir.
 */
async function dropLegacyUnscopedState(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY_PREFIX);
  } catch {
    // Silinemezse bir sonraki erişimde yeniden denenir.
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
    // Yazma başarısız olursa bir dahaki açılış boş başlar; kritik değil.
  }
}

/**
 * Oturum kaybında çağrılır (bkz. App.tsx): elle çıkış, hesap silme onayı,
 * paylaşım tespitiyle oturum iptali veya sürenin dolması. Sağlık verisi
 * cihazda oturumdan uzun yaşamamalı.
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
    // Silinemezse bir sonraki çıkışta yeniden denenir.
  }
}
