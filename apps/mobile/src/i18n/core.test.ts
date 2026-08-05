import assert from "node:assert/strict";
import test from "node:test";
import { resolveLanguage } from "./core";
import { resources } from "./resources";

test("stored language takes precedence over device preferences", () => {
  assert.equal(resolveLanguage("tr", ["en-US"]), "tr");
  assert.equal(resolveLanguage("en", ["tr-TR"]), "en");
});

test("selects the first supported device language", () => {
  assert.equal(resolveLanguage(null, ["de-DE", "tr-TR", "en-US"]), "tr");
  assert.equal(resolveLanguage(null, ["fr-FR", "en-GB"]), "en");
});

test("falls back to English for invalid or unsupported preferences", () => {
  assert.equal(resolveLanguage("de", ["fr-FR"]), "en");
  assert.equal(resolveLanguage(null, []), "en");
});

test("Turkish and English resources contain the same keys", () => {
  assert.deepEqual(
    Object.keys(resources.tr.translation).sort(),
    Object.keys(resources.en.translation).sort(),
  );
});
