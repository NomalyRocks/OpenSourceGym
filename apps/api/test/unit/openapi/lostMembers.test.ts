import assert from "node:assert/strict";
import test from "node:test";
import { openApiDocument } from "../../../src/openapi/spec.js";

test("OpenAPI describes lost-member lists, pagination, days and CSV datasets", () => {
  const document = openApiDocument as unknown as {
    paths: Record<
      string,
      {
        get: {
          description: string;
          parameters: {
            name: string;
            schema: {
              minimum?: number;
              maximum?: number;
              default?: number;
              enum?: string[];
            };
          }[];
          responses: Record<
            string,
            {
              content?: Record<
                string,
                { schema?: { properties?: Record<string, unknown> } }
              >;
            }
          >;
        };
      }
    >;
  };
  const root = "/api/admin/gyms/{gymId}/reports";
  for (const name of ["inactive-members", "lapsed-members"]) {
    const route = document.paths[`${root}/${name}`]!.get;
    assert.match(route.description, /owner \| admin \| staff/);
    assert.ok(route.parameters.some((parameter) => parameter.name === "page"));
    assert.ok(
      route.parameters.some((parameter) => parameter.name === "cursor"),
    );
    assert.ok(route.responses["403"]);
    assert.ok(
      route.responses["200"]!.content?.["application/json"]?.schema?.properties
        ?.total,
    );
  }
  const inactive = document.paths[`${root}/inactive-members`]!.get;
  const days = inactive.parameters.find(
    (parameter) => parameter.name === "days",
  )!.schema;
  assert.equal(days.minimum, 1);
  assert.equal(days.maximum, 365);
  assert.equal(days.default, 14);
  const csv = document.paths[`${root}/export`]!.get;
  const datasets = csv.parameters.find(
    (parameter) => parameter.name === "dataset",
  )!.schema.enum;
  assert.ok(datasets?.includes("inactive"));
  assert.ok(datasets?.includes("lapsed"));
  assert.match(
    csv.description,
    /Required role: owner \| admin \(gym in scope\)/,
  );
  assert.ok(csv.responses["200"]!.content?.["text/csv"]);
});
