import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";

function configuration(t: TestContext, mode: string, url?: string) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: mode,
    BETTER_AUTH_SECRET: "invite-env-test-secret-at-least-32-characters",
  };
  delete childEnv.PUBLIC_WEB_URL;
  delete childEnv.NODE_TEST_CONTEXT;
  if (url !== undefined) childEnv.PUBLIC_WEB_URL = url;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { env } from './src/core/env.ts'; console.log(env.publicWebUrl)",
    ],
    {
      cwd: new URL("../../../../", import.meta.url),
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

test("the public invite URL defaults only outside production", (t) => {
  const development = configuration(t, "development");
  if (!development) return;
  assert.equal(development.status, 0, development.stderr);
  assert.equal(development.stdout.trim(), "http://localhost:5173");
  const missing = configuration(t, "production");
  if (!missing) return;
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /PUBLIC_WEB_URL/);
});

test("the public invite URL requires HTTP(S) and trims a trailing slash", (t) => {
  const valid = configuration(t, "production", "https://gym.example.com/");
  if (!valid) return;
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout.trim(), "https://gym.example.com");
  const invalid = configuration(t, "production", "file:///invite");
  if (!invalid) return;
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /PUBLIC_WEB_URL/);
});
