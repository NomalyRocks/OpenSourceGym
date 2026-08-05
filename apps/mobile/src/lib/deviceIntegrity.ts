import * as Device from "expo-device";

export type DeviceIntegrityResult = {
  compromised: boolean;
  reasons: string[];
};

// Enabled by default in production builds and disabled by default under __DEV__
// (to prevent emulator/Expo Go false positives). Override with EXPO_PUBLIC_ANTI_DEBUG=1/0.
const enabled =
  (process.env.EXPO_PUBLIC_ANTI_DEBUG ?? (__DEV__ ? "0" : "1")) === "1";

export async function checkDeviceIntegrity(): Promise<DeviceIntegrityResult> {
  if (!enabled) {
    return { compromised: false, reasons: [] };
  }

  const reasons: string[] = [];

  try {
    if (await Device.isRootedExperimentalAsync()) {
      reasons.push("root");
    }
  } catch {
    // The check failed—do not treat it as a positive signal (fail-open).
  }

  try {
    if (!Device.isDevice) {
      reasons.push("emulator");
    }
  } catch {
    // The check failed—do not treat it as a positive signal (fail-open).
  }

  try {
    if (__DEV__) {
      reasons.push("dev-bundle");
    }
  } catch {
    // The check failed—do not treat it as a positive signal (fail-open).
  }

  return { compromised: reasons.length > 0, reasons };
}
