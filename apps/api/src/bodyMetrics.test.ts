import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertValidBodyMetricsUpdate,
  InvalidBodyMetricError,
} from "./bodyMetrics.js";

test("alan istekte yoksa dokunmaz", () => {
  assert.doesNotThrow(() => assertValidBodyMetricsUpdate({}));
});

test("alan null ise dokunmaz (temizleme)", () => {
  assert.doesNotThrow(() =>
    assertValidBodyMetricsUpdate({ age: null, heightCm: null, weightKg: null }),
  );
});

test("aralık içindeki yaş, boy ve kilo kabul edilir", () => {
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

test("aralık dışındaki veya kesirli yaş reddedilir", () => {
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

test("aralık dışındaki boy reddedilir", () => {
  assert.throws(
    () => assertValidBodyMetricsUpdate({ heightCm: 119 }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ heightCm: 231 }),
    InvalidBodyMetricError,
  );
});

test("aralık dışındaki kilo reddedilir", () => {
  assert.throws(
    () => assertValidBodyMetricsUpdate({ weightKg: 34.9 }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ weightKg: 301 }),
    InvalidBodyMetricError,
  );
});

test("sayısal olmayan veya sonsuz değerler reddedilir", () => {
  assert.throws(
    () => assertValidBodyMetricsUpdate({ heightCm: "180" }),
    InvalidBodyMetricError,
  );
  assert.throws(
    () => assertValidBodyMetricsUpdate({ weightKg: Number.NaN }),
    InvalidBodyMetricError,
  );
});
