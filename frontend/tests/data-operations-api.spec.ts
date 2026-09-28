import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyRecordOperation,
  setRecordsHighlight,
} from "@/api/records";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ledger data operation APIs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets or clears a selected records' highlight color", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await setRecordsHighlight(["record-1", "record-2"], "#FFF2CC");
    await setRecordsHighlight(["record-1"], null);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/records/highlight");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      record_ids: ["record-1", "record-2"],
      highlight_color: "#FFF2CC",
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      record_ids: ["record-1"],
      highlight_color: null,
    });
  });

  it("applies an undo or redo snapshot as one server operation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ records: [], deleted_ids: ["record-1"] }));
    vi.stubGlobal("fetch", fetchMock);
    const before = {
      id: "record-1",
      project_id: "project-1",
      project_name: "项目 1",
      position: 1,
      pathology_number: "H-1",
      status: "待实验" as const,
      experiment_date: null,
      experiment_number: null,
      report_generated: false,
      locked: false,
      highlight_color: null,
      values: {},
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    };
    await applyRecordOperation({
      operation_id: "operation-1",
      project_id: "project-1",
      direction: "undo",
      before: [before],
      after: [],
    });

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/records/operations/apply");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      operation_id: "operation-1",
      project_id: "project-1",
      direction: "undo",
      before: [before],
      after: [],
    });
  });
});
