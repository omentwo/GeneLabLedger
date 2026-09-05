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

export type ApiRequestOptions = RequestInit & { timeoutMs?: number };

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) return text;
    throw new ApiError(response.status, "后端返回了无效的 JSON 数据", text);
  }
}

async function request<T>(
  path: string,
  options: ApiRequestOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const { timeoutMs = 30_000, signal, ...init } = options;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const headers = new Headers(init.headers);
  let body = init.body;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    body = JSON.stringify(body);
  }
  if (typeof body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  try {
    const response = await fetch(`${apiBaseUrl()}/api${path}`, {
      ...init, body, headers, signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await responsePayload(response);
      throw new ApiError(response.status, errorMessage(payload, response.status), payload);
    }
    return await read(response);
  } catch (error) {
    if (timedOut) throw new ApiError(408, "请求超时，请检查后端状态；写入结果请刷新确认", null);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return request(path, options, async (response) =>
    response.status === 204 ? undefined as T : await responsePayload(response) as T,
  );
}

export function apiRequestBlob(
  path: string,
  options: ApiRequestOptions = {},
): Promise<{ blob: Blob; filename: string | null }> {
  return request(path, { timeoutMs: 120_000, ...options }, async (response) => {
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
    let filename = plainMatch?.[1] ?? null;
    if (encodedMatch) {
      try { filename = decodeURIComponent(encodedMatch[1]!); } catch { filename = encodedMatch[1]!; }
    }
    return { blob: await response.blob(), filename };
  });
}

export function jsonBody(value: unknown): BodyInit {
  return JSON.stringify(value);
}
