import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { env } from "../../../../src/core/env.js";
import {
  gateQrContent,
  sidedGateQrContent,
  verifyGateQr,
} from "../../../../src/features/gate/gateQr.js";

test("generated static QR content is verified and returns the deviceId", () => {
  const deviceId = new ObjectId().toString();
  const content = gateQrContent(deviceId);
  const result = verifyGateQr(content);
  assert.deepEqual(result, { ok: true, deviceId, side: null });
});

test("legacy QR content preserves the original signature input and three-part format", () => {
  const deviceId = new ObjectId().toString();
  const key = createHmac("sha256", env.betterAuthSecret)
    .update("opengym-gate-v1")
    .digest();
  const signature = createHmac("sha256", key)
    .update(deviceId)
    .digest("base64url");
  const content = `OGGATE1.${deviceId}.${signature}`;
  assert.equal(gateQrContent(deviceId), content);
  assert.deepEqual(verifyGateQr(content), { ok: true, deviceId, side: null });
});

for (const side of ["in", "out"] as const) {
  test(`sided QR round-trip returns the ${side} side`, () => {
    const deviceId = new ObjectId().toString();
    const content = sidedGateQrContent(deviceId, side);
    assert.equal(content.split(".").length, 4);
    assert.deepEqual(verifyGateQr(content), { ok: true, deviceId, side });
  });

  test(`rejects a sided QR whose ${side} side is tampered with`, () => {
    const deviceId = new ObjectId().toString();
    const [prefix, id, , signature] = sidedGateQrContent(deviceId, side).split(
      ".",
    );
    const tampered = `${prefix}.${id}.${side === "in" ? "out" : "in"}.${signature}`;
    assert.deepEqual(verifyGateQr(tampered), { ok: false });
  });

  test(`rejects a legacy signature reused for side ${side}`, () => {
    const deviceId = new ObjectId().toString();
    const [prefix, id, signature] = gateQrContent(deviceId).split(".");
    assert.deepEqual(verifyGateQr(`${prefix}.${id}.${side}.${signature}`), {
      ok: false,
    });
    assert.deepEqual(verifyGateQr(`${prefix}.${id}.${signature}.${side}`), {
      ok: false,
    });
  });

  test(`rejects a sided ${side} signature reused in a legacy QR`, () => {
    const deviceId = new ObjectId().toString();
    const [prefix, id, , signature] = sidedGateQrContent(deviceId, side).split(
      ".",
    );
    assert.deepEqual(verifyGateQr(`${prefix}.${id}.${signature}`), {
      ok: false,
    });
  });
}

test("rejects an unknown QR side", () => {
  const deviceId = new ObjectId().toString();
  const [prefix, id, , signature] = sidedGateQrContent(deviceId, "in").split(
    ".",
  );
  for (const side of ["both", "entry", ""]) {
    assert.deepEqual(verifyGateQr(`${prefix}.${id}.${side}.${signature}`), {
      ok: false,
    });
  }
});

test("QR content is deterministic for the same device (static, no expiry)", () => {
  const deviceId = new ObjectId().toString();
  assert.equal(gateQrContent(deviceId), gateQrContent(deviceId));
});

test("rejects a QR with a tampered signature", () => {
  const deviceId = new ObjectId().toString();
  const [prefix, id] = gateQrContent(deviceId).split(".");
  const tampered = `${prefix}.${id}.deadbeef`;
  assert.deepEqual(verifyGateQr(tampered), { ok: false });
});

test("rejects content with the wrong prefix", () => {
  const deviceId = new ObjectId().toString();
  const content = gateQrContent(deviceId).replace("OGGATE1", "OG1");
  assert.deepEqual(verifyGateQr(content), { ok: false });
});

test("rejects content containing an invalid ObjectId", () => {
  assert.deepEqual(verifyGateQr("OGGATE1.not-an-object-id.sig"), {
    ok: false,
  });
});

test("a signature from another device is invalid for this device", () => {
  const deviceA = new ObjectId().toString();
  const deviceB = new ObjectId().toString();
  const [prefix, , sigA] = gateQrContent(deviceA).split(".");
  const forged = `${prefix}.${deviceB}.${sigA}`;
  assert.deepEqual(verifyGateQr(forged), { ok: false });
});
