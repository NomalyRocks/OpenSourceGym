import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceDirection, DeviceMode } from "@opengym/shared";
import { resolveScanDirection } from "../../../../src/features/gate/scanDirection.js";

const cases: {
  mode: DeviceMode;
  side: DeviceDirection | null;
  expected: DeviceDirection | null;
}[] = [
  { mode: "in", side: null, expected: "in" },
  { mode: "out", side: null, expected: "out" },
  { mode: "both", side: null, expected: null },
  { mode: "in", side: "in", expected: null },
  { mode: "in", side: "out", expected: null },
  { mode: "out", side: "in", expected: null },
  { mode: "out", side: "out", expected: null },
  { mode: "both", side: "in", expected: "in" },
  { mode: "both", side: "out", expected: "out" },
];

for (const { mode, side, expected } of cases) {
  test(`mode ${mode} with ${side === null ? "legacy QR" : `sided ${side} QR`} resolves to ${expected ?? "refusal"}`, () => {
    assert.equal(resolveScanDirection(mode, side), expected);
  });
}
