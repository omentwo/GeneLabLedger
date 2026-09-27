import { describe, expect, it } from "vitest";

import {
  applyRecordSelectionRange,
  applyVisibleRecordSelection,
  normalizeRecordSelectionRange,
  recordSelectionRangeContains,
  recordMatchesSelectionScope,
} from "@/utils/ledgerRecordSelection";

const records = [
  { id: "open-1", locked: false },
  { id: "locked-1", locked: true },
  { id: "open-2", locked: false },
];

describe("ledger record selection scope", () => {
  it("allows every record in the all-records scope", () => {
    expect(recordMatchesSelectionScope(records[1]!, "all")).toBe(true);
  });

  it("excludes locked records in the unlocked scope", () => {
    expect(recordMatchesSelectionScope(records[0]!, "unlocked")).toBe(true);
    expect(recordMatchesSelectionScope(records[1]!, "unlocked")).toBe(false);
  });

  it("selects all eligible records while preserving off-page selections", () => {
    const result = applyVisibleRecordSelection({
      visibleRecords: records,
      selectedIds: new Set(["off-page"]),
      scope: "unlocked",
      action: "select-all",
    });
    expect([...result]).toEqual(["off-page", "open-1", "open-2"]);
  });

  it("inverts only eligible records", () => {
    const result = applyVisibleRecordSelection({
      visibleRecords: records,
      selectedIds: new Set(["open-1", "locked-1"]),
      scope: "unlocked",
      action: "invert",
    });
    expect([...result]).toEqual(["locked-1", "open-2"]);
  });

  it("normalizes forward and reverse drag ranges", () => {
    expect(normalizeRecordSelectionRange(1, 3)).toEqual({ start: 1, end: 3 });
    expect(normalizeRecordSelectionRange(4, 2)).toEqual({ start: 2, end: 4 });
    expect(recordSelectionRangeContains({ start: 2, end: 4 }, 3)).toBe(true);
    expect(recordSelectionRangeContains({ start: 2, end: 4 }, 5)).toBe(false);
  });

  it("applies a dragged range once while preserving selections outside it", () => {
    const result = applyRecordSelectionRange({
      records,
      initialSelectedIds: new Set(["off-page", "open-2"]),
      startIndex: 0,
      endIndex: 2,
      selected: true,
      isSelectable: (record) => !record.locked,
    });
    expect([...result]).toEqual(["off-page", "open-2", "open-1"]);
  });

  it("supports reverse drag deselection and skips ineligible records", () => {
    const result = applyRecordSelectionRange({
      records,
      initialSelectedIds: new Set(["off-page", "open-1", "locked-1", "open-2"]),
      startIndex: 2,
      endIndex: 0,
      selected: false,
      isSelectable: (record) => !record.locked,
    });
    expect([...result]).toEqual(["off-page", "locked-1"]);
  });
});
