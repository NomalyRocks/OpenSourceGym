import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRecordWeightChange } from "./weightHistory.js";

test("önceki kayıt yoksa kaydedilir", () => {
  assert.equal(shouldRecordWeightChange(null, 80), true);
});

test("değer değişmemişse kaydedilmez", () => {
  assert.equal(shouldRecordWeightChange(80, 80), false);
});

test("değer değişmişse kaydedilir", () => {
  assert.equal(shouldRecordWeightChange(80, 79.5), true);
  assert.equal(shouldRecordWeightChange(79.5, 80), true);
});
