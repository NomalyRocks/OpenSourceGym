import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectoryPlan,
  buildDirectoryUserMatch,
  directoryNeedsSubscriptionFilter,
  resolveDirectorySort,
  userDirectoryQuerySchema,
} from "./userDirectory.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const GYM = "a".repeat(24);

test("directory query applies defaults", () => {
  const q = userDirectoryQuerySchema.parse({});
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, 25);
  assert.equal(q.sort, "createdAt");
  assert.equal(q.role, undefined);
});

test("directory query parses comma lists and drops duplicates and blanks", () => {
  const q = userDirectoryQuerySchema.parse({
    role: "admin, staff,admin,",
    status: "active,expired",
    twoFactor: "on",
    gymId: GYM,
    page: "3",
    pageSize: "100",
  });
  assert.deepEqual(q.role, ["admin", "staff"]);
  assert.deepEqual(q.status, ["active", "expired"]);
  assert.equal(q.page, 3);
  assert.equal(q.pageSize, 100);
});

test("directory query treats an empty list as no filter", () => {
  assert.equal(userDirectoryQuerySchema.parse({ role: "" }).role, undefined);
});

test("directory query rejects invalid values", () => {
  for (const bad of [
    { role: "root" },
    { status: "active,gone" },
    { twoFactor: "maybe" },
    { gymId: "nope" },
    { sort: "email" },
    { dir: "up" },
    { page: "0" },
    { pageSize: "101" },
    { pageSize: "0" },
    { page: "1.5" },
  ]) {
    assert.equal(
      userDirectoryQuerySchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  }
});

test("directory sort defaults: name ascending, createdAt descending", () => {
  assert.deepEqual(resolveDirectorySort({ sort: "createdAt" }).spec, {
    createdAt: -1,
    _id: -1,
  });
  assert.deepEqual(resolveDirectorySort({ sort: "name" }).spec, {
    firstName: 1,
    lastName: 1,
    _id: 1,
  });
  assert.equal(
    resolveDirectorySort({ sort: "name", dir: "desc" }).direction,
    -1,
  );
});

test("user match combines role, MFA and search clauses", () => {
  assert.deepEqual(buildDirectoryUserMatch({}, null), {});
  const match = buildDirectoryUserMatch(
    { role: ["staff"], twoFactor: "off" },
    { email: /x/ },
  );
  assert.deepEqual(match, {
    $and: [
      { email: /x/ },
      { role: { $in: ["staff"] } },
      { twoFactorEnabled: { $ne: true } },
    ],
  });
});

test("plan joins subscriptions after paging unless status or gym filters need them", () => {
  const base = userDirectoryQuerySchema.parse({ page: "2", pageSize: "10" });
  assert.equal(directoryNeedsSubscriptionFilter(base), false);
  const light = buildDirectoryPlan(base, {}, NOW);
  const facet = (light.pipeline[1] as { $facet: { items: object[] } }).$facet;
  const firstStages = facet.items.map((s) => Object.keys(s)[0]);
  assert.deepEqual(firstStages.slice(0, 3), ["$sort", "$skip", "$limit"]);
  assert.ok(firstStages.includes("$lookup"));
  assert.deepEqual(facet.items[1], { $skip: 10 });

  const filtered = directoryNeedsSubscriptionFilter(
    userDirectoryQuerySchema.parse({ status: "active" }),
  );
  assert.equal(filtered, true);
  const heavy = buildDirectoryPlan(
    userDirectoryQuerySchema.parse({ status: "active", gymId: GYM }),
    {},
    NOW,
  );
  assert.equal(Object.keys(heavy.pipeline[1] as object)[0], "$lookup");
});

test("name sort requests a Turkish collation, createdAt does not", () => {
  const name = userDirectoryQuerySchema.parse({ sort: "name" });
  assert.deepEqual(buildDirectoryPlan(name, {}, NOW).collation, {
    locale: "tr",
  });
  assert.equal(
    buildDirectoryPlan(userDirectoryQuerySchema.parse({}), {}, NOW).collation,
    undefined,
  );
});

test("directory query accepts the frozen status", () => {
  assert.deepEqual(
    userDirectoryQuerySchema.parse({ status: "frozen,active" }).status,
    ["frozen", "active"],
  );
});

test("status derivation checks the open freeze first, in both pipeline shapes", () => {
  const stagesOf = (pipeline: object[]): object[] => {
    const facet = pipeline.find((s) => "$facet" in s) as {
      $facet: { items: object[] };
    };
    return pipeline.concat(facet.$facet.items);
  };
  for (const query of [{}, { status: "frozen" }]) {
    const plan = buildDirectoryPlan(
      userDirectoryQuerySchema.parse(query),
      {},
      NOW,
    );
    const json = JSON.stringify(stagesOf(plan.pipeline));
    assert.ok(json.includes('"from":"subscription_freezes"'));
    const frozenAt = json.indexOf('"then":"frozen"');
    assert.ok(frozenAt > 0);
    assert.ok(frozenAt < json.indexOf('"then":"active"'));
    assert.ok(
      json.indexOf('"then":"active"') < json.indexOf('"then":"expired"'),
    );
  }
});
