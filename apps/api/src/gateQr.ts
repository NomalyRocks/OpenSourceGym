import { createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { env } from "./env.js";

const GATE_QR_PREFIX = "OGGATE1";

// Static turnstile QR signing key—derived from the server secret, not stored separately
const gateQrKey = createHmac("sha256", env.betterAuthSecret)
  .update("opengym-gate-v1")
  .digest();

function sign(deviceId: string): string {
  return createHmac("sha256", gateQrKey).update(deviceId).digest("base64url");
}

// Generates printable, fixed (non-expiring) QR content for the device
export function gateQrContent(deviceId: string): string {
  return `${GATE_QR_PREFIX}.${deviceId}.${sign(deviceId)}`;
}

export type GateQrVerifyResult = { ok: true; deviceId: string } | { ok: false };

// Verifies the signature of the static turnstile QR scanned by the member
export function verifyGateQr(content: string): GateQrVerifyResult {
  const parts = content.split(".");
  if (parts.length !== 3 || parts[0] !== GATE_QR_PREFIX) {
    return { ok: false };
  }
  const [, deviceId, signature] = parts;
  if (!deviceId || !signature || !ObjectId.isValid(deviceId)) {
    return { ok: false };
  }

  const expectedSignature = sign(deviceId);
  const sigBuf = Buffer.from(signature, "base64url");
  const expectedBuf = Buffer.from(expectedSignature, "base64url");
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return { ok: false };
  }

  return { ok: true, deviceId };
}
