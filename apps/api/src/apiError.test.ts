import assert from "node:assert/strict";
import test from "node:test";
import type { ApiErrorResponse } from "@opengym/shared";
import type { Response } from "express";
import { sendApiError } from "./apiError.js";

test("API hatası kararlı code ve geriye dönük message alanlarını döndürür", () => {
  let status: number | undefined;
  let body: ApiErrorResponse | undefined;
  const response = {
    status(value: number) {
      status = value;
      return this;
    },
    json(value: ApiErrorResponse) {
      body = value;
      return this;
    },
  } as unknown as Response;

  sendApiError(response, 404, "DEVICE_NOT_FOUND", "Device not found.");

  assert.equal(status, 404);
  assert.deepEqual(body, {
    code: "DEVICE_NOT_FOUND",
    message: "Device not found.",
  });
});
