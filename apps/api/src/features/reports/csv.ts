/**
 * Spreadsheet applications interpret cells beginning with these characters as
 * FORMULAS. Because exported data contains free text such as member names and
 * notes, someone entering `=cmd|...` could execute code on the staff member's
 * machine when the file is opened. Prefixing the cell with an apostrophe fixes
 * the value as text.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const guarded = FORMULA_PREFIXES.some((prefix) => raw.startsWith(prefix))
    ? `'${raw}`
    : raw;
  // Quote every value containing a quote, comma, or line break; double embedded
  // quotes according to RFC 4180.
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/**
 * BOM for correct UTF-8 detection in Excel. Without it, non-ASCII characters
 * appear corrupted in Windows Excel—the primary export consumer is accounting.
 */
export const UTF8_BOM = "﻿";
