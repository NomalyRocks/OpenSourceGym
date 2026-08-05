import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidPhoneNumberError,
  normalizePhoneToE164,
  tryNormalizePhoneToE164,
} from "./phone.js";
import { planLegacyPhoneBackfill } from "./phoneBackfillPlan.js";

test("common Turkish phone formats normalize to the same E.164 value", () => {
  for (const input of [
    "5301234567",
    "05301234567",
    "+905301234567",
    "(0530) 123 45 67",
  ]) {
    assert.equal(normalizePhoneToE164(input), "+905301234567");
  }
});

test("preserves a valid international number with a plus sign", () => {
  assert.equal(normalizePhoneToE164("+1 213 373 4253"), "+12133734253");
});

test("rejects invalid numbers and extraction from text", () => {
  for (const input of [
    "",
    "123",
    "+999123456",
    "Beni 05301234567 ara",
  ] as const) {
    assert.throws(() => normalizePhoneToE164(input), InvalidPhoneNumberError);
    assert.equal(tryNormalizePhoneToE164(input), null);
  }
});

test("assigns unique legacy phones and reports duplicates unchanged", () => {
  const plan = planLegacyPhoneBackfill([
    { userId: "unique", phone: "05301234567" },
    { userId: "duplicate-a", phone: "532 123 45 67" },
    { userId: "duplicate-b", phone: "+90 532 123 45 67" },
    { userId: "invalid", phone: "-" },
    { userId: "seed", phone: "-", exempt: true },
  ]);

  assert.deepEqual(plan.assignments, [
    { userId: "unique", phoneE164: "+905301234567" },
  ]);
  assert.deepEqual(plan.conflicts, [
    {
      phoneE164: "+905321234567",
      users: [{ userId: "duplicate-a" }, { userId: "duplicate-b" }],
    },
  ]);
  assert.deepEqual(plan.invalidUserIds, ["invalid"]);
});

test("a previously normalized unique document is unchanged on the second run", () => {
  assert.deepEqual(
    planLegacyPhoneBackfill([
      {
        userId: "normalized",
        phone: "+905301234567",
        phoneE164: "+905301234567",
      },
    ]),
    { assignments: [], conflicts: [], invalidUserIds: [] },
  );
});
