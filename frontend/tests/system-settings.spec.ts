import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEDGER_DISPLAY_SETTINGS,
  normalizeLedgerDisplaySettings,
} from "@/api/system";

describe("ledger display settings", () => {
  it("falls back to defaults for missing values", () => {
    expect(normalizeLedgerDisplaySettings(null)).toEqual(DEFAULT_LEDGER_DISPLAY_SETTINGS);
  });

  it("clamps row padding and editor size percentages", () => {
    expect(
      normalizeLedgerDisplaySettings({
        rowPaddingY: 99,
        editorWidthPercent: 120,
        editorHeightPercent: 50,
      }),
    ).toEqual({
      rowPaddingY: 12,
      editorWidthPercent: 100,
      editorHeightPercent: 75,
    });
    expect(normalizeLedgerDisplaySettings({ rowPaddingY: -4, fillEditors: true })).toEqual({
      rowPaddingY: 0,
      editorWidthPercent: 100,
      editorHeightPercent: 100,
    });
    expect(normalizeLedgerDisplaySettings({ rowPaddingY: -4, fillEditors: false })).toEqual({
      rowPaddingY: 0,
      editorWidthPercent: 92,
      editorHeightPercent: 100,
    });
  });
});
