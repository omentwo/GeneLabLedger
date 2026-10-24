import { describe, expect, it } from "vitest";

import type { FieldDefinition } from "@/types/api";
import {
  buildBatchNewRecords,
  countMissingPasteRows,
  parsePasteEntries,
  resolvePasteTargets,
} from "@/utils/ledgerPaste";
import type { LedgerRow } from "@/utils/ledgerTableView";

function field(id: string, isCore = false): FieldDefinition {
  return { id, is_core: isCore } as FieldDefinition;
}

function row(overrides: Partial<LedgerRow> & { id: string }): LedgerRow {
  return {
    project_id: "p", project_name: "p", position: 1,
    pathology_number: "", block_number: null, status: "待实验",
    experiment_date: null, experiment_number: null, report_generated: false,
    locked: false, highlight_color: null, values: {},
    created_at: "", updated_at: "",
    ...overrides,
  } as LedgerRow;
}

describe("parsePasteEntries", () => {
  it("按 TSV 解析行列偏移", () => {
    expect(parsePasteEntries("a\tb\nc\td")).toEqual([
      { rowOffset: 0, columnOffset: 0, value: "a" },
      { rowOffset: 0, columnOffset: 1, value: "b" },
      { rowOffset: 1, columnOffset: 0, value: "c" },
      { rowOffset: 1, columnOffset: 1, value: "d" },
    ]);
  });

  it("兼容 CRLF、吞掉末尾换行、保留中间空行", () => {
    expect(parsePasteEntries("a\r\nb")).toEqual([
      { rowOffset: 0, columnOffset: 0, value: "a" },
      { rowOffset: 1, columnOffset: 0, value: "b" },
    ]);
    expect(parsePasteEntries("a\n")).toEqual([{ rowOffset: 0, columnOffset: 0, value: "a" }]);
    expect(parsePasteEntries("a\n\nb")).toHaveLength(3);
  });

  it("空文本不产生条目", () => {
    expect(parsePasteEntries("")).toEqual([]);
  });
});

describe("countMissingPasteRows", () => {
  it("按最大行偏移与起始行计算需要补建的草稿行数", () => {
    const entries = parsePasteEntries("a\nb\nc");
    expect(countMissingPasteRows(entries, 3, 4)).toBe(2);
    expect(countMissingPasteRows(entries, 0, 5)).toBe(0);
  });

  it("空条目仍需覆盖起始行本身", () => {
    expect(countMissingPasteRows([], 3, 5)).toBe(0);
    expect(countMissingPasteRows([], 10, 5)).toBe(6);
  });
});

describe("resolvePasteTargets", () => {
  const fields = [field("f0"), field("f1"), field("f2")];

  it("映射偏移到行列，文本粘贴去空白，exact 粘贴原样保留", () => {
    const rows = [row({ id: "r0", values: { f1: "old" } }), row({ id: "r1" })];
    const text = resolvePasteTargets(
      [{ rowOffset: 0, columnOffset: 1, value: "  x  " }], 0, 0, rows, fields, { exact: false },
    );
    expect(text.targets).toEqual([
      {
        position: { rowIndex: 0, columnIndex: 1 },
        record: rows[0],
        field: fields[1],
        value: "x",
        expectedValue: "old",
      },
    ]);
    const exact = resolvePasteTargets(
      [{ rowOffset: 0, columnOffset: 1, value: "  x  " }], 0, 0, rows, fields, { exact: true },
    );
    expect(exact.targets[0]?.value).toBe("  x  ");
  });

  it("越界行/列与缺失字段被忽略", () => {
    const rows = [row({ id: "r0" })];
    const resolved = resolvePasteTargets(
      [
        { rowOffset: 5, columnOffset: 0, value: "x" },
        { rowOffset: 0, columnOffset: 9, value: "x" },
        { rowOffset: 0, columnOffset: -1, value: "x" },
        { rowOffset: -3, columnOffset: 0, value: "x" },
      ], 0, 0, rows, fields, { exact: false },
    );
    expect(resolved.targets).toEqual([]);
    expect(resolved.changedPositions).toEqual([]);
  });

  it("锁定单元格计入 skippedLocked，位置保留但无写入目标", () => {
    const rows = [row({ id: "r0", locked: true }), row({ id: "r1" })];
    const resolved = resolvePasteTargets(
      [
        { rowOffset: 0, columnOffset: 0, value: "a" },
        { rowOffset: 1, columnOffset: 0, value: "b" },
      ], 0, 0, rows, fields, { exact: false },
    );
    expect(resolved.skippedLocked).toBe(1);
    expect(resolved.changedPositions).toEqual([
      { rowIndex: 0, columnIndex: 0 },
      { rowIndex: 1, columnIndex: 0 },
    ]);
    expect(resolved.targets.map((target) => target.record.id)).toEqual(["r1"]);
  });

  it("重复目标位置只计一次", () => {
    const rows = [row({ id: "r0" })];
    const resolved = resolvePasteTargets(
      [
        { rowOffset: 0, columnOffset: 0, value: "a" },
        { rowOffset: 0, columnOffset: 0, value: "b" },
      ], 0, 0, rows, fields, { exact: false },
    );
    expect(resolved.changedPositions).toEqual([{ rowIndex: 0, columnIndex: 0 }]);
    expect(resolved.targets).toHaveLength(2);
  });
});

describe("buildBatchNewRecords", () => {
  it("核心字段不入 values，非核心字段裁剪后收录", () => {
    const fields = [field("pathology", true), field("note"), field("memo")];
    const [payload] = buildBatchNewRecords(
      [row({ id: "draft-1", pathology_number: " P-1 ", values: { note: " 数据 ", memo: "" } })],
      fields,
    );
    expect(payload?.client_id).toBe("draft-1");
    expect(payload?.pathology_number).toBe("P-1");
    expect(payload?.values).toEqual({ note: "数据", memo: "" });
  });

  it("空可空字段归一为 null，日期字段走规范化", () => {
    const [payload] = buildBatchNewRecords(
      [row({
        id: "d", block_number: "   ", experiment_number: "",
        experiment_date: "2026-10-24",
      })],
      [field("note")],
    );
    expect(payload?.block_number).toBeNull();
    expect(payload?.experiment_number).toBeNull();
    expect(payload?.experiment_date).toBe("2026-10-24");
  });

  it("插入锚点草稿携带插入方向", () => {
    const before = buildBatchNewRecords(
      [row({ id: "d", _insertAnchorId: "anchor", _insertPlacement: "before" })],
      [],
    )[0];
    const after = buildBatchNewRecords(
      [row({ id: "d", _insertAnchorId: "anchor", _insertPlacement: "after" })],
      [],
    )[0];
    expect(before).toMatchObject({ insert_before_record_id: "anchor" });
    expect(before).not.toHaveProperty("insert_after_record_id");
    expect(after).toMatchObject({ insert_after_record_id: "anchor" });
    expect(after).not.toHaveProperty("insert_before_record_id");
  });
});
