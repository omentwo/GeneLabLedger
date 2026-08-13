import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commitCellBatch,
  commitReplace,
  previewCellBatch,
  queryRecordIds,
  queryRecords,
} from "@/api/records";
import {
  createLedgerViewPreset,
  deleteLedgerViewPreset,
  listLedgerViewPresets,
  setDefaultLedgerViewPreset,
  updateLedgerViewPreset,
} from "@/api/projects";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("v0.10 ledger APIs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends complex paged queries and requests all matching ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], total: 0, limit: 200, offset: 200 }))
      .mockResolvedValueOnce(jsonResponse({ record_ids: ["r1", "r2"], total: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const query = {
      project_id: "p1",
      status: "待实验",
      search: "26-",
      field_filters: [{ field_id: "f1", operator: "contains" as const, value: "阳性" }],
      sort: { field_id: "f1", direction: "desc" as const },
      limit: 200,
      offset: 200,
    };

    await queryRecords(query);
    await queryRecordIds({ ...query, limit: 1, offset: 0 });

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/records/query");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual(query);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/records/query/ids");
  });

  it("previews and atomically commits existing cells plus new records", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          token: "a".repeat(32),
          affected_count: 2,
          skipped_locked: 0,
          issues: [],
          expires_at: "2026-08-12T12:00:00Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          records: [],
          skipped_locked: 0,
          changes: [],
          created_record_ids: ["new-1"],
          before: [],
          after: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ records: [], skipped_locked: 0, changes: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const changes = [{ record_id: "r1", field_id: "f1", value: "新", expected_value: "旧" }];
    const newRecords = [
      {
        client_id: "draft-1",
        pathology_number: "26-00001",
        status: "待实验" as const,
        experiment_date: null,
        experiment_number: null,
        values: { f1: "新记录" },
      },
    ];

    await previewCellBatch("p1", changes, newRecords);
    await commitCellBatch("a".repeat(32), true, true);
    await commitReplace("b".repeat(32), false);

    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      project_id: "p1",
      changes,
      new_records: newRecords,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      token: "a".repeat(32),
      accept_warnings: true,
      include_snapshots: true,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body))).toEqual({
      token: "b".repeat(32),
      accept_warnings: false,
      include_snapshots: false,
    });
  });

  it("uses project-scoped named view CRUD endpoints", async () => {
    const preset = {
      id: "v1",
      project_id: "p1",
      name: "录入",
      state: { columns: [], frozen_until_field_id: null, sort: null, filters: {} },
      is_default: false,
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z",
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(preset)));
    vi.stubGlobal("fetch", fetchMock);

    await listLedgerViewPresets("p1");
    await createLedgerViewPreset("p1", { name: "录入", state: preset.state });
    await updateLedgerViewPreset("v1", { name: "复核" });
    await setDefaultLedgerViewPreset("v1");
    await deleteLedgerViewPreset("v1");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/projects/p1/view-presets",
      "/api/projects/p1/view-presets",
      "/api/projects/view-presets/v1",
      "/api/projects/view-presets/v1/default",
      "/api/projects/view-presets/v1",
    ]);
  });
});
