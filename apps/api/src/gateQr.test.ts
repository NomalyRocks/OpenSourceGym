import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { gateQrContent, verifyGateQr } from "./gateQr.js";

test("generated static QR content is verified and returns the deviceId", () => {
  const deviceId = new ObjectId().toString();
  const content = gateQrContent(deviceId);
  const result = verifyGateQr(content);
  assert.deepEqual(result, { ok: true, deviceId });
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
