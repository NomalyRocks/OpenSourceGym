import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEV_INITIAL_ADMIN_PASSWORD,
  INITIAL_ADMIN_PASSWORD_MIN_LENGTH,
  resolveInitialAdminPasswordFrom,
} from "./initialAdmin.js";

const OPERATOR_PASSWORD = "wY3n-Qk8sTz2Lp0v";

describe("resolveInitialAdminPasswordFrom", () => {
  it("falls back to the fixed development password outside production", () => {
    assert.equal(
      resolveInitialAdminPasswordFrom({
        nodeEnv: "development",
        supplied: undefined,
      }),
      DEV_INITIAL_ADMIN_PASSWORD,
    );
  });

  it("prefers a supplied password outside production", () => {
    assert.equal(
      resolveInitialAdminPasswordFrom({
        nodeEnv: "development",
        supplied: OPERATOR_PASSWORD,
      }),
      OPERATOR_PASSWORD,
    );
  });

  it("refuses to seed a production admin without a configured password", () => {
    assert.throws(
      () =>
        resolveInitialAdminPasswordFrom({
          nodeEnv: "production",
          supplied: undefined,
        }),
      /INITIAL_ADMIN_PASSWORD must be set in production/,
    );
  });

  it("rejects the development default in production", () => {
    assert.throws(
      () =>
        resolveInitialAdminPasswordFrom({
          nodeEnv: "production",
          supplied: DEV_INITIAL_ADMIN_PASSWORD,
        }),
      /must not be the development default/,
    );
  });

  it("rejects a production password below the minimum length", () => {
    assert.throws(
      () =>
        resolveInitialAdminPasswordFrom({
          nodeEnv: "production",
          supplied: "x".repeat(INITIAL_ADMIN_PASSWORD_MIN_LENGTH - 1),
        }),
      /at least 12 characters/,
    );
  });

  it("accepts an operator-supplied production password", () => {
    assert.equal(
      resolveInitialAdminPasswordFrom({
        nodeEnv: "production",
        supplied: OPERATOR_PASSWORD,
      }),
      OPERATOR_PASSWORD,
    );
  });

  it("never returns a password that is hardcoded for production use", () => {
    // Guards the whole point of the hardening: no production code path may hand
    // back a credential that is visible in this repository.
    assert.notEqual(
      resolveInitialAdminPasswordFrom({
        nodeEnv: "production",
        supplied: OPERATOR_PASSWORD,
      }),
      DEV_INITIAL_ADMIN_PASSWORD,
    );
  });
});
