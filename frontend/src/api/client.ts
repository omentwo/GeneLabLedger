import { apiBaseUrl } from "@/utils/desktop";

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          if (item && typeof item === "object" && "msg" in item) {
            return String((item as { msg: unknown }).msg);
          }
          return String(item);
        })
        .join("；");
    }
  }
  if (typeof payload === "string" && payload.trim()) return payload;
  return `请求失败（${status}）`;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body;

  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  } else if (typeof body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl()}/api${path}`, {
    ...options,
    body,
    headers,
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(payload, response.status), payload);
  }

  return payload as T;
}

export async function apiRequestBlob(
  path: string,
  options: RequestInit = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const headers = new Headers(options.headers);
  let body = options.body;

  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  } else if (typeof body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl()}/api${path}`, {
    ...options,
    body,
    headers,
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    throw new ApiError(response.status, errorMessage(payload, response.status), payload);
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  const filename = encodedMatch
    ? decodeURIComponent(encodedMatch[1]!)
    : plainMatch?.[1] ?? null;
  return { blob: await response.blob(), filename };
}

export function jsonBody(value: unknown): BodyInit {
  return JSON.stringify(value);
}
