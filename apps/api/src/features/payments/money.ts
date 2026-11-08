import { z } from "zod";
import type { CurrencyCode } from "@opengym/shared";
import { findChainSettings } from "../../core/db.js";

/** Every amount is an integer in minor units; all four currencies use two digits. */
export const MAX_PRICE_MINOR = 100_000_000_00;

export const CURRENCY_CODES = ["TRY", "USD", "EUR", "GBP"] as const;
export const DEFAULT_CURRENCY: CurrencyCode = "TRY";

export const currencySchema = z.enum(CURRENCY_CODES);

/** A price: integer minor units, 0 allowed (a free package or a comped period). */
export const priceMinorSchema = z.number().int().min(0).max(MAX_PRICE_MINOR);

/** A payment amount: at least one minor unit. */
export const amountMinorSchema = z.number().int().min(1).max(MAX_PRICE_MINOR);

/** The chain currency new sales are made in. */
export async function getChainCurrency(): Promise<CurrencyCode> {
  return (await findChainSettings())?.currency ?? DEFAULT_CURRENCY;
}
