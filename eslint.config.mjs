import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // agents/: device-side reference code (RPi/ESP32/sim), outside the workspace
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "agents/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/mobile/plugins/**/*.js"],
    languageOptions: {
      globals: { module: "readonly", require: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
