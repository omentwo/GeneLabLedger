export function ledgerPageForRecord(
  orderedRecordIds: readonly string[],
  recordId: string,
  pageSize: number,
): number | null {
  if (!Number.isInteger(pageSize) || pageSize <= 0) return null;
  const recordIndex = orderedRecordIds.indexOf(recordId);
  return recordIndex < 0 ? null : Math.floor(recordIndex / pageSize) + 1;
}

export function clampLedgerPage(page: number, total: number, pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize <= 0) return 1;
  const lastPage = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  return Math.min(Math.max(1, Math.trunc(page)), lastPage);
}
