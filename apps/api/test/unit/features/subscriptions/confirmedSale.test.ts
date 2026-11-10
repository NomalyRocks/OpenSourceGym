import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmedSaleSchema,
  saleTermsChanged,
} from "../../../../src/features/subscriptions/confirmedSale.js";

const duration = { unit: "month", value: 1 } as const;
const sale = {
  userId: "a".repeat(24),
  gymIds: ["b".repeat(24)],
  packageId: "c".repeat(24),
  requestId: "0b9d3f64-1c1f-4c64-8c43-0f1a8b9f6a11",
  expectedPriceMinor: 1_000,
  expectedCurrency: "TRY",
  expectedDuration: duration,
};

test("sale confirmation requires valid currency and duration expectations", () => {
  assert.equal(confirmedSaleSchema.safeParse(sale).success, true);
  for (const patch of [
    { expectedCurrency: undefined },
    { expectedCurrency: "CAD" },
    { expectedDuration: undefined },
    { expectedDuration: { unit: "day", value: 367 } },
    { expectedDuration: { unit: "month", value: 0 } },
    { expectedDuration: { unit: "month", value: 1.5 } },
  ]) {
    assert.equal(
      confirmedSaleSchema.safeParse({ ...sale, ...patch }).success,
      false,
    );
  }
});

test("sale terms compare currency, duration unit, duration value and catalog price", () => {
  const body = confirmedSaleSchema.parse(sale);
  assert.equal(saleTermsChanged(body, "TRY", duration, 1_000), false);
  assert.equal(saleTermsChanged(body, "EUR", duration, 1_000), true);
  assert.equal(
    saleTermsChanged(body, "TRY", { unit: "day", value: 1 }, 1_000),
    true,
  );
  assert.equal(
    saleTermsChanged(body, "TRY", { unit: "month", value: 2 }, 1_000),
    true,
  );
  assert.equal(saleTermsChanged(body, "TRY", duration, 2_000), true);
});

test("an intentional price override still checks currency and duration", () => {
  const body = confirmedSaleSchema.parse({ ...sale, priceMinor: 500 });
  assert.equal(saleTermsChanged(body, "TRY", duration, 2_000), false);
  assert.equal(saleTermsChanged(body, "EUR", duration, 2_000), true);
  assert.equal(
    saleTermsChanged(body, "TRY", { unit: "month", value: 2 }, 2_000),
    true,
  );
});
