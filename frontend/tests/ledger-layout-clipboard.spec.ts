import { describe, expect, it } from "vitest";

import type { FieldDefinition } from "@/types/api";
import { previewBatchFieldLabels } from "@/utils/batchFields";
import {
  buildLedgerGridClipboardData,
  expandLedgerSingleCellPaste,
  parseLedgerGridClipboardPayload,
} from "@/utils/ledgerClipboard";
import {
  normalizeLedgerLayoutSettings,
  resolveLedgerProjectLayout,
  withLedgerProjectLayout,
} from "@/utils/ledgerLayoutSettings";

function field(
  id: string,
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    id,
    project_id: "project-1",
    key: `key_${id}`,
    label: id,
    data_type: "text",
    system_key: null,
    is_core: false,
    hidden: false,
    sort_order: 0,
    width: 120,
    options: [],
    ...overrides,
  };
}

describe("ledger project layout settings", () => {
  it("normalizes, persists, and resolves only fields that still exist and are visible", () => {
    const fields = [field("visible"), field("hidden", { hidden: true })];
    const document = withLedgerProjectLayout(
      normalizeLedgerLayoutSettings(null),
      "project-1",
      {
        sort: { fieldId: "visible", order: "descending" },
        filters: {
          visible: { kind: "text", value: "阳性" },
          hidden: { kind: "options", values: ["旧值"] },
        },
        frozenUntilFieldId: "visible",
      },
    );

    expect(document.projects["project-1"]).toEqual({
      sort: { field_id: "visible", direction: "desc" },
      filters: {
        visible: { kind: "text", value: "阳性" },
        hidden: { kind: "options", values: ["旧值"] },
      },
      frozen_until_field_id: "visible",
    });
    expect(resolveLedgerProjectLayout(document, "project-1", fields)).toEqual({
      sort: { fieldId: "visible", order: "descending" },
      filters: { visible: { kind: "text", value: "阳性" } },
      frozenUntilFieldId: "visible",
    });
  });

  it("drops malformed saved values instead of applying an invalid layout", () => {
    const document = normalizeLedgerLayoutSettings({
      version: 1,
      projects: {
        "project-1": {
          sort: { field_id: "visible", direction: "sideways" },
          filters: { visible: { kind: "options", values: ["A", 1] } },
          frozen_until_field_id: 12,
        },
      },
    });

    expect(document.projects["project-1"]).toEqual({
      sort: null,
      filters: { visible: { kind: "options", values: ["A"] } },
      frozen_until_field_id: null,
    });
  });
});

describe("ledger clipboard payload", () => {
  it("anchors copied cells at the selection's top-left corner", () => {
    const values = new Map([
      ["2:3", "右下"],
      ["1:2", "左上"],
      ["2:2", "左下"],
    ]);
    const data = buildLedgerGridClipboardData(
      [
        { rowIndex: 2, columnIndex: 3 },
        { rowIndex: 1, columnIndex: 2 },
        { rowIndex: 2, columnIndex: 2 },
      ],
      ({ rowIndex, columnIndex }) => values.get(`${rowIndex}:${columnIndex}`) ?? "",
    );

    expect(data.plainText).toBe("左上\t\n左下\t右下");
    expect(data.payload.cells).toEqual([
      { rowOffset: 1, columnOffset: 1, value: "右下" },
      { rowOffset: 0, columnOffset: 0, value: "左上" },
      { rowOffset: 1, columnOffset: 0, value: "左下" },
    ]);
    expect(parseLedgerGridClipboardPayload(JSON.stringify(data.payload))).toEqual(data.payload);
  });

  it("rejects negative offsets from obsolete or malformed payloads", () => {
    expect(parseLedgerGridClipboardPayload(JSON.stringify({
      version: 1,
      cells: [{ rowOffset: -1, columnOffset: 0, value: "x" }],
    }))).toBeNull();
  });

  it("expands one copied value across a rectangular selection", () => {
    expect(expandLedgerSingleCellPaste([
      { rowOffset: 0, columnOffset: 0, value: "  保留空格  " },
    ], 2, 3)).toEqual([
      { rowOffset: 0, columnOffset: 0, value: "  保留空格  " },
      { rowOffset: 0, columnOffset: 1, value: "  保留空格  " },
      { rowOffset: 0, columnOffset: 2, value: "  保留空格  " },
      { rowOffset: 1, columnOffset: 0, value: "  保留空格  " },
      { rowOffset: 1, columnOffset: 1, value: "  保留空格  " },
      { rowOffset: 1, columnOffset: 2, value: "  保留空格  " },
    ]);
  });

  it("leaves multi-cell sources unchanged instead of tiling them", () => {
    const source = [
      { rowOffset: 0, columnOffset: 0, value: "A" },
      { rowOffset: 0, columnOffset: 1, value: "B" },
    ];
    expect(expandLedgerSingleCellPaste(source, 3, 4)).toBe(source);
  });
});

describe("batch header preview", () => {
  it("keeps existing headers and blocks duplicates and reserved identifiers", () => {
    const result = previewBatchFieldLabels(
      "病理号\n检测结果\n检测结果\n_record_id",
      [field("pathology", { label: "病理号", is_core: true, system_key: "pathology_number" })],
    );

    expect(result.rows.map((row) => row.status)).toEqual([
      "existing-core",
      "new",
      "duplicate",
      "conflict",
    ]);
    expect(result.newCount).toBe(1);
    expect(result.hasErrors).toBe(true);
  });
});
