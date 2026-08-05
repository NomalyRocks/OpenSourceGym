import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRecordWeightChange } from "./weightHistory.js";

test("records when there is no previous value", () => {
  assert.equal(shouldRecordWeightChange(null, 80), true);
});

test("does not record when the value is unchanged", () => {
  assert.equal(shouldRecordWeightChange(80, 80), false);
});

test("records when the value changes", () => {
  assert.equal(shouldRecordWeightChange(80, 79.5), true);
  assert.equal(shouldRecordWeightChange(79.5, 80), true);
});
