import assert from "node:assert/strict";
import test from "node:test";
import { legalDocumentUrlSchema } from "./legalUrl.js";

test("legal document URL schema accepts only HTTP(S) addresses", () => {
  assert.equal(
    legalDocumentUrlSchema.safeParse("https://example.com/privacy").success,
    true,
  );
  assert.equal(
    legalDocumentUrlSchema.safeParse("http://example.com/data-processing")
      .success,
    true,
  );

  for (const url of [
    "mailto:legal@example.com",
    "data:text/html,document",
    "javascript:alert(1)",
  ]) {
    assert.equal(legalDocumentUrlSchema.safeParse(url).success, false, url);
  }
});
