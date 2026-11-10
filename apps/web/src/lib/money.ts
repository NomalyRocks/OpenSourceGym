/** Parse a nonnegative major-unit amount without floating point arithmetic. */
export function parseMoney(input: string): number | null {
  const value = input.trim();
  if (!value || !/^[0-9., \u00a0\u202f]+$/.test(value)) return null;
  const decimal = value.includes(",") ? "," : ".";
  const parts = value.split(decimal);
  if (parts.length > 2) return null;
  const [whole = "", fraction = ""] = parts;
  if (parts.length === 2 && !/^\d{1,2}$/.test(fraction)) return null;
  const grouping = decimal === "," && whole.includes(".") ? "." : " ";
  const normalized = whole.replace(/[\u00a0\u202f]/g, " ");
  const validWhole =
    grouping === "."
      ? /^\d{1,3}(?:\.\d{3})+$/.test(normalized)
      : /^\d+$/.test(normalized) || /^\d{1,3}(?: \d{3})+$/.test(normalized);
  if (!validWhole) return null;
  const digits = normalized.replace(/[. ]/g, "") + fraction.padEnd(2, "0");
  const minor = BigInt(digits);
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

export const MAX_PRICE_MINOR = 10_000_000_000;

export function moneyInputValue(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

export function formatMoney(
  minor: number,
  currency: string,
  locale: string,
): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    minor / 100,
  );
}

/** Catalog prices can be formatted before the catalog currency has loaded. */
export function formatCatalogMoney(
  minor: number,
  currency: string | null,
  locale: string,
): string {
  return currency
    ? formatMoney(minor, currency, locale)
    : new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(minor / 100);
}
