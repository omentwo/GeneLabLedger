import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEDGER_RANGE_SETTINGS,
  ledgerMonthStart,
  normalizeLedgerRangeSettings,
  resolveLedgerRecordRange,
} from "@/utils/ledgerRangeSettings";

describe("ledger display ranges", () => {
  it("defaults existing installations to all records", () => {
    expect(normalizeLedgerRangeSettings(null)).toEqual(DEFAULT_LEDGER_RANGE_SETTINGS);
    expect(resolveLedgerRecordRange(DEFAULT_LEDGER_RANGE_SETTINGS)).toEqual({});
  });

  it("uses the ledger date and clamps calendar month boundaries", () => {
    expect(ledgerMonthStart("2026-10-11", 3)).toBe("2026-07-11");
    expect(ledgerMonthStart("2026-03-31", 1)).toBe("2026-02-28");
    expect(ledgerMonthStart("2024-03-31", 1)).toBe("2024-02-29");
    expect(ledgerMonthStart("2026-01-31", 2)).toBe("2025-11-30");
    expect(resolveLedgerRecordRange({ ...DEFAULT_LEDGER_RANGE_SETTINGS, mode: "months" }, "2026-10-11"))
      .toEqual({ experiment_date_from: "2026-07-11", experiment_date_to: "2026-10-11", include_undated: true });
  });

  it("keeps record limits independent of transport batch sizes", () => {
    expect(resolveLedgerRecordRange({ ...DEFAULT_LEDGER_RANGE_SETTINGS, mode: "count", count: 20 }))
      .toEqual({ tail_count: 20 });
    expect(normalizeLedgerRangeSettings({ mode: "count", count: -1, months: Infinity }))
      .toMatchObject({ count: 1, months: 3 });
  });
});
