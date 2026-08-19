import { describe, expect, it } from "vitest";

import type { FieldDefinition, ProjectRecord } from "@/types/api";
import {
  applyLedgerTableView,
  reanchorInsertedDraftGroup,
  type LedgerFieldFilter,
  type LedgerInsertedGroupRegistry,
  type LedgerRow,
} from "@/utils/ledgerTableView";

const field = (id: string, dataType: FieldDefinition["data_type"], systemKey: string | null = null): FieldDefinition => ({
  id,
  project_id: "p1",
  key: id,
  label: id,
  data_type: dataType,
  system_key: systemKey,
  is_core: Boolean(systemKey),
  hidden: false,
  sort_order: 0,
  width: 120,
  options: [],
});
const fields = [
  field("pathology", "text", "pathology_number"),
  field("date", "date", "experiment_date"),
  field("amount", "number"),
  field("status", "select", "status"),
  field("note", "text"),
];

function record(id: string, values: Partial<ProjectRecord> & { amount?: string; note?: string }): ProjectRecord {
  return {
    id,
    project_id: "p1",
    project_name: "项目",
    position: values.position ?? 0,
    pathology_number: values.pathology_number ?? id,
    status: values.status ?? "待实验",
    experiment_date: values.experiment_date ?? null,
    experiment_number: null,
    report_generated: false,
    locked: false,
    highlight_color: null,
    values: {
      amount: values.amount ?? "",
      note: values.note ?? "",
    },
    created_at: "",
    updated_at: "",
  };
}

describe("ledger table local sorting and filtering", () => {
  const rows: LedgerRow[] = [
    record("r1", { pathology_number: "26-10", experiment_date: "2026-01-10", amount: "10", status: "待实验", note: "Alpha" }),
    record("r2", { pathology_number: "26-2", experiment_date: "2026-02-10", amount: "2", status: "已完成", note: "Beta" }),
    record("r3", { pathology_number: "26-1", experiment_date: "2025-12-10", amount: "", status: "待实验", note: "" }),
    { ...record("draft", { pathology_number: "" }), _draft: true },
  ];

  it("sorts numeric, date and pathology fields while keeping drafts last", () => {
    expect(applyLedgerTableView(rows, fields, { fieldId: "amount", order: "ascending" }, {})).toMatchObject([
      { id: "r2" }, { id: "r1" }, { id: "r3" }, { id: "draft" },
    ]);
    expect(applyLedgerTableView(rows, fields, { fieldId: "pathology", order: "ascending" }, {})).toMatchObject([
      { id: "r3" }, { id: "r2" }, { id: "r1" }, { id: "draft" },
    ]);
    expect(applyLedgerTableView(rows, fields, { fieldId: "date", order: "descending" }, {})).toMatchObject([
      { id: "r2" }, { id: "r1" }, { id: "r3" }, { id: "draft" },
    ]);
  });

  it("filters text, options, dates and blank values", () => {
    const textFilter: Record<string, LedgerFieldFilter> = {
      note: { kind: "text", value: "alp" },
    };
    expect(applyLedgerTableView(rows, fields, null, textFilter).map((row) => row.id)).toEqual(["r1", "draft"]);

    const optionFilter: Record<string, LedgerFieldFilter> = {
      status: { kind: "options", values: ["已完成"] },
    };
    expect(applyLedgerTableView(rows, fields, null, optionFilter).map((row) => row.id)).toEqual(["r2", "draft"]);

    const dateFilter: Record<string, LedgerFieldFilter> = {
      date: { kind: "date-range", start: "2026-01-01", end: "2026-12-31" },
    };
    expect(applyLedgerTableView(rows, fields, null, dateFilter).map((row) => row.id)).toEqual(["r1", "r2", "draft"]);

    const blankFilter: Record<string, LedgerFieldFilter> = {
      note: { kind: "options", values: [""] },
    };
    expect(applyLedgerTableView(rows, fields, null, blankFilter).map((row) => row.id)).toEqual(["r3", "draft"]);
  });

  it("combines filters across fields with AND semantics", () => {
    const filters: Record<string, LedgerFieldFilter> = {
      status: { kind: "options", values: ["待实验"] },
      note: { kind: "text", value: "alpha" },
    };
    expect(applyLedgerTableView(rows, fields, null, filters).map((row) => row.id)).toEqual(["r1", "draft"]);
  });

  it("keeps default record positions and inserts anchored drafts around the target", () => {
    const positioned: LedgerRow[] = [
      record("r3", { position: 3 }),
      record("r1", { position: 1 }),
      record("r2", { position: 2 }),
      {
        ...record("before", {}),
        _draft: true,
        _insertAnchorId: "r2",
        _insertPlacement: "before",
      },
      {
        ...record("after", {}),
        _draft: true,
        _insertAnchorId: "r2",
        _insertPlacement: "after",
      },
      { ...record("tail", {}), _draft: true },
    ];

    expect(applyLedgerTableView(positioned, fields, null, {}).map((row) => row.id)).toEqual([
      "r1",
      "before",
      "r2",
      "after",
      "r3",
      "tail",
    ]);
  });

  it("falls back to ledger position when a saved sort field no longer exists", () => {
    const positioned: LedgerRow[] = [
      record("r3", { position: 3 }),
      record("r1", { position: 1 }),
      record("r2", { position: 2 }),
    ];

    expect(
      applyLedgerTableView(positioned, fields, { fieldId: "deleted", order: "ascending" }, {})
        .map((row) => row.id),
    ).toEqual(["r1", "r2", "r3"]);
  });
});

function insertedDraft(
  id: string,
  order: number,
  placement: "before" | "after",
): LedgerRow {
  return {
    ...record(id, {}),
    _draft: true,
    _insertAnchorId: "anchor",
    _insertPlacement: placement,
    _insertGroupId: `group-${placement}`,
    _insertGroupOrder: order,
    _insertOriginAnchorId: "anchor",
    _insertOriginPlacement: placement,
  };
}

function simulateOutOfOrderDraftSaves(
  placement: "before" | "after",
  saveOrder: string[],
): string[] {
  const drafts = [
    insertedDraft("a", 0, placement),
    insertedDraft("b", 1, placement),
    insertedDraft("c", 2, placement),
  ];
  const persisted = placement === "before" ? ["head", "anchor"] : ["anchor", "tail"];
  const registry: LedgerInsertedGroupRegistry = new Map();

  saveOrder.forEach((id) => {
    const index = drafts.findIndex((draft) => draft.id === id);
    const draft = drafts[index]!;
    const anchorIndex = persisted.indexOf(draft._insertAnchorId!);
    persisted.splice(anchorIndex + (draft._insertPlacement === "after" ? 1 : 0), 0, id);
    reanchorInsertedDraftGroup(drafts, draft, id, registry);
    drafts.splice(index, 1);
  });
  return persisted;
}

describe("multi-row insertion anchoring", () => {
  it("preserves requested order when rows below an anchor are saved out of order", () => {
    expect(simulateOutOfOrderDraftSaves("after", ["c", "a", "b"])).toEqual([
      "anchor",
      "a",
      "b",
      "c",
      "tail",
    ]);
  });

  it("preserves requested order when rows above an anchor are saved out of order", () => {
    expect(simulateOutOfOrderDraftSaves("before", ["b", "c", "a"])).toEqual([
      "head",
      "a",
      "b",
      "c",
      "anchor",
    ]);
  });
});
