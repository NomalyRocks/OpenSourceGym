/**
 * Elektronik tablo uygulamaları bu karakterlerle başlayan hücreyi FORMÜL olarak
 * yorumlar. Dışa aktarılan veri üye adı/notu gibi serbest metin içerdiğinden,
 * `=cmd|...` yazan biri dosyayı açan personelin makinesinde kod çalıştırabilir.
 * Hücrenin başına tek tırnak koymak değeri metin olarak sabitler.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const guarded = FORMULA_PREFIXES.some((prefix) => raw.startsWith(prefix))
    ? `'${raw}`
    : raw;
  // Tırnak, virgül veya satır sonu içeren her değer tırnaklanır; içteki
  // tırnaklar RFC 4180'e göre ikilenir.
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/**
 * Excel'in UTF-8'i doğru tanıması için BOM. Bu olmadan Türkçe karakterler
 * Windows Excel'de bozuk görünür — dışa aktarmanın asıl kullanıcısı muhasebe.
 */
export const UTF8_BOM = "﻿";
