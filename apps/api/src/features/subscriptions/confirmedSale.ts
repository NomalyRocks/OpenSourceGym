import { z } from "zod";
import type { CurrencyCode, PackageDuration } from "@opengym/shared";
import { currencySchema } from "../payments/money.js";
import {
  catalogPriceChanged,
  createSubscriptionSchema,
  packageDurationSchema,
} from "./sale.js";

const confirmedTerms = {
  expectedCurrency: currencySchema,
  expectedDuration: packageDurationSchema,
};

/** The web sale client must submit every term displayed at confirmation. */
export const confirmedSaleSchema = z.union([
  createSubscriptionSchema.options[0].extend(confirmedTerms),
  createSubscriptionSchema.options[1].extend(confirmedTerms),
]);

export function saleTermsChanged(
  body: z.infer<typeof confirmedSaleSchema>,
  currency: CurrencyCode,
  duration: PackageDuration,
  priceMinor: number | null,
): boolean {
  return (
    body.expectedCurrency !== currency ||
    body.expectedDuration.unit !== duration.unit ||
    body.expectedDuration.value !== duration.value ||
    catalogPriceChanged(body, priceMinor)
  );
}
