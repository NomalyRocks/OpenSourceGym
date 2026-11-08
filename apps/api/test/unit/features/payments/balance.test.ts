import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  balanceFromPaid,
  computeBalance,
  fitsBalance,
} from "../../../../src/features/payments/balance.js";

describe("computeBalance", () => {
  it("subtracts non-voided payments from the price", () => {
    assert.deepEqual(
      computeBalance(100_000, [
        { amountMinor: 30_000 },
        { amountMinor: 20_000 },
      ]),
      { paidMinor: 50_000, balanceMinor: 50_000 },
    );
  });

  it("ignores voided payments", () => {
    const result = computeBalance(100_000, [
      { amountMinor: 30_000 },
      { amountMinor: 60_000, void: { at: new Date(), by: "u", reason: null } },
    ]);
    assert.deepEqual(result, { paidMinor: 30_000, balanceMinor: 70_000 });
  });

  it("owes the whole price with no payments and nothing when paid in full", () => {
    assert.equal(computeBalance(5_000, []).balanceMinor, 5_000);
    assert.equal(
      computeBalance(5_000, [{ amountMinor: 5_000 }]).balanceMinor,
      0,
    );
  });

  it("keeps integer minor units exact where floats would drift", () => {
    // 0.1 + 0.2 style drift cannot occur with integers.
    const result = computeBalance(30, [
      { amountMinor: 10 },
      { amountMinor: 20 },
    ]);
    assert.equal(result.balanceMinor, 0);
  });

  it("derives a balance from an already-summed total", () => {
    assert.deepEqual(balanceFromPaid(1_000, 400), {
      paidMinor: 400,
      balanceMinor: 600,
    });
  });
});

describe("fitsBalance", () => {
  it("accepts amounts up to and including the balance", () => {
    assert.equal(fitsBalance(1, 1), true);
    assert.equal(fitsBalance(500, 500), true);
    assert.equal(fitsBalance(499, 500), true);
  });

  it("refuses overpayment, zero, negatives and fractions", () => {
    assert.equal(fitsBalance(501, 500), false);
    assert.equal(fitsBalance(0, 500), false);
    assert.equal(fitsBalance(-5, 500), false);
    assert.equal(fitsBalance(1.5, 500), false);
  });

  it("refuses everything once the balance is zero", () => {
    assert.equal(fitsBalance(1, 0), false);
  });
});
