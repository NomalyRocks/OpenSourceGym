export class ApiError extends Error {
  constructor(
    public status: number,
    public serverMessage: string,
    public code?: string,
  ) {
    super(serverMessage);
  }
}

/** Distinguishes a canceled request from a regular error. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "include",
    signal: options.signal,
    headers:
      options.body !== undefined
        ? { "Content-Type": "application/json" }
        : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.message ?? `Request failed (${res.status})`,
      data.code,
    );
  }
  return data as T;
}

/**
 * Helper for BetterAuth endpoints (`/api/auth/*`). Unlike `api()`, these use
 * BetterAuth's own endpoint schema rather than the app's REST contract, while
 * still using the same cookie-based session and error format (Phase 5: MFA
 * sign-in/setup).
 */
export async function authApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.message ?? `Request failed (${res.status})`,
      data.code,
    );
  }
  return data as T;
}
