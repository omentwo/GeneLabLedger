import { describe, expect, it } from "vitest";

import { summarizeLedgerSelection } from "@/utils/ledgerSelectionStats";

describe("ledger selection statistics", () => {
  it("counts only fields declared as numeric in numeric summaries", () => {
    const summary = summarizeLedgerSelection([
      { value: "26-07834", dataType: "text" },
      { value: "100", dataType: "number" },
      { value: "120.5", dataType: "number" },
      { value: "not-a-number", dataType: "number" },
      { value: "", dataType: "number" },
    ]);

    expect(summary).toEqual({
      selected: 5,
      nonEmpty: 4,
      numericCount: 2,
      sum: 220.5,
      average: 110.25,
      min: 100,
      max: 120.5,
    });
  });
});
