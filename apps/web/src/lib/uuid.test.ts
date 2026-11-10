import assert from "node:assert/strict";
import { test } from "node:test";
import { uuid } from "./uuid";

test("uses native randomUUID with its crypto receiver", () => {
  const source = {
    randomUUID() {
      assert.equal(this, source);
      return "d11aca35-22db-42e8-b094-4b2de67b1f48";
    },
    getRandomValues() {
      assert.fail("native UUID should not use the fallback");
    },
  } as unknown as Crypto;
  assert.equal(uuid(source), "d11aca35-22db-42e8-b094-4b2de67b1f48");
});

test("fallback preserves random bytes and sets RFC 4122 v4 version and variant", () => {
  for (const byte of [0, 0xff]) {
    const source = {
      getRandomValues(bytes: Uint8Array) {
        assert.equal(this, source);
        assert.equal(bytes.length, 16);
        return bytes.fill(byte);
      },
    } as unknown as Crypto;
    const result = uuid(source);
    assert.match(
      result,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      result,
      byte === 0
        ? "00000000-0000-4000-8000-000000000000"
        : "ffffffff-ffff-4fff-bfff-ffffffffffff",
    );
  }
});
