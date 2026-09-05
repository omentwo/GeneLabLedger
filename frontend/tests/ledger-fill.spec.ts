import { describe, expect, it } from "vitest";
import { buildGridFillEntries } from "@/utils/ledgerFill";
import type { FieldDefinition, ProjectRecord } from "@/types/api";
import type { GridFillMode } from "@/utils/ledgerFill";

function fill(matrix: string[][], dataType = "text") {
  const fields = Array.from({ length: 3 }, (_, i) => ({ id: String(i), data_type: dataType })) as FieldDefinition[];
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: String(i) })) as ProjectRecord[];
  return buildGridFillEntries(
    { rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 },
    { rowStart: 0, rowEnd: 2, columnStart: 0, columnEnd: 2 },
    fields, rows, (row, field) => matrix[Number(row.id)]?.[Number(field.id)] ?? "",
  );
}

function fillColumn(
  values: string[],
  targetRowStart: number,
  targetRowEnd: number,
  sourceRowStart = 0,
  dataType = "text",
  mode: GridFillMode = "series",
) {
  const sourceRowEnd = sourceRowStart + values.length - 1;
  const rowCount = Math.max(sourceRowEnd, targetRowEnd) + 1;
  const field = { id: "0", data_type: dataType } as FieldDefinition;
  const rows = Array.from({ length: rowCount }, (_, index) => ({ id: String(index) })) as ProjectRecord[];
  return buildGridFillEntries(
    { rowStart: sourceRowStart, rowEnd: sourceRowEnd, columnStart: 0, columnEnd: 0 },
    { rowStart: targetRowStart, rowEnd: targetRowEnd, columnStart: 0, columnEnd: 0 },
    [field],
    rows,
    (row) => values[Number(row.id) - sourceRowStart] ?? "",
    mode,
  );
}

describe("diagonal fill", () => {
  it("cycles text horizontally in the source rows and vertically below", () => {
    expect(fill([["A", "B"], ["C", "D"]])).toEqual([
      { rowOffset: 0, columnOffset: 2, value: "A" },
      { rowOffset: 1, columnOffset: 2, value: "C" },
      { rowOffset: 2, columnOffset: 0, value: "A" },
      { rowOffset: 2, columnOffset: 1, value: "B" },
      { rowOffset: 2, columnOffset: 2, value: "A" },
    ]);
  });
  it("extends numeric and date series in the upper-right region", () => {
    expect(fill([["1", "2"], ["3", "4"]]).slice(0, 2).map((cell) => cell.value)).toEqual(["3", "5"]);
    expect(fill([["2026-09-01", "2026-09-02"], ["2026-09-03", "2026-09-04"]], "date")
      .slice(0, 2).map((cell) => cell.value)).toEqual(["2026-09-03", "2026-09-05"]);
  });

  it("increments the last numeric part of WPS-style text-number series", () => {
    expect(fillColumn(["260903-1"], 0, 3).map((cell) => cell.value)).toEqual([
      "260903-2",
      "260903-3",
      "260903-4",
    ]);
    expect(fillColumn(["第1号", "第3号"], 0, 3).map((cell) => cell.value)).toEqual([
      "第5号",
      "第7号",
    ]);
  });

  it("preserves leading zeroes in integer and text-number series", () => {
    expect(fillColumn(["001"], 0, 2).map((cell) => cell.value)).toEqual(["002", "003"]);
    expect(fillColumn(["Batch-001", "Batch-003"], 0, 3).map((cell) => cell.value)).toEqual([
      "Batch-005",
      "Batch-007",
    ]);
  });

  it("fills built-in weekday and month series cyclically", () => {
    expect(fillColumn(["星期五"], 0, 3).map((cell) => cell.value)).toEqual([
      "星期六",
      "星期日",
      "星期一",
    ]);
    expect(fillColumn(["12月"], 0, 2).map((cell) => cell.value)).toEqual(["1月", "2月"]);
  });

  it("copies instead of extending a series when copy mode is requested", () => {
    expect(fillColumn(["260903-1"], 0, 3, 0, "text", "copy").map((cell) => cell.value)).toEqual([
      "260903-1",
      "260903-1",
      "260903-1",
    ]);
    expect(fillColumn(["1", "2"], 0, 4, 0, "number", "copy").map((cell) => cell.value)).toEqual([
      "1",
      "2",
      "1",
    ]);
    expect(fillColumn(["  原样保留  "], 0, 1, 0, "text", "copy")[0]?.value).toBe(
      "  原样保留  ",
    );
  });

  it("preserves text whitespace and does not overflow huge decimal values", () => {
    expect(fillColumn(["  260903-1  "], 0, 1)[0]?.value).toBe("  260903-2  ");
    expect(fillColumn(["  普通文本  "], 0, 1)[0]?.value).toBe("  普通文本  ");
    const hugeDecimal = `${"9".repeat(400)}.1`;
    expect(fillColumn([hugeDecimal], 0, 1)[0]?.value).toBe(hugeDecimal);
  });

  it("extends numeric and text-number series upward", () => {
    expect(fillColumn(["3", "5"], 0, 3, 2, "number")).toEqual([
      { rowOffset: -2, columnOffset: 0, value: "-1" },
      { rowOffset: -1, columnOffset: 0, value: "1" },
    ]);
    expect(fillColumn(["样本3", "样本5"], 0, 3, 2).map((cell) => cell.value)).toEqual([
      "样本-1",
      "样本1",
    ]);
  });

  it("extends a numeric series to the left", () => {
    const fields = Array.from({ length: 4 }, (_, index) => ({
      id: String(index),
      data_type: "number",
    })) as FieldDefinition[];
    const rows = [{ id: "0" }] as ProjectRecord[];
    const entries = buildGridFillEntries(
      { rowStart: 0, rowEnd: 0, columnStart: 2, columnEnd: 3 },
      { rowStart: 0, rowEnd: 0, columnStart: 0, columnEnd: 3 },
      fields,
      rows,
      (_row, field) => ({ "2": "3", "3": "5" })[field.id] ?? "",
    );
    expect(entries).toEqual([
      { rowOffset: 0, columnOffset: -2, value: "-1" },
      { rowOffset: 0, columnOffset: -1, value: "1" },
    ]);
  });
});
