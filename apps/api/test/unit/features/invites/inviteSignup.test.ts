import assert from "node:assert/strict";
import test from "node:test";
import { Collection } from "mongodb";
import { auth, runAsInviteSignup } from "../../../../src/auth/auth.js";
import { redis } from "../../../../src/core/redis.js";

const otp = auth.options.plugins!.find((plugin) => plugin.id === "email-otp")!;
const signupHook = otp.hooks!.after![0]!;
const signupContext = { path: "/sign-up/email" } as never;

test("only a server-scoped invite signup suppresses the OTP hook, without changing session policy", async () => {
  assert.equal(signupHook.matcher(signupContext), true);
  assert.equal(auth.options.emailAndPassword?.requireEmailVerification, true);
  await runAsInviteSignup(4, async () => {
    await Promise.resolve();
    assert.equal(signupHook.matcher(signupContext), false);
  });
  assert.equal(signupHook.matcher(signupContext), true);
  assert.equal(
    signupHook.matcher({
      path: "/sign-up/email",
      body: { invite: true, skipVerification: true },
      headers: new Headers({ "x-invite-signup": "true" }),
    } as never),
    true,
  );
});

test("a failing invite signup restores ordinary OTP behavior and never disables a concurrent signup", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invited = runAsInviteSignup(4, async () => {
    await held;
    assert.equal(signupHook.matcher(signupContext), false);
    throw new Error("Phone already used");
  });
  assert.equal(signupHook.matcher(signupContext), true);
  release();
  await assert.rejects(invited, /Phone already used/);
  assert.equal(signupHook.matcher(signupContext), true);
});

test("normal and invited signup hooks stamp the current legal version and require both consents", async (t) => {
  t.mock.method(
    Collection.prototype,
    "findOne",
    async function (this: Collection) {
      return this.collectionName === "settings"
        ? { _id: "chain", legal: { version: 7 } }
        : null;
    },
  );
  // The hook reserves the phone in Redis; unit tests run without a server.
  t.mock.method(redis, "set", async () => "OK");
  const before = auth.options.databaseHooks!.user!.create!.before!;
  const candidate = {
    name: "Alex Member",
    email: "new-member@example.com",
    firstName: "Alex",
    lastName: "Member",
    phone: "539 123 45 67",
    dataProcessingAccepted: true,
    privacyAccepted: true,
    legalVersionAccepted: 999,
  };
  const normal = await before(candidate as never);
  assert.ok(normal && normal.data);
  assert.equal(normal.data.legalVersionAccepted, 7);
  assert.equal(normal.data.phone, "+905391234567");
  assert.ok(normal.data.dataProcessingAcceptedAt instanceof Date);
  assert.ok(normal.data.privacyAcceptedAt instanceof Date);
  const invited = await runAsInviteSignup(7, () => before(candidate as never));
  assert.ok(invited && invited.data);
  assert.equal(invited.data.legalVersionAccepted, 7);
  await assert.rejects(
    runAsInviteSignup(6, () => before(candidate as never)),
    (error: unknown) => {
      return (
        error instanceof Error &&
        "body" in error &&
        (error.body as { code?: string }).code === "LEGAL_VERSION_CHANGED"
      );
    },
  );
  for (const consent of ["dataProcessingAccepted", "privacyAccepted"]) {
    await assert.rejects(
      before({ ...candidate, [consent]: false } as never),
      /consent are required/,
    );
  }
});
