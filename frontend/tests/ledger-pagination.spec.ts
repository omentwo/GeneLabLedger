import { describe, expect, it } from "vitest";

import { clampLedgerPage, ledgerPageForRecord } from "@/utils/ledgerPagination";

describe("ledger pagination", () => {
  const recordIds = Array.from({ length: 501 }, (_, index) => `record-${index + 1}`);

  it("locates a newly appended record on its real page", () => {
    expect(ledgerPageForRecord(recordIds, "record-501", 200)).toBe(3);
  });

  it("uses the current page size and handles filtered-out records", () => {
    expect(ledgerPageForRecord(recordIds, "record-501", 500)).toBe(2);
    expect(ledgerPageForRecord(recordIds, "missing", 200)).toBeNull();
    expect(ledgerPageForRecord(recordIds, "record-1", 0)).toBeNull();
  });

  it("keeps the current page when it is valid and clamps only invalid pages", () => {
    expect(clampLedgerPage(3, 550, 200)).toBe(3);
    expect(clampLedgerPage(2, 550, 200)).toBe(2);
    expect(clampLedgerPage(3, 100, 200)).toBe(1);
  });
});
