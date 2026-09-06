import { describe, expect, it } from "vitest";

import {
  LedgerRecordCache,
  ledgerRecordQueryKey,
} from "@/utils/ledgerRecordCache";
import type { ProjectRecord, RecordComplexQuery } from "@/types/api";

function record(id: string, projectId = "project-a"): ProjectRecord {
  return {
    id,
    project_id: projectId,
    project_name: projectId,
    position: 1,
    pathology_number: `P-${id}`,
    block_number: null,
    status: "待实验",
    experiment_date: null,
    experiment_number: null,
    report_generated: false,
    locked: false,
    highlight_color: null,
    cell_highlight_colors: {},
    values: { field: id },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function query(fieldFilters: RecordComplexQuery["field_filters"]): RecordComplexQuery {
  return {
    project_id: "project-a",
    status: null,
    search: null,
    experiment_date_from: null,
    experiment_date_to: null,
    field_filters: fieldFilters,
    sort: null,
    limit: 200,
    offset: 0,
  };
}

describe("LedgerRecordCache", () => {
  it("normalizes semantically equivalent field filters into one query key", () => {
    const left = query([
      { field_id: "b", operator: "in", values: ["two", "one"] },
      { field_id: "a", operator: "contains", value: "term" },
    ]);
    const right = query([
      { field_id: "a", operator: "contains", value: "term" },
      { field_id: "b", operator: "in", values: ["one", "two"] },
    ]);

    expect(ledgerRecordQueryKey(left)).toBe(ledgerRecordQueryKey(right));
  });

  it("returns isolated snapshots and marks them stale before expiration", () => {
    let now = 1_000;
    const cache = new LedgerRecordCache({
      staleTimeMs: 100,
      maxAgeMs: 500,
      now: () => now,
    });
    cache.set("key", "project-a", { records: [record("1")], total: 1 });

    const fresh = cache.get("key");
    expect(fresh?.stale).toBe(false);
    expect(cache.isFresh("key")).toBe(true);
    fresh!.snapshot.records[0]!.values.field = "changed";

    now = 1_101;
    const stale = cache.get("key");
    expect(stale?.stale).toBe(true);
    expect(cache.isFresh("key")).toBe(false);
    expect(stale?.snapshot.records[0]?.values.field).toBe("1");

    now = 1_501;
    expect(cache.get("key")).toBeNull();
  });

  it("evicts the least recently used entry and invalidates by project", () => {
    let now = 0;
    const cache = new LedgerRecordCache({ maxEntries: 2, now: () => now });
    cache.set("a", "project-a", { records: [record("a")], total: 1 });
    now += 1;
    cache.set("b", "project-b", { records: [record("b", "project-b")], total: 1 });
    now += 1;
    expect(cache.get("a")).not.toBeNull();
    now += 1;
    cache.set("c", "project-c", { records: [record("c", "project-c")], total: 1 });

    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    cache.invalidateProject("project-a");
    expect(cache.get("a")).toBeNull();
    expect(cache.size).toBe(1);
  });
});
