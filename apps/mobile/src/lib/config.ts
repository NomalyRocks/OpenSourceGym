import Constants from "expo-constants";

/**
 * API address resolution:
 * 1. EXPO_PUBLIC_API_URL environment variable (takes precedence)
 * 2. Address of the machine running Metro (hostUri) + API port—works for
 *    physical devices and emulators on the LAN
 * 3. localhost (adb reverse tcp:3000 tcp:3000 gerektirir)
 */
const devHost = Constants.expoConfig?.hostUri?.split(":")[0];

function resolveApiUrl(): string {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL;

  if (__DEV__) {
    const developmentUrl =
      configuredUrl ??
      (devHost ? `http://${devHost}:3000` : "http://localhost:3000");

    return developmentUrl.replace(/\/+$/, "");
  }

  if (!configuredUrl) {
    throw new Error(
      "EXPO_PUBLIC_API_URL must be defined in production builds.",
    );
  }

  if (!configuredUrl.startsWith("https://")) {
    throw new Error(
      "EXPO_PUBLIC_API_URL must start with https:// in production builds.",
    );
  }

  return configuredUrl.replace(/\/+$/, "");
}

export const API_URL = resolveApiUrl();
