export class ApiError extends Error {
  constructor(
    public status: number,
    public serverMessage: string,
    public code?: string,
  ) {
    super(serverMessage);
  }
}

/** İptal edilen isteği normal hatadan ayırmak için. */
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
 * BetterAuth uç noktaları (`/api/auth/*`) için yardımcı. `api()`'den farklı
 * olarak bunlar app'in kendi REST sözleşmesinde değil, BetterAuth'un kendi
 * endpoint şemasında; yine de aynı çerez tabanlı oturum ve hata biçimini
 * kullanır (Faz 5: MFA girişi/kurulumu).
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
