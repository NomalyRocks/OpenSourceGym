import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canManageMember } from "./memberScope.js";

const GYM_A = "a".repeat(24);
const GYM_B = "b".repeat(24);

describe("member control scope", () => {
  it("lets the owner manage any member, even one with no periods", () => {
    assert.equal(canManageMember({ role: "owner", gymIds: [] }, []), true);
    assert.equal(canManageMember({ role: "owner", gymIds: [] }, [GYM_B]), true);
  });

  it("lets an admin manage a member who has a period at one of their gyms", () => {
    assert.equal(
      canManageMember({ role: "admin", gymIds: [GYM_A] }, [GYM_B, GYM_A]),
      true,
    );
  });

  it("refuses a member whose periods are all at other gyms", () => {
    assert.equal(
      canManageMember({ role: "staff", gymIds: [GYM_A] }, [GYM_B]),
      false,
    );
  });

  it("refuses a non-owner for a member with no periods at all", () => {
    assert.equal(
      canManageMember({ role: "admin", gymIds: [GYM_A] }, []),
      false,
    );
  });
});
