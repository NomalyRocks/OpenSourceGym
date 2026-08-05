import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import {
  isLanguage,
  LANGUAGE_STORAGE_KEY,
  resolveLanguage,
  type Language,
} from "./core";
import { resources } from "./resources";

let initialized = false;
let manualLanguage = false;

function deviceLanguages(): string[] {
  return getLocales().map((locale) => locale.languageTag);
}

async function readStoredLanguage(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

// Components using `useTranslation()` may be created during the first React
// render, before `useEffect` runs. Because resources are bundled with the app,
// initialize i18next synchronously here and register the react-i18next instance
// before rendering begins. The user's SecureStore preference is applied below.
void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(null, deviceLanguages()),
  fallbackLng: "en",
  supportedLngs: ["tr", "en"],
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  initAsync: false,
});
initialized = true;

export async function initializeLocalization(): Promise<void> {
  const stored = await readStoredLanguage();
  manualLanguage = isLanguage(stored);
  const language = resolveLanguage(stored, deviceLanguages());

  if (language !== i18n.language) {
    await i18n.changeLanguage(language);
  }
}

export async function setLanguage(language: Language): Promise<void> {
  manualLanguage = true;
  await i18n.changeLanguage(language);
  try {
    await SecureStore.setItemAsync(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The selection still applies for the current process if storage fails.
  }
}

export async function syncDeviceLanguage(): Promise<void> {
  if (!initialized || manualLanguage) return;
  await i18n.changeLanguage(resolveLanguage(null, deviceLanguages()));
}

export { i18n };
