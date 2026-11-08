import { z } from "zod";
import type { PackageDuration, Role } from "@opengym/shared";
import { priceMinorSchema } from "../payments/money.js";

/** Duration bounds shared by the catalog and custom grants. */
export const MAX_MONTHS = 24;
export const MAX_DAYS = 366;

export const packageDurationSchema = z
  .discriminatedUnion("unit", [
    z
      .object({
        unit: z.literal("month"),
        value: z.number().int().min(1).max(MAX_MONTHS),
      })
      .strict(),
    z
      .object({
        unit: z.literal("day"),
        value: z.number().int().min(1).max(MAX_DAYS),
      })
      .strict(),
  ])
  .transform((duration): PackageDuration => duration);

/** An ISO timestamp (or null) for the optional promise date of the remainder. */
const nextPaymentDueSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date")
  .transform((value) => new Date(value))
  .nullable()
  .optional();

const saleBase = {
  userId: z.string(),
  gymIds: z.array(z.string().min(1).max(64)).max(200),
  nextPaymentDue: nextPaymentDueSchema,
  note: z.string().trim().max(500).optional(),
  requestId: z.string().uuid(),
};

const packageSaleSchema = z
  .object({
    ...saleBase,
    packageId: z.string().min(1).max(64),
    /** Per-sale price override, owner/admin only */
    priceMinor: priceMinorSchema.optional(),
    expectedPriceMinor: priceMinorSchema.optional(),
  })
  .strict();

const customSaleSchema = z
  .object({
    ...saleBase,
    custom: z
      .object({
        days: z.number().int().min(1).max(MAX_DAYS),
        priceMinor: priceMinorSchema,
        label: z.string().trim().min(1).max(80).optional(),
      })
      .strict(),
  })
  .strict();

/** Body of POST /api/admin/subscriptions: a catalog sale or a custom grant. */
export const createSubscriptionSchema = z.union([
  packageSaleSchema,
  customSaleSchema,
]);

export type CreateSubscriptionBody = z.infer<typeof createSubscriptionSchema>;

/** Overrides intentionally choose a price independently of the catalog. */
export function catalogPriceChanged(
  body: CreateSubscriptionBody,
  currentPriceMinor: number | null,
): boolean {
  return (
    !("custom" in body) &&
    body.priceMinor === undefined &&
    body.expectedPriceMinor !== undefined &&
    body.expectedPriceMinor !== currentPriceMinor
  );
}

/**
 * Staff sells at the catalog price: a price override and a custom grant are
 * owner/admin only.
 */
export function mayChoosePrice(
  role: Role,
  body: CreateSubscriptionBody,
): boolean {
  if (role === "owner" || role === "admin") return true;
  return !("custom" in body) && body.priceMinor === undefined;
}
