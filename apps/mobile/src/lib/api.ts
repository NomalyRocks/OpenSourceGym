import { fetch as expoFetch } from "expo/fetch";
import { File } from "expo-file-system";
import { API_URL } from "./config";
import { authClient } from "./auth";
import { getDeviceFingerprint } from "./fingerprint";

export class ApiError extends Error {
  constructor(
    public status: number,
    public serverMessage: string,
    public code?: string,
  ) {
    super(serverMessage);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const fp = await getDeviceFingerprint();
  const cookie = await authClient.getCookie();
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Cookie: cookie,
      ...(fp ? { "X-Device-Fingerprint": fp } : {}),
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { message?: string }).message ??
        `Request failed (${res.status})`,
      (data as { code?: string }).code,
    );
  }
  return data as T;
}

export async function uploadBinary<T>(
  path: string,
  uri: string,
  contentType: string,
): Promise<T> {
  let file: File;
  try {
    file = new File(uri);
    if (!file.exists || file.size === 0) throw new Error("Unreadable file");
  } catch {
    throw new ApiError(
      0,
      "The selected photo could not be read.",
      "LOCAL_FILE_READ_FAILED",
    );
  }

  const fp = await getDeviceFingerprint();
  const cookie = await authClient.getCookie();
  const res = await expoFetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "Content-Type": contentType,
      ...(fp ? { "X-Device-Fingerprint": fp } : {}),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { message?: string }).message ??
        `Request failed (${res.status})`,
      (data as { code?: string }).code,
    );
  }
  return data as T;
}
