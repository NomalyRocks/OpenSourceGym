import { createAuthClient } from "better-auth/react";
import {
  emailOTPClient,
  inferAdditionalFields,
} from "better-auth/client/plugins";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import { API_URL } from "./config";

export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [
    emailOTPClient(),
    // Sunucudaki auth.ts additionalFields ile elle senkron: paketler arası
    // çalışma zamanı kodu paylaşılmıyor, yalnızca updateUser() için tip.
    inferAdditionalFields({
      user: {
        age: { type: "number", required: false },
        heightCm: { type: "number", required: false },
        weightKg: { type: "number", required: false },
      },
    }),
    expoClient({
      scheme: "opengym",
      storagePrefix: "opengym",
      storage: SecureStore,
    }),
  ],
});
