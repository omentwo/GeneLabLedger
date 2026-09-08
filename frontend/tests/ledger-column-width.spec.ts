import { describe, expect, it } from "vitest";

import {
  calculateLedgerBestFitWidth,
  ledgerCellHorizontalPadding,
} from "@/utils/ledgerColumnWidth";

describe("ledger best-fit column width", () => {
  it("scales body padding with the configured font size", () => {
    expect(ledgerCellHorizontalPadding(8)).toBeCloseTo(2.8);
    expect(ledgerCellHorizontalPadding(14)).toBeCloseTo(4.9);
    expect(ledgerCellHorizontalPadding(28)).toBe(6);
  });

  it("uses compact content width instead of a fixed chrome allowance", () => {
    expect(calculateLedgerBestFitWidth({
      bodyTextWidth: 40,
      headerTextWidth: 16,
      fontSizePx: 8,
      editorWidthPercent: 100,
      toolsVisible: false,
      sorted: false,
      filtered: false,
    })).toBe(47);
  });

  it("measures header controls independently from body content", () => {
    expect(calculateLedgerBestFitWidth({
      bodyTextWidth: 10,
      headerTextWidth: 16,
      fontSizePx: 8,
      editorWidthPercent: 100,
      toolsVisible: true,
      sorted: true,
      filtered: true,
    })).toBe(78);
  });

  it("accounts for editors configured narrower than their column", () => {
    expect(calculateLedgerBestFitWidth({
      bodyTextWidth: 40,
      headerTextWidth: 8,
      fontSizePx: 8,
      editorWidthPercent: 50,
      toolsVisible: false,
      sorted: false,
      filtered: false,
    })).toBe(93);
  });

  it("clamps very small and very large results", () => {
    expect(calculateLedgerBestFitWidth({
      bodyTextWidth: 0,
      headerTextWidth: 0,
      fontSizePx: 8,
      editorWidthPercent: 100,
      toolsVisible: false,
      sorted: false,
      filtered: false,
    })).toBe(32);
    expect(calculateLedgerBestFitWidth({
      bodyTextWidth: 1_000,
      headerTextWidth: 0,
      fontSizePx: 14,
      editorWidthPercent: 100,
      toolsVisible: false,
      sorted: false,
      filtered: false,
    })).toBe(600);
  });
});
