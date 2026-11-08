import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSubscriptionSchema,
  catalogPriceChanged,
  mayChoosePrice,
  packageDurationSchema,
} from "../../../../src/features/subscriptions/sale.js";
import {
  createPackageSchema,
  updatePackageSchema,
} from "../../../../src/features/packages/router.js";

const common = {
  userId: "a".repeat(24),
  gymIds: ["b".repeat(24)],
  requestId: "0b9d3f64-1c1f-4c64-8c43-0f1a8b9f6a11",
};

function parse(body: unknown) {
  const result = createSubscriptionSchema.safeParse(body);
  assert.ok(result.success, "expected the body to parse");
  return result.data;
}

describe("createSubscriptionSchema", () => {
  it("accepts an expected catalog price with the same bounds as sale prices", () => {
    for (const expectedPriceMinor of [0, 1, 10_000_000_000]) {
      const body = parse({
        ...common,
        packageId: "c".repeat(24),
        expectedPriceMinor,
      });
      assert.equal(mayChoosePrice("staff", body), true);
    }
    for (const expectedPriceMinor of [-1, 1.5, 10_000_000_001, null]) {
      assert.equal(
        createSubscriptionSchema.safeParse({
          ...common,
          packageId: "c".repeat(24),
          expectedPriceMinor,
        }).success,
        false,
      );
    }
  });
  it("parses a catalog sale and a custom grant", () => {
    parse({ ...common, packageId: "c".repeat(24) });
    parse({ ...common, custom: { days: 10, priceMinor: 0 } });
  });

  it("drops the legacy months field", () => {
    assert.equal(
      createSubscriptionSchema.safeParse({ ...common, months: 3 }).success,
      false,
    );
  });

  it("needs a requestId UUID", () => {
    assert.equal(
      createSubscriptionSchema.safeParse({
        userId: common.userId,
        gymIds: common.gymIds,
        packageId: "c".repeat(24),
      }).success,
      false,
    );
  });

  it("bounds custom days and prices", () => {
    for (const days of [0, 367, 1.5]) {
      assert.equal(
        createSubscriptionSchema.safeParse({
          ...common,
          custom: { days, priceMinor: 100 },
        }).success,
        false,
      );
    }
    assert.equal(
      createSubscriptionSchema.safeParse({
        ...common,
        custom: { days: 5, priceMinor: -1 },
      }).success,
      false,
    );
    assert.equal(
      createSubscriptionSchema.safeParse({
        ...common,
        packageId: "c".repeat(24),
        priceMinor: 100_000_000_01,
      }).success,
      false,
    );
  });

  it("refuses a body that is both a package sale and a custom grant", () => {
    assert.equal(
      createSubscriptionSchema.safeParse({
        ...common,
        packageId: "c".repeat(24),
        custom: { days: 5, priceMinor: 100 },
      }).success,
      false,
    );
  });
});

describe("catalogPriceChanged", () => {
  it("refuses a different or cleared catalog price, including a free price", () => {
    const body = parse({
      ...common,
      packageId: "c".repeat(24),
      expectedPriceMinor: 0,
    });
    assert.equal(catalogPriceChanged(body, 0), false);
    assert.equal(catalogPriceChanged(body, 1), true);
    assert.equal(catalogPriceChanged(body, null), true);
  });

  it("allows omitted expectations and intentional price overrides", () => {
    assert.equal(
      catalogPriceChanged(parse({ ...common, packageId: "c".repeat(24) }), 100),
      false,
    );
    assert.equal(
      catalogPriceChanged(
        parse({
          ...common,
          packageId: "c".repeat(24),
          expectedPriceMinor: 100,
          priceMinor: 0,
        }),
        200,
      ),
      false,
    );
    assert.equal(
      catalogPriceChanged(
        parse({ ...common, custom: { days: 5, priceMinor: 0 } }),
        null,
      ),
      false,
    );
  });
});

describe("mayChoosePrice", () => {
  it("lets staff sell a catalog package at the list price only", () => {
    const plain = parse({ ...common, packageId: "c".repeat(24) });
    assert.equal(mayChoosePrice("staff", plain), true);
  });

  it("refuses staff a price override", () => {
    const override = parse({
      ...common,
      packageId: "c".repeat(24),
      priceMinor: 1,
    });
    assert.equal(mayChoosePrice("staff", override), false);
    assert.equal(mayChoosePrice("admin", override), true);
    assert.equal(mayChoosePrice("owner", override), true);
  });

  it("refuses staff a custom grant, even a free one", () => {
    const custom = parse({ ...common, custom: { days: 5, priceMinor: 0 } });
    assert.equal(mayChoosePrice("staff", custom), false);
    assert.equal(mayChoosePrice("admin", custom), true);
    assert.equal(mayChoosePrice("owner", custom), true);
  });

  it("treats an explicit zero override as an override", () => {
    const zero = parse({ ...common, packageId: "c".repeat(24), priceMinor: 0 });
    assert.equal(mayChoosePrice("staff", zero), false);
  });
});

describe("package schemas", () => {
  it("bounds durations: months 1..24, days 1..366", () => {
    const ok = (value: unknown) =>
      packageDurationSchema.safeParse(value).success;
    assert.equal(ok({ unit: "month", value: 24 }), true);
    assert.equal(ok({ unit: "month", value: 25 }), false);
    assert.equal(ok({ unit: "month", value: 0 }), false);
    assert.equal(ok({ unit: "day", value: 366 }), true);
    assert.equal(ok({ unit: "day", value: 367 }), false);
    assert.equal(ok({ unit: "week", value: 1 }), false);
  });

  it("creates with a name and a price or null", () => {
    const duration = { unit: "month", value: 1 };
    assert.equal(
      createPackageSchema.safeParse({ name: "x", duration, priceMinor: null })
        .success,
      true,
    );
    assert.equal(
      createPackageSchema.safeParse({ name: "", duration, priceMinor: 1 })
        .success,
      false,
    );
    assert.equal(
      createPackageSchema.safeParse({
        name: "x".repeat(81),
        duration,
        priceMinor: 1,
      }).success,
      false,
    );
    assert.equal(
      createPackageSchema.safeParse({ name: "x", duration, priceMinor: 1.5 })
        .success,
      false,
    );
  });

  it("needs at least one field to update", () => {
    assert.equal(updatePackageSchema.safeParse({}).success, false);
    assert.equal(
      updatePackageSchema.safeParse({ active: false }).success,
      true,
    );
    assert.equal(
      updatePackageSchema.safeParse({ priceMinor: null }).success,
      true,
    );
  });
});
