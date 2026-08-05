import assert from "node:assert/strict";
import test from "node:test";
import { parseUserSearchQuery, tokenizeUserSearchQuery } from "./userSearch.js";

test("member search accepts at least two characters", () => {
  assert.equal(parseUserSearchQuery(undefined), null);
  assert.equal(parseUserSearchQuery(" a "), null);
  assert.equal(parseUserSearchQuery("  ay  "), "ay");
});

test("member search splits the query into whitespace-separated terms", () => {
  assert.deepEqual(tokenizeUserSearchQuery("  Ayşe\t Yılmaz  "), [
    "Ayşe",
    "Yılmaz",
  ]);
});
