/**
 * Üyenin kendi profilinde sakladığı yaş/boy/kilo — mobil kalori
 * hesaplayıcının bu alanları otomatik doldurabilmesi için. Aralıklar
 * mobildeki `CALORIE_LIMITS` ile aynı (18–80 yaş, 120–230 cm, 35–300 kg);
 * paketler arası çalışma zamanı kodu paylaşılmadığından (`@opengym/shared`
 * yalnızca tip taşır) sınırlar burada ayrıca tanımlanır.
 */

export const AGE_RANGE = { min: 18, max: 80 } as const;
export const HEIGHT_CM_RANGE = { min: 120, max: 230 } as const;
export const WEIGHT_KG_RANGE = { min: 35, max: 300 } as const;

export const INVALID_AGE_MESSAGE = "Yaş 18-80 aralığında tam sayı olmalı.";
export const INVALID_HEIGHT_MESSAGE = "Boy 120-230 cm aralığında olmalı.";
export const INVALID_WEIGHT_MESSAGE = "Kilo 35-300 kg aralığında olmalı.";

export class InvalidBodyMetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBodyMetricError";
  }
}

function assertInRange(
  value: unknown,
  range: { min: number; max: number },
  message: string,
  integer = false,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < range.min ||
    value > range.max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new InvalidBodyMetricError(message);
  }
}

/**
 * BetterAuth `update-user` gövdesinden gelen `age`/`heightCm`/`weightKg`
 * alanlarını doğrular. Bir alan istekte yoksa veya `null` ise dokunmaz — bu,
 * alanı temizlemek için kullanılabilir.
 */
export function assertValidBodyMetricsUpdate(input: {
  age?: unknown;
  heightCm?: unknown;
  weightKg?: unknown;
}): void {
  if (Object.prototype.hasOwnProperty.call(input, "age") && input.age != null) {
    assertInRange(input.age, AGE_RANGE, INVALID_AGE_MESSAGE, true);
  }
  if (
    Object.prototype.hasOwnProperty.call(input, "heightCm") &&
    input.heightCm != null
  ) {
    assertInRange(input.heightCm, HEIGHT_CM_RANGE, INVALID_HEIGHT_MESSAGE);
  }
  if (
    Object.prototype.hasOwnProperty.call(input, "weightKg") &&
    input.weightKg != null
  ) {
    assertInRange(input.weightKg, WEIGHT_KG_RANGE, INVALID_WEIGHT_MESSAGE);
  }
}
