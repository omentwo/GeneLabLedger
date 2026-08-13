import type { DataType } from "@/types/api";

export interface LedgerSelectionStatCell {
  value: string;
  dataType: DataType;
}

export interface LedgerSelectionSummary {
  selected: number;
  nonEmpty: number;
  numericCount: number;
  sum: number;
  average: number | null;
  min: number | null;
  max: number | null;
}

export function summarizeLedgerSelection(
  cells: LedgerSelectionStatCell[],
): LedgerSelectionSummary {
  let nonEmpty = 0;
  const numbers: number[] = [];
  cells.forEach((cell) => {
    const value = cell.value.trim();
    if (value) nonEmpty += 1;
    if (cell.dataType !== "number" || !value) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) numbers.push(numeric);
  });
  const sum = numbers.reduce((total, value) => total + value, 0);
  return {
    selected: cells.length,
    nonEmpty,
    numericCount: numbers.length,
    sum,
    average: numbers.length ? sum / numbers.length : null,
    min: numbers.length ? Math.min(...numbers) : null,
    max: numbers.length ? Math.max(...numbers) : null,
  };
}
