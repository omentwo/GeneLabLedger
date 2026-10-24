import { describe, expect, it } from "vitest";

import {
  clampGridCell,
  GRID_CELL_KEY_SEPARATOR,
  gridCellKey,
  gridCellPositionsForRange,
  moveGridCell,
  moveGridCellByTab,
  normalizedGridRange,
  sameGridCell,
  splitGridCellKey,
} from "@/utils/gridSelectionModel";

const SIZE = { rowCount: 3, columnCount: 4 };
const ROWS = [{ id: "row-a" }, { id: "row-b" }, { id: "row-c" }];
const FIELDS = [{ id: "f1" }, { id: "f2" }];

describe("gridSelectionModel clampGridCell", () => {
  it("clamps positions into the grid", () => {
    expect(clampGridCell({ rowIndex: -3, columnIndex: 9 }, SIZE)).toEqual({ rowIndex: 0, columnIndex: 3 });
    expect(clampGridCell({ rowIndex: 1, columnIndex: 2 }, SIZE)).toEqual({ rowIndex: 1, columnIndex: 2 });
  });

  it("keeps row 0 when the table is empty", () => {
    expect(clampGridCell({ rowIndex: 5, columnIndex: 2 }, { rowCount: 0, columnCount: 0 }))
      .toEqual({ rowIndex: 0, columnIndex: 0 });
  });
});

describe("gridSelectionModel moveGridCell", () => {
  it("offsets and clamps in one step", () => {
    expect(moveGridCell({ rowIndex: 2, columnIndex: 3 }, 1, 1, SIZE)).toEqual({ rowIndex: 2, columnIndex: 3 });
    expect(moveGridCell({ rowIndex: 1, columnIndex: 1 }, -1, -2, SIZE)).toEqual({ rowIndex: 0, columnIndex: 0 });
  });
});

describe("gridSelectionModel moveGridCellByTab", () => {
  it("steps within a row and wraps across row boundaries", () => {
    expect(moveGridCellByTab({ rowIndex: 0, columnIndex: 1 }, false, SIZE)).toEqual({ rowIndex: 0, columnIndex: 2 });
    expect(moveGridCellByTab({ rowIndex: 0, columnIndex: 3 }, false, SIZE)).toEqual({ rowIndex: 1, columnIndex: 0 });
    expect(moveGridCellByTab({ rowIndex: 1, columnIndex: 0 }, true, SIZE)).toEqual({ rowIndex: 0, columnIndex: 3 });
  });

  it("stops at the first and last cell", () => {
    expect(moveGridCellByTab({ rowIndex: 0, columnIndex: 0 }, true, SIZE)).toEqual({ rowIndex: 0, columnIndex: 0 });
    expect(moveGridCellByTab({ rowIndex: 2, columnIndex: 3 }, false, SIZE)).toEqual({ rowIndex: 2, columnIndex: 3 });
  });
});

describe("gridSelectionModel normalizedGridRange", () => {
  it("orders anchor and focus regardless of drag direction", () => {
    expect(
      normalizedGridRange({
        anchor: { rowIndex: 4, columnIndex: 1 },
        focus: { rowIndex: 2, columnIndex: 3 },
      }),
    ).toEqual({ rowStart: 2, rowEnd: 4, columnStart: 1, columnEnd: 3 });
  });
});

describe("gridSelectionModel cell keys", () => {
  it("builds keys only for in-bounds cells", () => {
    expect(gridCellKey({ rowIndex: 1, columnIndex: 0 }, ROWS, FIELDS)).toBe(`row-b${GRID_CELL_KEY_SEPARATOR}f1`);
    expect(gridCellKey({ rowIndex: 5, columnIndex: 0 }, ROWS, FIELDS)).toBe("");
    expect(gridCellKey({ rowIndex: 0, columnIndex: 9 }, ROWS, FIELDS)).toBe("");
  });

  it("round-trips through splitGridCellKey", () => {
    const key = gridCellKey({ rowIndex: 0, columnIndex: 1 }, ROWS, FIELDS);
    expect(splitGridCellKey(key)).toEqual(["row-a", "f2"]);
  });

  it("returns null for keys without the separator", () => {
    expect(splitGridCellKey("row-a")).toBeNull();
    expect(splitGridCellKey("")).toBeNull();
  });
});

describe("gridSelectionModel gridCellPositionsForRange", () => {
  it("expands a range into positions and skips out-of-bounds cells", () => {
    const positions = gridCellPositionsForRange(
      { anchor: { rowIndex: 0, columnIndex: 0 }, focus: { rowIndex: 2, columnIndex: 1 } },
      ROWS,
      FIELDS,
    );
    expect(positions).toHaveLength(6);
    expect(positions[0]).toEqual({ rowIndex: 0, columnIndex: 0 });
    expect(positions.at(-1)).toEqual({ rowIndex: 2, columnIndex: 1 });
    const clipped = gridCellPositionsForRange(
      { anchor: { rowIndex: 0, columnIndex: 0 }, focus: { rowIndex: 9, columnIndex: 9 } },
      ROWS,
      FIELDS,
    );
    expect(clipped).toHaveLength(ROWS.length * FIELDS.length);
  });
});

describe("gridSelectionModel sameGridCell", () => {
  it("compares coordinates and treats null as different", () => {
    expect(sameGridCell({ rowIndex: 1, columnIndex: 2 }, { rowIndex: 1, columnIndex: 2 })).toBe(true);
    expect(sameGridCell({ rowIndex: 1, columnIndex: 2 }, { rowIndex: 2, columnIndex: 1 })).toBe(false);
    expect(sameGridCell(null, { rowIndex: 0, columnIndex: 0 })).toBe(false);
    expect(sameGridCell(null, null)).toBe(false);
  });
});
