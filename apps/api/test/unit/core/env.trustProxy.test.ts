import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";

function configuration(t: TestContext, trustProxy?: string) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "trust-proxy-test-secret-at-least-32-characters",
  };
  delete childEnv.TRUST_PROXY;
  delete childEnv.NODE_TEST_CONTEXT;
  if (trustProxy !== undefined) childEnv.TRUST_PROXY = trustProxy;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { env } from './src/core/env.ts'; console.log(env.trustProxy)",
    ],
    {
      cwd: new URL("../../../", import.meta.url),
      env: childEnv,
      encoding: "utf8",
    },
  );
  if (result.error && "code" in result.error && result.error.code === "EPERM") {
    t.skip("Child processes are not permitted in this sandbox");
    return null;
  }
  assert.ifError(result.error);
  return result;
}

test("TRUST_PROXY defaults to zero trusted hops", (t) => {
  const result = configuration(t);
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0");
});

test("TRUST_PROXY parses one trusted hop", (t) => {
  const result = configuration(t, "1");
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1");
});

test("TRUST_PROXY above ten fails startup", (t) => {
  const result = configuration(t, "11");
  if (!result) return;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRUST_PROXY/);
});
