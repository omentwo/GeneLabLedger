export const LEDGER_GRID_CLIPBOARD_MIME = "application/x-gene-lab-ledger-cells";

export interface LedgerGridCellPosition {
  rowIndex: number;
  columnIndex: number;
}

export interface LedgerGridClipboardCell {
  rowOffset: number;
  columnOffset: number;
  value: string;
}

export interface LedgerGridClipboardPayload {
  version: 1;
  cells: LedgerGridClipboardCell[];
}

function positionKey(position: LedgerGridCellPosition): string {
  return `${position.rowIndex}:${position.columnIndex}`;
}

export function buildLedgerGridClipboardData(
  positions: LedgerGridCellPosition[],
  readValue: (position: LedgerGridCellPosition) => string,
): { plainText: string; payload: LedgerGridClipboardPayload } {
  if (!positions.length) {
    return { plainText: "", payload: { version: 1, cells: [] } };
  }
  const selectedKeys = new Set(positions.map(positionKey));
  const rowStart = Math.min(...positions.map((position) => position.rowIndex));
  const rowEnd = Math.max(...positions.map((position) => position.rowIndex));
  const columnStart = Math.min(...positions.map((position) => position.columnIndex));
  const columnEnd = Math.max(...positions.map((position) => position.columnIndex));
  const matrix: string[] = [];
  for (let rowIndex = rowStart; rowIndex <= rowEnd; rowIndex += 1) {
    const values: string[] = [];
    for (let columnIndex = columnStart; columnIndex <= columnEnd; columnIndex += 1) {
      const position = { rowIndex, columnIndex };
      values.push(selectedKeys.has(positionKey(position)) ? readValue(position) : "");
    }
    matrix.push(values.join("\t"));
  }
  return {
    plainText: matrix.join("\n"),
    payload: {
      version: 1,
      cells: positions.map((position) => ({
        rowOffset: position.rowIndex - rowStart,
        columnOffset: position.columnIndex - columnStart,
        value: readValue(position),
      })),
    },
  };
}

export function parseLedgerGridClipboardPayload(
  raw: string,
): LedgerGridClipboardPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as { version?: unknown; cells?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.cells) || !candidate.cells.length) {
      return null;
    }
    const cells: LedgerGridClipboardCell[] = [];
    for (const item of candidate.cells) {
      if (!item || typeof item !== "object") return null;
      const cell = item as {
        rowOffset?: unknown;
        columnOffset?: unknown;
        value?: unknown;
      };
      if (
        !Number.isInteger(cell.rowOffset) ||
        !Number.isInteger(cell.columnOffset) ||
        (cell.rowOffset as number) < 0 ||
        (cell.columnOffset as number) < 0 ||
        typeof cell.value !== "string"
      ) {
        return null;
      }
      cells.push({
        rowOffset: cell.rowOffset as number,
        columnOffset: cell.columnOffset as number,
        value: cell.value,
      });
    }
    return { version: 1, cells };
  } catch {
    return null;
  }
}

export function expandLedgerSingleCellPaste(
  cells: LedgerGridClipboardCell[],
  rowCount: number,
  columnCount: number,
): LedgerGridClipboardCell[] {
  const source = cells[0];
  if (cells.length !== 1 || !source || rowCount <= 0 || columnCount <= 0) return cells;
  const result: LedgerGridClipboardCell[] = [];
  for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
      result.push({ rowOffset, columnOffset, value: source.value });
    }
  }
  return result;
}
