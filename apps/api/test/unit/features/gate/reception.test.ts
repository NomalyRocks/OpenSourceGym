import assert from "node:assert/strict";
import test from "node:test";
import {
  entryEventSchema,
  gateOpenRequestSchema,
} from "../../../../src/openapi/schemas.js";
import { openApiDocument } from "../../../../src/openapi/spec.js";
import {
  csvRow,
  entryCsvHeader,
  entryCsvValues,
} from "../../../../src/features/reports/csv.js";

test("reception request contract trims reasons and bounds IDs, direction and reason length", () => {
  const body = {
    userId: "a".repeat(24),
    deviceId: "b".repeat(24),
    direction: "out",
    reason: "  Phone unavailable  ",
  };
  assert.equal(gateOpenRequestSchema.parse(body).reason, "Phone unavailable");
  for (const update of [
    { userId: "invalid" },
    { deviceId: "invalid" },
    { direction: "both" },
    { reason: "  x  " },
    { reason: "x".repeat(201) },
  ]) {
    assert.equal(
      gateOpenRequestSchema.safeParse({ ...body, ...update }).success,
      false,
    );
  }
});

test("OpenAPI includes both protected reception routes and the source filter", () => {
  const paths = openApiDocument.paths!;
  const devices = paths["/api/admin/gyms/{gymId}/gate-devices"]?.get;
  const open = paths["/api/admin/gyms/{gymId}/gate-open"]?.post;
  assert.ok(devices?.responses?.["200"]);
  assert.ok(open?.requestBody);
  for (const status of ["200", "400", "401", "403", "404", "429"])
    assert.ok(open?.responses?.[status]);
  assert.ok(
    JSON.stringify(paths["/api/admin/gyms/{gymId}/entry-events"]).includes(
      '"source"',
    ),
  );
});

test("entry CSV separates refusal codes from staff reasons and protects free text", () => {
  const doc = {
    source: "reception",
    reason: "BANNED",
    staffReason: "=private note",
    actorName: "Reception staff",
    allowed: false,
  };
  const values = entryCsvValues(doc);
  const byColumn = Object.fromEntries(
    entryCsvHeader.map((key, index) => [key, values[index]]),
  );
  assert.equal(byColumn.reason, "BANNED");
  assert.equal(Object.hasOwn(byColumn, "code"), false);
  assert.equal(byColumn.source, "reception");
  assert.equal(byColumn.actor, "Reception staff");
  assert.equal(byColumn.staffReason, "=private note");
  assert.ok(csvRow(values).includes("'=private note"));
  const legacy = entryCsvValues({ reason: "BANNED" });
  assert.equal(legacy[entryCsvHeader.indexOf("source")], "qr");
  assert.equal(legacy[entryCsvHeader.indexOf("reason")], "BANNED");
  assert.equal(legacy[entryCsvHeader.indexOf("staffReason")], null);
});

test("entry event contract keeps rejection reason distinct from optional staff text", () => {
  assert.equal(Object.hasOwn(entryEventSchema.shape, "code"), false);
  assert.equal(entryEventSchema.shape.reason.parse("BANNED"), "BANNED");
  assert.equal(entryEventSchema.shape.reason.parse(null), null);
  assert.equal(
    entryEventSchema.shape.reason.safeParse("Phone unavailable").success,
    false,
  );
  assert.equal(
    entryEventSchema.shape.staffReason.parse("Phone unavailable"),
    "Phone unavailable",
  );
  assert.equal(entryEventSchema.shape.staffReason.parse(null), null);
});
