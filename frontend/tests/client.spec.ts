import { ApiError, apiRequest } from "@/api/client";

describe("apiRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(apiRequest<{ status: string }>("/health")).resolves.toEqual({
      status: "ok",
    });
  });

  it("surfaces FastAPI detail messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "记录不存在" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(apiRequest("/records/missing")).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        status: 404,
        message: "记录不存在",
        detail: expect.anything(),
      }),
    );
  });
});


describe("request error and cancellation handling", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it.each(["", "broken json"])("wraps malformed error payload %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 503, headers: { "content-type": "application/json" },
    })));
    await expect(apiRequest("/health")).rejects.toMatchObject({ name: "ApiError", status: 503 });
  });
  it("accepts an empty successful JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", {
      headers: { "content-type": "application/json" },
    })));
    await expect(apiRequest("/empty")).resolves.toBeUndefined();
  });
  it("aborts a hung request at its deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const result = expect(apiRequest("/hung", { timeoutMs: 50 })).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(50);
    await result;
  });
  it("honors caller cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const controller = new AbortController();
    const result = expect(apiRequest("/cancel", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
  });
});
