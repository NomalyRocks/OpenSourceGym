import type { ApiErrorCode, ApiErrorResponse } from "@opengym/shared";
import type { Response } from "express";

/** Produces a stable code field for clients in all application API errors. */
export function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
): void {
  const body: ApiErrorResponse = { code, message };
  res.status(status).json(body);
}
