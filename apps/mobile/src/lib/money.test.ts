import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney } from "./money";

test("formats minor units with the active Turkish or English locale", () => {
  assert.equal(formatMoney(123456, "TRY", "tr"), "₺1.234,56");
  assert.equal(formatMoney(123456, "USD", "en"), "$1,234.56");
  assert.equal(formatMoney(123456, "EUR", "tr-TR"), "€1.234,56");
  assert.equal(formatMoney(123456, "GBP", "en-US"), "£1,234.56");
});

test("preserves cents, zero and large integer balances", () => {
  assert.equal(formatMoney(1, "USD", "en"), "$0.01");
  assert.equal(formatMoney(29, "USD", "en"), "$0.29");
  assert.equal(formatMoney(10005, "USD", "en"), "$100.05");
  assert.equal(formatMoney(0, "USD", "en"), "$0.00");
  assert.equal(formatMoney(10000000000, "USD", "en"), "$100,000,000.00");
});

test("uses English when the language is unavailable", () => {
  assert.equal(formatMoney(1050, "USD", undefined), "$10.50");
});

test("rejects fractional, non-finite and unsafe minor units", () => {
  for (const amount of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatMoney(amount, "USD", "en"), RangeError);
  }
});
