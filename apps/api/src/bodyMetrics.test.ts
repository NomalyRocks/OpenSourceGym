import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertValidBodyMetricsUpdate,
  buildBodyMetricsUpdate,
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

test("gönderilmeyen alan güncellemeye girmez", () => {
  const { set, unset } = buildBodyMetricsUpdate({ weightKg: 82 });
  assert.deepEqual(set, { weightKg: 82 });
  assert.deepEqual(unset, {});
});

test("null gönderilen alan temizlenir, sayı olan yazılır", () => {
  const { set, unset } = buildBodyMetricsUpdate({
    age: 30,
    heightCm: null,
    weightKg: 82.5,
  });
  assert.deepEqual(set, { age: 30, weightKg: 82.5 });
  assert.deepEqual(unset, { heightCm: "" });
});

test("boş gövde hiçbir alana dokunmaz", () => {
  const { set, unset } = buildBodyMetricsUpdate({});
  assert.deepEqual(set, {});
  assert.deepEqual(unset, {});
});
