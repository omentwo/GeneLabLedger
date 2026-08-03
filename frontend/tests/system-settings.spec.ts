import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEDGER_DISPLAY_SETTINGS,
  DEFAULT_LEDGER_SHORTCUT_SETTINGS,
  normalizeLedgerDisplaySettings,
  normalizeLedgerShortcutSettings,
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
        fontSizePx: 30,
        zoomPercent: 206,
      }),
    ).toEqual({
      rowPaddingY: 12,
      editorWidthPercent: 100,
      editorHeightPercent: 75,
      fontFamily: "system",
      fontSizePx: 28,
      zoomPercent: 200,
    });
    expect(normalizeLedgerDisplaySettings({ rowPaddingY: -4, fillEditors: true })).toEqual({
      rowPaddingY: 0,
      editorWidthPercent: 100,
      editorHeightPercent: 100,
      fontFamily: "system",
      fontSizePx: 14,
      zoomPercent: 100,
    });
    expect(normalizeLedgerDisplaySettings({ rowPaddingY: -4, fillEditors: false })).toEqual({
      rowPaddingY: 0,
      editorWidthPercent: 92,
      editorHeightPercent: 100,
      fontFamily: "system",
      fontSizePx: 14,
      zoomPercent: 100,
    });
    expect(normalizeLedgerDisplaySettings({ fontSizePx: 1, zoomPercent: 49 })).toMatchObject({
      fontSizePx: 8,
      zoomPercent: 50,
    });
  });
});

describe("ledger shortcut settings", () => {
  it("falls back to default modifier combinations", () => {
    expect(normalizeLedgerShortcutSettings(null)).toEqual(DEFAULT_LEDGER_SHORTCUT_SETTINGS);
  });

  it("keeps supported modifiers in a stable order", () => {
    expect(
      normalizeLedgerShortcutSettings({
        navigation: ["Shift", "Alt", "Shift", "unknown"],
        extendSelection: ["CapsLock", "Control"],
      }),
    ).toEqual({
      navigation: ["Alt", "Shift"],
      extendSelection: ["Control", "CapsLock"],
    });
  });
});
