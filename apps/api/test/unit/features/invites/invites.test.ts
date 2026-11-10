import assert from "node:assert/strict";
import test from "node:test";
import { redis } from "../../../../src/core/redis.js";
import {
  hashInviteToken,
  inviteResendWaitMs,
  INVITE_LIFETIME_MS,
  isInviteRateLimited,
  newInviteToken,
  withInviteLock,
  type MemberInviteDocument,
} from "../../../../src/features/invites/invites.js";
import {
  acceptInviteSchema,
  createInviteSchema,
} from "../../../../src/features/invites/schemas.js";

test("invite tokens are 32 random bytes, URL safe, and represented by SHA-256 hashes", () => {
  const first = newInviteToken();
  const second = newInviteToken();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.token, "base64url").length, 32);
  assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(hashInviteToken(first.token), first.tokenHash);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, second.tokenHash);
  assert.equal(INVITE_LIFETIME_MS, 7 * 24 * 3600 * 1000);
});

test("invite input requires contact details, both explicit consents and the signup password policy", () => {
  const contact = {
    email: "  MEMBER@Example.com ",
    firstName: " Alex ",
    lastName: " Test ",
    phone: "539 123 45 67",
  };
  assert.deepEqual(createInviteSchema.parse(contact), {
    ...contact,
    email: "member@example.com",
    firstName: "Alex",
    lastName: "Test",
  });
  assert.equal(
    createInviteSchema.safeParse({ ...contact, phone: undefined }).success,
    false,
  );
  const body = {
    token: newInviteToken().token,
    password: "12345678",
    dataProcessingAccepted: true,
    privacyAccepted: true,
    legalVersion: 1,
  };
  assert.equal(acceptInviteSchema.safeParse(body).success, true);
  for (const field of ["dataProcessingAccepted", "privacyAccepted"] as const) {
    assert.equal(
      acceptInviteSchema.safeParse({ ...body, [field]: false }).success,
      false,
    );
    assert.equal(
      acceptInviteSchema.safeParse({ ...body, [field]: "true" }).success,
      false,
    );
  }
  assert.equal(
    acceptInviteSchema.safeParse({ ...body, password: "1234567" }).success,
    false,
  );
  assert.equal(
    acceptInviteSchema.safeParse({ ...body, password: "a".repeat(129) })
      .success,
    false,
  );
});

test("resend spacing includes the original send and expires exactly at sixty seconds", () => {
  const start = new Date("2026-11-10T12:00:00Z");
  const invite = { createdAt: start, resentAt: null } as MemberInviteDocument;
  assert.equal(inviteResendWaitMs(invite, start), 60_000);
  assert.equal(inviteResendWaitMs(invite, new Date(+start + 59_999)), 1);
  assert.equal(inviteResendWaitMs(invite, new Date(+start + 60_000)), 0);
  invite.resentAt = new Date(+start + 90_000);
  assert.equal(inviteResendWaitMs(invite, new Date(+start + 100_000)), 50_000);
});

test("invite counters use one atomic expiring Redis operation and reject the twenty-first request", async (t) => {
  let calls = 0;
  t.mock.method(
    redis,
    "eval",
    async (
      script: string,
      options: { keys: string[]; arguments: string[] },
    ) => {
      assert.match(script, /"NX", "EX"/);
      assert.match(script, /"incr"/);
      assert.deepEqual(options, {
        keys: ["og:invite-create:actor"],
        arguments: ["3600"],
      });
      return ++calls;
    },
  );
  for (let i = 0; i < 20; i++)
    assert.equal(
      await isInviteRateLimited("og:invite-create:actor", 3600),
      false,
    );
  assert.equal(await isInviteRateLimited("og:invite-create:actor", 3600), true);
});

test("an in-flight invite lock rejects a second consumer and is released after failure", async (t) => {
  let owner: string | null = null;
  t.mock.method(redis, "set", async (_key: string, token: string) => {
    if (owner) return null;
    owner = token;
    return "OK";
  });
  t.mock.method(
    redis,
    "eval",
    async (_script: string, options: { arguments: string[] }) => {
      if (owner === options.arguments[0]) owner = null;
      return 1;
    },
  );
  await assert.rejects(
    withInviteLock("hash", async () => {
      assert.equal(await withInviteLock("hash", async () => "duplicate"), null);
      throw new Error("Signup failed");
    }),
    /Signup failed/,
  );
  assert.equal(owner, null);
  assert.equal(await withInviteLock("hash", async () => "retried"), "retried");
});
