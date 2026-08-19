import { describe, expect, it } from "vitest";

import {
  createLedgerCellHistoryEntry,
  createLedgerHistoryEntry,
  LEDGER_HISTORY_LIMIT,
  useLedgerHistory,
} from "@/composables/useLedgerHistory";
import type { ProjectRecord } from "@/types/api";

function record(id: string): ProjectRecord {
  return {
    id,
    project_id: "project-1",
    project_name: "项目 1",
    position: 1,
    pathology_number: id,
    status: "待实验",
    experiment_date: null,
    experiment_number: null,
    report_generated: false,
    locked: false,
    highlight_color: null,
    values: {},
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

describe("ledger history", () => {
  it("stores large cell operations as sparse cell changes", () => {
    const entry = createLedgerCellHistoryEntry("project-1", "批量填充", [
      { recordId: "r1", fieldId: "f1", before: "1", after: "2" },
      { recordId: "r2", fieldId: "f1", before: "3", after: "4" },
    ]);

    expect(entry.kind).toBe("cells");
    expect(entry.changes).toEqual([
      { recordId: "r1", fieldId: "f1", before: "1", after: "2" },
      { recordId: "r2", fieldId: "f1", before: "3", after: "4" },
    ]);
    expect("before" in entry).toBe(false);
  });

  it("keeps only the most recent 20 operations", () => {
    const history = useLedgerHistory();
    for (let index = 0; index < 25; index += 1) {
      history.push(createLedgerHistoryEntry("project-1", `操作 ${index}`, [], [record(String(index))]));
    }

    expect(history.entries.value).toHaveLength(LEDGER_HISTORY_LIMIT);
    expect(history.entries.value[0]?.label).toBe("操作 5");
    expect(history.entries.value.at(-1)?.label).toBe("操作 24");
    expect(history.canUndo.value).toBe(true);
    expect(history.canRedo.value).toBe(false);
  });

  it("moves the cursor for undo/redo and discards redo after a new operation", async () => {
    const history = useLedgerHistory();
    history.push(createLedgerHistoryEntry("project-1", "第一步", [], [record("1")]));
    history.push(createLedgerHistoryEntry("project-1", "第二步", [], [record("2")]));
    const replayed: string[] = [];

    expect(
      await history.undo(async (entry) => {
        replayed.push(`undo:${entry.label}`);
      }),
    ).toBe(true);
    expect(replayed).toEqual(["undo:第二步"]);
    expect(history.canRedo.value).toBe(true);

    history.push(createLedgerHistoryEntry("project-1", "分支操作", [], [record("3")]));
    expect(history.entries.value.map((entry) => entry.label)).toEqual(["第一步", "分支操作"]);
    expect(history.canRedo.value).toBe(false);

    expect(
      await history.redo(async (entry) => {
        replayed.push(`redo:${entry.label}`);
      }),
    ).toBe(false);
  });
});
