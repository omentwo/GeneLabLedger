import { apiRequest } from "@/api/client";
import type { AuditLogPage, HealthStatus } from "@/types/api";

export const LEDGER_DISPLAY_SETTINGS_KEY = "ledger_display_settings";
export const LEDGER_ROW_PADDING_MIN = 0;
export const LEDGER_ROW_PADDING_MAX = 12;
export const LEDGER_EDITOR_WIDTH_MIN = 50;
export const LEDGER_EDITOR_HEIGHT_MIN = 75;
export const LEDGER_EDITOR_SIZE_MAX = 100;
export const LEDGER_EDITOR_SIZE_STEP = 5;

export type LedgerDisplaySettings = {
  rowPaddingY: number;
  editorWidthPercent: number;
  editorHeightPercent: number;
};

export const DEFAULT_LEDGER_DISPLAY_SETTINGS = {
  rowPaddingY: 5,
  editorWidthPercent: LEDGER_EDITOR_SIZE_MAX,
  editorHeightPercent: LEDGER_EDITOR_SIZE_MAX,
} as const;

export function normalizeLedgerDisplaySettings(value: unknown): LedgerDisplaySettings {
  const candidate =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawPadding = candidate.rowPaddingY;
  const rowPaddingY =
    typeof rawPadding === "number" && Number.isFinite(rawPadding)
      ? Math.min(LEDGER_ROW_PADDING_MAX, Math.max(LEDGER_ROW_PADDING_MIN, Math.round(rawPadding)))
      : DEFAULT_LEDGER_DISPLAY_SETTINGS.rowPaddingY;
  const legacyFillEditors = candidate.fillEditors;
  const legacyWidthPercent =
    typeof legacyFillEditors === "boolean" ? (legacyFillEditors ? 100 : 92) : undefined;
  const rawWidthPercent = candidate.editorWidthPercent ?? legacyWidthPercent;
  const rawHeightPercent = candidate.editorHeightPercent;
  const editorWidthPercent =
    typeof rawWidthPercent === "number" && Number.isFinite(rawWidthPercent)
      ? Math.min(LEDGER_EDITOR_SIZE_MAX, Math.max(LEDGER_EDITOR_WIDTH_MIN, Math.round(rawWidthPercent)))
      : DEFAULT_LEDGER_DISPLAY_SETTINGS.editorWidthPercent;
  const editorHeightPercent =
    typeof rawHeightPercent === "number" && Number.isFinite(rawHeightPercent)
      ? Math.min(LEDGER_EDITOR_SIZE_MAX, Math.max(LEDGER_EDITOR_HEIGHT_MIN, Math.round(rawHeightPercent)))
      : DEFAULT_LEDGER_DISPLAY_SETTINGS.editorHeightPercent;

  return {
    rowPaddingY,
    editorWidthPercent,
    editorHeightPercent,
  };
}

export function getHealth(): Promise<HealthStatus> {
  return apiRequest<HealthStatus>("/health");
}

export function listAuditLogs(search = "", limit = 50, offset = 0): Promise<AuditLogPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (search.trim()) params.set("search", search.trim());
  return apiRequest<AuditLogPage>(`/audit-logs?${params.toString()}`);
}

export function getSetting<T>(key: string): Promise<{ key: string; value: T | null }> {
  return apiRequest<{ key: string; value: T | null }>(`/settings/${key}`);
}

export function putSetting<T>(
  key: string,
  value: T,
): Promise<{ key: string; value: T }> {
  return apiRequest<{ key: string; value: T }>(`/settings/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}
