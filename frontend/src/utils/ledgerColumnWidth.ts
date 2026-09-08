export const LEDGER_COLUMN_MIN_WIDTH = 32;
export const LEDGER_COLUMN_MAX_WIDTH = 600;

const HEADER_CELL_PADDING_X = 7;
const HEADER_ITEM_GAP = 4;
const HEADER_TOOL_WIDTH = 20;
const SORT_INDICATOR_WIDTH = 13;
const SORT_INDICATOR_MARGIN = -2;
const FILTER_INDICATOR_WIDTH = 5;
const FILTER_INDICATOR_MARGIN = -1;
const GRID_LINE_WIDTH = 1;

export function ledgerCellHorizontalPadding(fontSizePx: number): number {
  return Math.min(6, Math.max(2, fontSizePx * 0.35));
}

export type LedgerBestFitWidthInput = {
  bodyTextWidth: number;
  headerTextWidth: number;
  fontSizePx: number;
  editorWidthPercent: number;
  toolsVisible: boolean;
  sorted: boolean;
  filtered: boolean;
};

export function calculateLedgerBestFitWidth(input: LedgerBestFitWidthInput): number {
  const editorWidthRatio = Math.min(1, Math.max(0.01, input.editorWidthPercent / 100));
  const bodyInnerWidth = input.bodyTextWidth + ledgerCellHorizontalPadding(input.fontSizePx) * 2;
  const bodyColumnWidth = bodyInnerWidth / editorWidthRatio + GRID_LINE_WIDTH;

  let headerContentWidth = input.headerTextWidth;
  if (input.toolsVisible) {
    headerContentWidth += HEADER_ITEM_GAP + HEADER_TOOL_WIDTH;
  }
  if (input.sorted) {
    headerContentWidth += HEADER_ITEM_GAP + SORT_INDICATOR_WIDTH + SORT_INDICATOR_MARGIN;
  }
  if (input.filtered) {
    headerContentWidth += HEADER_ITEM_GAP + FILTER_INDICATOR_WIDTH + FILTER_INDICATOR_MARGIN;
  }
  const headerColumnWidth = headerContentWidth + HEADER_CELL_PADDING_X * 2 + GRID_LINE_WIDTH;

  return Math.min(
    LEDGER_COLUMN_MAX_WIDTH,
    Math.max(LEDGER_COLUMN_MIN_WIDTH, Math.ceil(Math.max(bodyColumnWidth, headerColumnWidth))),
  );
}
