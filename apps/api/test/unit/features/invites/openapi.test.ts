import assert from "node:assert/strict";
import test from "node:test";
import { openApiDocument } from "../../../../src/openapi/spec.js";

test("OpenAPI publishes all invite routes with the appropriate authentication boundary", () => {
  const paths = openApiDocument.paths as Record<
    string,
    Record<string, { security?: unknown; responses: Record<string, unknown> }>
  >;
  for (const path of ["/api/invites/lookup", "/api/invites/accept"]) {
    const operation = paths[path]?.post;
    assert.ok(operation);
    assert.deepEqual(operation.security, []);
    assert.ok(operation.responses["404"]);
    assert.ok(operation.responses["429"]);
  }
  for (const [path, methods] of [
    ["/api/admin/gyms/{gymId}/invites", ["get", "post"]],
    ["/api/admin/gyms/{gymId}/invites/{id}/resend", ["post"]],
    ["/api/admin/gyms/{gymId}/invites/{id}", ["delete"]],
  ] as const) {
    for (const method of methods) {
      const operation = paths[path]?.[method];
      assert.ok(operation);
      assert.deepEqual(operation.security, [{ sessionCookie: [] }]);
      assert.ok(operation.responses["401"]);
      assert.ok(operation.responses["403"]);
    }
  }
});
