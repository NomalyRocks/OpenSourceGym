import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "./api";
import {
  defaultPaymentGym,
  isDefinitiveSaleRejection,
} from "./subscriptionSale";

test("definitive sale rejections release the payload for editing", () => {
  for (const [status, code] of [
    [400, "INVALID_SUBSCRIPTION"],
    [403, "GYM_OUT_OF_SCOPE"],
    [404, "PACKAGE_NOT_FOUND"],
    [409, "PACKAGE_PRICE_CHANGED"],
    [409, "PACKAGE_INACTIVE"],
    [422, undefined],
  ] as const) {
    assert.equal(
      isDefinitiveSaleRejection(new ApiError(status, "Rejected", code)),
      true,
    );
  }
});

test("ambiguous and busy failures preserve the request payload for retry", () => {
  for (const error of [
    new TypeError("Failed to fetch"),
    new ApiError(500, "Server error"),
    new ApiError(502, "Gateway error"),
    new ApiError(503, "Busy", "SUBSCRIPTION_BUSY"),
    new ApiError(409, "Busy", "SUBSCRIPTION_BUSY"),
    new ApiError(409, "Conflict", "REQUEST_ID_CONFLICT"),
  ])
    assert.equal(isDefinitiveSaleRejection(error), false);
});

test("payment gym prefers the open panel gym, falling back to the first option", () => {
  const gyms = [{ id: "a" }, { id: "b" }];
  assert.equal(defaultPaymentGym(gyms, "b"), "b");
  assert.equal(defaultPaymentGym(gyms, "outside"), "a");
  assert.equal(defaultPaymentGym([], "b"), "");
});
