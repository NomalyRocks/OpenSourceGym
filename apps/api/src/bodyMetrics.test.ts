import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertValidBodyMetricsUpdate,
  buildBodyMetricsUpdate,
  InvalidBodyMetricError,
} from "./bodyMetrics.js";

test("leaves a field unchanged when it is absent from the request", () => {
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({}));
});

test("accepts null fields for clearing", () => {
  assert.doesNotThrow(() =>
    assertValidBodyMetricsUpdate({ age: null, heightCm: null, weightKg: null }),
  );
});

test("accepts age, height, and weight within range", () => {
  assert.doesNotThrow(() =>
    assertValidBodyMetricsUpdate({ age: 30, heightCm: 180, weightKg: 80 }),
  );
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({ age: 18 }));
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({ age: 80 }));
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({ heightCm: 120 }));
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({ heightCm: 230 }));
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({ weightKg: 35 }));
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({ weightKg: 300 }));
});

test("rejects out-of-range or fractional age", () => {
  assert.throws(
    () => assertValidBodyMetricsUpdate({ age: 17 }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ age: 81 }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ age: 30.5 }),
    InvalidBodyMetricError,
  );
});

test("rejects out-of-range height", () => {
  assert.throws(
    () => assertValidBodyMetricsUpdate({ heightCm: 119 }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ heightCm: 231 }),
    InvalidBodyMetricError,
  );
});

test("rejects out-of-range weight", () => {
  assert.throws(
    () => assertValidBodyMetricsUpdate({ weightKg: 34.9 }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ weightKg: 301 }),
    InvalidBodyMetricError,
  );
});

test("rejects non-numeric or non-finite values", () => {
  assert.throws(
    () => assertValidBodyMetricsUpdate({ heightCm: "180" }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ weightKg: Number.NaN }),
    InvalidBodyMetricError,
  );
});

test("excludes omitted fields from the update", () => {
  const { set, unset } = buildBodyMetricsUpdate({ weightKg: 82 });
  assert.deepEqual(set, { weightKg: 82 });
  assert.deepEqual(unset, {});
});

test("clears null fields and writes numeric fields", () => {
  const { set, unset } = buildBodyMetricsUpdate({
    age: 30,
    heightCm: null,
    weightKg: 82.5,
  });
  assert.deepEqual(set, { age: 30, weightKg: 82.5 });
  assert.deepEqual(unset, { heightCm: "" });
});

test("an empty body leaves all fields unchanged", () => {
  const { set, unset } = buildBodyMetricsUpdate({});
  assert.deepEqual(set, {});
  assert.deepEqual(unset, {});
});
