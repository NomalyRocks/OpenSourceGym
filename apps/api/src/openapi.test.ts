import assert from "node:assert/strict";
import test from "node:test";
import { LEGAL_DOCUMENT_URL_PATTERN } from "./legalUrl.js";
import { openApiDocument } from "./openapi/spec.js";

test("OpenAPI publishes the public legal document endpoint and HTTP(S) URL restriction", () => {
  const document = openApiDocument as unknown as {
    paths: Record<
      string,
      { get?: { responses: Record<string, unknown>; security?: unknown } }
    >;
    components: {
      schemas: Record<
        string,
        { properties?: Record<string, { anyOf?: { pattern?: string }[] }> }
      >;
    };
  };

  const endpoint = document.paths["/api/legal"]?.get;
  assert.ok(endpoint);
  assert.deepEqual(endpoint.security, []);
  assert.ok(endpoint.responses["200"]);
  const dataProcessingUrl =
    document.components.schemas.LegalConfig?.properties?.dataProcessingUrl;
  assert.equal(
    dataProcessingUrl?.anyOf?.find((schema) => schema.pattern !== undefined)
      ?.pattern,
    LEGAL_DOCUMENT_URL_PATTERN,
  );
});
