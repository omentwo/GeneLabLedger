import { afterEach, describe, expect, it, vi } from "vitest";

import { assignExperimentNumbers } from "@/api/records";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("experiment numbering API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assigns a prefix and ordered suffixes to selected record UUIDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await assignExperimentNumbers(["record-1", "record-2"], "20260801");

    const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/records/experiment-numbers");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      record_ids: ["record-1", "record-2"],
      prefix: "20260801",
    });
  });
});
