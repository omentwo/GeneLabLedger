export const LAST_LEDGER_PROJECT_STORAGE_KEY = "gene-lab-ledger.last-ledger-project";

export function readLastLedgerProjectId(): string {
  try {
    return window.localStorage.getItem(LAST_LEDGER_PROJECT_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function rememberLastLedgerProjectId(projectId: string): boolean {
  const normalized = projectId.trim();
  if (!normalized) return false;
  try {
    window.localStorage.setItem(LAST_LEDGER_PROJECT_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

/** Explicit links win, then the last opened sheet, then the first available project. */
export function resolveInitialLedgerProjectId(
  queryProjectId: string,
  rememberedProjectId: string,
  availableProjectIds: readonly string[],
): string {
  if (queryProjectId && availableProjectIds.includes(queryProjectId)) return queryProjectId;
  if (rememberedProjectId && availableProjectIds.includes(rememberedProjectId)) {
    return rememberedProjectId;
  }
  return availableProjectIds[0] ?? "";
}
