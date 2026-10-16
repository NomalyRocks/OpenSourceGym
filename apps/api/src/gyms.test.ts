import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canAccessGym, isChainWide } from "./gyms.js";

describe("canAccessGym", () => {
  it("lets the owner into every gym", () => {
    assert.equal(canAccessGym({ role: "owner", gymIds: [] }, "g1"), true);
  });

  it("limits admin and staff to their gymIds", () => {
    for (const role of ["admin", "staff"] as const) {
      assert.equal(canAccessGym({ role, gymIds: ["g1"] }, "g1"), true);
      assert.equal(canAccessGym({ role, gymIds: ["g1"] }, "g2"), false);
      assert.equal(canAccessGym({ role, gymIds: [] }, "g1"), false);
    }
  });

  it("never grants admin access to members", () => {
    assert.equal(canAccessGym({ role: "member", gymIds: ["g1"] }, "g1"), false);
  });
});

describe("isChainWide", () => {
  it("is true for the owner only", () => {
    assert.equal(isChainWide("owner"), true);
    assert.equal(isChainWide("admin"), false);
  });
});
