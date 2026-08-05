/**
 * Age, height, and weight stored in the member's profile so the mobile calorie
 * calculator can populate these fields automatically. The ranges match
 * `CALORIE_LIMITS` in mobile (ages 18–80, 120–230 cm, 35–300 kg); because no
 * runtime code is shared across packages (`@opengym/shared` contains types
 * only), the limits are also defined here.
 */

export const AGE_RANGE = { min: 18, max: 80 } as const;
export const HEIGHT_CM_RANGE = { min: 120, max: 230 } as const;
export const WEIGHT_KG_RANGE = { min: 35, max: 300 } as const;

export const INVALID_AGE_MESSAGE = "Age must be an integer between 18 and 80.";
export const INVALID_HEIGHT_MESSAGE = "Height must be between 120 and 230 cm.";
export const INVALID_WEIGHT_MESSAGE = "Weight must be between 35 and 300 kg.";

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
 * Validates the `age`/`heightCm`/`weightKg` fields from the BetterAuth
 * `update-user` body. A field is left untouched when absent or `null`, which
 * can be used to clear it.
 */
export const BODY_METRIC_FIELDS = ["age", "heightCm", "weightKg"] as const;
export type BodyMetricField = (typeof BODY_METRIC_FIELDS)[number];

/**
 * Converts the PATCH body into a Mongo update: an omitted field is left
 * untouched, `null` clears it with `$unset`, and a number uses `$set`.
 */
export function buildBodyMetricsUpdate(
  input: Partial<Record<BodyMetricField, number | null>>,
): {
  set: Partial<Record<BodyMetricField, number>>;
  unset: Partial<Record<BodyMetricField, "">>;
} {
  const set: Partial<Record<BodyMetricField, number>> = {};
  const unset: Partial<Record<BodyMetricField, "">> = {};
  for (const field of BODY_METRIC_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null) unset[field] = "";
    else set[field] = value;
  }
  return { set, unset };
}

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
