import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { totalPayments } from "../../../../src/features/payments/cashReport.js";
import {
  decodeDebtorCursor,
  encodeDebtorCursor,
} from "../../../../src/features/payments/debtors.js";
import {
  recordPaymentSchema,
  voidPaymentSchema,
} from "../../../../src/features/payments/router.js";

describe("totalPayments", () => {
  it("sums by method and by staff", () => {
    const totals = totalPayments(
      [
        { amountMinor: 100, currency: "TRY", method: "cash", recordedBy: "a" },
        { amountMinor: 250, currency: "TRY", method: "card", recordedBy: "a" },
        { amountMinor: 50, currency: "TRY", method: "cash", recordedBy: "b" },
      ],
      new Map([["a", "Ayse"]]),
    );
    assert.equal(totals.length, 1);
    const [only] = totals;
    assert.equal(only?.totalMinor, 400);
    assert.equal(only?.count, 3);
    assert.deepEqual(only?.byMethod, [
      { method: "card", totalMinor: 250, count: 1 },
      { method: "cash", totalMinor: 150, count: 2 },
    ]);
    assert.deepEqual(only?.byStaff, [
      { userId: "a", name: "Ayse", totalMinor: 350, count: 2 },
      { userId: "b", name: null, totalMinor: 50, count: 1 },
    ]);
  });

  it("never adds two currencies together", () => {
    const totals = totalPayments([
      { amountMinor: 100, currency: "TRY", method: "cash", recordedBy: "a" },
      { amountMinor: 100, currency: "EUR", method: "cash", recordedBy: "a" },
    ]);
    assert.deepEqual(
      totals.map((entry) => [entry.currency, entry.totalMinor]),
      [
        ["TRY", 100],
        ["EUR", 100],
      ],
    );
  });

  it("is empty for a day with no payments", () => {
    assert.deepEqual(totalPayments([]), []);
  });
});

describe("debtor cursor", () => {
  it("round-trips", () => {
    const id = new ObjectId();
    const decoded = decodeDebtorCursor(
      encodeDebtorCursor({ dueMs: 1_700_000_000_000, balanceMinor: 4_500, id }),
    );
    assert.ok(decoded);
    assert.equal(decoded.dueMs, 1_700_000_000_000);
    assert.equal(decoded.balanceMinor, 4_500);
    assert.ok(decoded.id.equals(id));
  });

  it("rejects malformed input", () => {
    assert.equal(decodeDebtorCursor("not a cursor"), null);
    assert.equal(
      decodeDebtorCursor(Buffer.from("1:2:zzzz").toString("base64url")),
      null,
    );
    assert.equal(
      decodeDebtorCursor(
        Buffer.from("x:2:" + "a".repeat(24)).toString("base64url"),
      ),
      null,
    );
  });
});

describe("payment request schemas", () => {
  const base = {
    amountMinor: 1000,
    method: "cash",
    gymId: "a".repeat(24),
    requestId: "0b9d3f64-1c1f-4c64-8c43-0f1a8b9f6a11",
  };

  it("accepts a valid payment", () => {
    assert.equal(recordPaymentSchema.safeParse(base).success, true);
  });

  it("refuses zero, negative, fractional amounts and unknown fields", () => {
    for (const amountMinor of [0, -1, 1.5]) {
      assert.equal(
        recordPaymentSchema.safeParse({ ...base, amountMinor }).success,
        false,
      );
    }
    assert.equal(
      recordPaymentSchema.safeParse({ ...base, currency: "USD" }).success,
      false,
    );
    assert.equal(
      recordPaymentSchema.safeParse({ ...base, requestId: "nope" }).success,
      false,
    );
  });

  it("needs a void reason of 3 to 200 characters", () => {
    assert.equal(voidPaymentSchema.safeParse({ reason: "ab" }).success, false);
    assert.equal(voidPaymentSchema.safeParse({ reason: "abc" }).success, true);
    assert.equal(
      voidPaymentSchema.safeParse({ reason: "x".repeat(201) }).success,
      false,
    );
  });
});
