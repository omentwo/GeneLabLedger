import { afterEach, describe, expect, it, vi } from "vitest";

import { commitWorkbookImport, previewWorkbookImport } from "@/api/imports";
import { executeBulkDelete, previewBulkDelete, setRecordsHighlight } from "@/api/records";

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

  it("previews an Excel file before committing parsed rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          filename: "ledger.xlsx",
          project_id: "project-1",
          selected_sheet: "TB",
          available_sheets: ["TB"],
          rows: [],
          create_count: 0,
          update_count: 0,
          errors: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ created: 0, updated: 0, record_ids: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([80, 75])], "ledger.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const rows = [
      {
        row_number: 2,
        record_id: null,
        pathology_number: "26-00001",
        status: "待实验" as const,
        experiment_date: null,
        experiment_number: null,
        values: {},
      },
    ];
    await previewWorkbookImport("project-1", file, "TB");
    await commitWorkbookImport("project-1", rows);

    const previewOptions = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/imports/workbook/preview");
    expect(previewOptions.body).toBeInstanceOf(FormData);
    expect((previewOptions.body as FormData).get("project_id")).toBe("project-1");
    expect((previewOptions.body as FormData).get("sheet_name")).toBe("TB");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/imports/workbook/commit");
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      project_id: "project-1",
      rows,
    });
  });

  it("executes bulk deletion only with the exact previewed UUID list", async () => {
    const filter = {
      project_id: "project-1",
      date_field: "experiment_date" as const,
      start_date: "2026-08-01",
      end_date: "2026-08-31",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ total: 1, locked_count: 0, record_ids: ["record-1"], items: [] }),
      )
      .mockResolvedValueOnce(jsonResponse({ deleted: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await previewBulkDelete(filter);
    await executeBulkDelete(filter, ["record-1"]);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/records/bulk-delete/preview");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/records/bulk-delete/execute");
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      filter,
      expected_record_ids: ["record-1"],
    });
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
});
