import { afterEach, describe, expect, it, vi } from "vitest";

import { listRecords } from "@/api/records";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("record search API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes selected projects for a cross-project search", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ items: [], total: 0, limit: 100, offset: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listRecords({
      scope: "selected",
      project_ids: ["project-1", "project-2"],
      search: "POSITIVE",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/records?scope=selected&project_ids=project-1&project_ids=project-2&search=POSITIVE",
    );
  });
});
