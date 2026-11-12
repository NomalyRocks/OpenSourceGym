import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import {
  inactiveMembersQuerySchema,
  inactiveMemberRow,
  lostMembersQuerySchema,
} from "../../../../src/features/reports/lostMembers.js";
import { decodeCursor, encodeCursor } from "../../../../src/lib/pagination.js";

const DAY = 86_400_000;

test("inactive threshold defaults to 14 and accepts only whole days from 1 through 365", () => {
  assert.equal(inactiveMembersQuerySchema.parse({}).days, 14);
  for (const days of ["1", "7", "14", "30", "60", "365"]) {
    assert.equal(inactiveMembersQuerySchema.parse({ days }).days, Number(days));
  }
  for (const days of ["0", "366", "-1", "1.5", "abc", "", ["7", "14"]]) {
    assert.equal(inactiveMembersQuerySchema.safeParse({ days }).success, false);
  }
});

test("lost-member pagination supports numbered pages or the existing cursor contract", () => {
  assert.equal(
    lostMembersQuerySchema.parse({ page: "2", limit: "10" }).page,
    2,
  );
  for (const query of [
    { page: "0" },
    { page: "1.5" },
    { limit: "101" },
    { cursor: "" },
    { cursor: "opaque", page: "2" },
  ]) {
    assert.equal(lostMembersQuerySchema.safeParse(query).success, false);
  }
  const at = new Date(-8_640_000_000_000_000);
  const id = new ObjectId();
  assert.deepEqual(decodeCursor(encodeCursor(at, id)), { at, id });
});

test("inactive rows distinguish never visited from elapsed whole days", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const base = {
    _id: new ObjectId(),
    sortAt: now,
    periodEndsAt: new Date(now.getTime() + DAY),
    latestEnd: now,
    member: {
      firstName: "Member",
      lastName: "Tester",
      email: "member@example.com",
      phone: "5551234567",
    },
  };
  const never = inactiveMemberRow({ ...base, lastEntryAt: null }, now);
  assert.equal(never.lastEntryAt, null);
  assert.equal(never.daysSinceLastEntry, null);
  assert.equal(never.name, "Member Tester");
  assert.equal(never.userId, base._id.toHexString());
  const visited = inactiveMemberRow(
    { ...base, lastEntryAt: new Date(now.getTime() - 14.9 * DAY) },
    now,
  );
  assert.equal(visited.daysSinceLastEntry, 14);
  assert.equal(visited.periodEndsAt, base.periodEndsAt.toISOString());
});
