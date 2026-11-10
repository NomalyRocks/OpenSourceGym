import type { CurrencyCode } from "@opengym/shared";
import { localeFor } from "../i18n/core";

/** Convert integer minor units only at the display boundary. */
export function formatMoney(
  amountMinor: number,
  currency: CurrencyCode,
  language: string | undefined,
): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(
      "Money must be expressed in safe integer minor units.",
    );
  }

  return new Intl.NumberFormat(localeFor(language), {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}
