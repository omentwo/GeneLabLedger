import { describe, expect, it } from "vitest";

import {
  applyVisibleRecordSelection,
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
});
