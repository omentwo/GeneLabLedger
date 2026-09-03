export const DEFAULT_REPORT_PRINT_ORDER = "descending" as const;

export type ReportPrintOrder = "ascending" | "descending";

interface ReportPrintRecord {
  id: string;
}

export function reportRecordIdsInPrintOrder(
  ledgerRecords: readonly ReportPrintRecord[],
  selectedRecords: readonly ReportPrintRecord[],
  order: ReportPrintOrder = DEFAULT_REPORT_PRINT_ORDER,
): string[] {
  const selectedIds = new Set(selectedRecords.map((record) => record.id));
  const orderedIds = ledgerRecords
    .filter((record) => selectedIds.has(record.id))
    .map((record) => record.id);
  return order === "descending" ? orderedIds.reverse() : orderedIds;
}
