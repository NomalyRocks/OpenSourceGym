import { Platform } from "react-native";
import * as Application from "expo-application";
import * as Device from "expo-device";
import * as Crypto from "expo-crypto";

const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

let fingerprintPromise: Promise<string | null> | null = null;

async function computeFingerprint(): Promise<string | null> {
  try {
    let stableId: string | null = null;
    if (Platform.OS === "android") {
      stableId = Application.getAndroidId();
    } else if (Platform.OS === "ios") {
      stableId = await Application.getIosIdForVendorAsync();
    } else {
      // Fingerprinting is unsupported on other platforms such as web.
      return null;
    }
    if (!stableId) return null;

    const raw = `${Platform.OS}:${stableId}:${Device.modelId ?? Device.modelName ?? ""}`;
    // Raw device identifiers never leave this function; only the hash is sent.
    const digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      raw,
    );
    const hex = digest.toLowerCase();
    return FINGERPRINT_RE.test(hex) ? hex : null;
  } catch {
    // Never block the app if fingerprint generation fails.
    return null;
  }
}

/**
 * Generates a device-specific, irreversible fingerprint (SHA-256 hex).
 * A successful result is cached for the app session; `null` (temporary error,
 * permission issue, etc.) is NOT cached, so the next call retries.
 * Returns `null` on failure (fail-open); callers must treat it as optional.
 */
export function getDeviceFingerprint(): Promise<string | null> {
  if (!fingerprintPromise) {
    fingerprintPromise = computeFingerprint().then((fp) => {
      if (fp === null) fingerprintPromise = null;
      return fp;
    });
  }
  return fingerprintPromise;
}
