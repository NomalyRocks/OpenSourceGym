import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoney, moneyInputValue, parseMoney } from "./money";

test("parses local and plain amounts into integer minor units", () => {
  for (const [input, expected] of [
    ["1250", 125000],
    ["1.250,50", 125050],
    ["1250.5", 125050],
    ["1 250,50", 125050],
    ["0", 0],
    ["0.01", 1],
    ["1.234.567,89", 123456789],
    ["1\u00a0250,50", 125050],
    ["100000000.00", 10000000000],
  ] as const) {
    assert.equal(parseMoney(input), expected, input);
  }
});

test("rejects junk, negatives, invalid grouping, precision loss and extra decimals", () => {
  for (const input of [
    "",
    " ",
    "-1",
    "+1",
    "1e3",
    "12x",
    "1.234",
    "1,234",
    "1.2.3",
    "1,2,3",
    "1.",
    ".5",
    "1 25",
    "1.250 000,50",
    "90071992547409.92",
  ]) {
    assert.equal(parseMoney(input), null, input);
  }
});

test("formats currencies using the requested locale and round trips integer amounts", () => {
  assert.equal(
    formatMoney(125050, "TRY", "tr-TR"),
    new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency: "TRY",
    }).format(1250.5),
  );
  assert.equal(formatMoney(1, "USD", "en-US"), "$0.01");
  for (const minor of [0, 1, 29, 125050, 10000000000])
    assert.equal(parseMoney(moneyInputValue(minor)), minor);
});
