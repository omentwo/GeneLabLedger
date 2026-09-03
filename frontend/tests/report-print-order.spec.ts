import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPORT_PRINT_ORDER,
  reportRecordIdsInPrintOrder,
} from "@/utils/reportPrint";

describe("report print order", () => {
  const ledgerRecords = [
    { id: "record-1" },
    { id: "record-2" },
    { id: "record-3" },
    { id: "record-4" },
  ];

  it("prints from the last selected ledger row to the first by default", () => {
    const selectedRecords = [ledgerRecords[0]!, ledgerRecords[3]!, ledgerRecords[1]!];

    expect(DEFAULT_REPORT_PRINT_ORDER).toBe("descending");
    expect(reportRecordIdsInPrintOrder(ledgerRecords, selectedRecords)).toEqual([
      "record-4",
      "record-2",
      "record-1",
    ]);
  });

  it("can print selected reports from the first ledger row to the last", () => {
    const selectedRecords = [ledgerRecords[3]!, ledgerRecords[0]!, ledgerRecords[1]!];

    expect(reportRecordIdsInPrintOrder(ledgerRecords, selectedRecords, "ascending")).toEqual([
      "record-1",
      "record-2",
      "record-4",
    ]);
  });
});
