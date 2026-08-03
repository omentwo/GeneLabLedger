import { apiRequest } from "@/api/client";
import type { AuditLogPage, HealthStatus } from "@/types/api";

export const LEDGER_DISPLAY_SETTINGS_KEY = "ledger_display_settings";
export const LEDGER_SHORTCUT_SETTINGS_KEY = "ledger_shortcut_settings";
export const LEDGER_ROW_PADDING_MIN = 0;
export const LEDGER_ROW_PADDING_MAX = 12;
export const LEDGER_EDITOR_WIDTH_MIN = 50;
export const LEDGER_EDITOR_HEIGHT_MIN = 75;
export const LEDGER_EDITOR_SIZE_MAX = 100;
export const LEDGER_EDITOR_SIZE_STEP = 5;
export const LEDGER_FONT_SIZE_MIN = 8;
export const LEDGER_FONT_SIZE_MAX = 28;
export const LEDGER_FONT_SIZE_STEP = 1;
export const LEDGER_ZOOM_MIN = 50;
export const LEDGER_ZOOM_MAX = 200;
export const LEDGER_ZOOM_STEP = 5;

export const LEDGER_FONT_FAMILY_VALUES = [
  "system",
  "microsoft-yahei",
  "simsun",
  "consolas",
] as const;

export type LedgerFontFamily = (typeof LEDGER_FONT_FAMILY_VALUES)[number];

export const LEDGER_FONT_FAMILY_OPTIONS: Array<{
  value: LedgerFontFamily;
  label: string;
  css: string;
}> = [
  {
    value: "system",
    label: "系统默认",
    css: 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
  {
    value: "microsoft-yahei",
    label: "微软雅黑",
    css: '"Microsoft YaHei", "PingFang SC", sans-serif',
  },
  {
    value: "simsun",
    label: "宋体",
    css: 'SimSun, "Songti SC", serif',
  },
  {
    value: "consolas",
    label: "Consolas 等宽",
    css: 'Consolas, "SFMono-Regular", monospace',
  },
];

export type LedgerDisplaySettings = {
  rowPaddingY: number;
  editorWidthPercent: number;
  editorHeightPercent: number;
  fontFamily: LedgerFontFamily;
  fontSizePx: number;
  zoomPercent: number;
};

export const LEDGER_SHORTCUT_MODIFIER_VALUES = [
  "Alt",
  "Shift",
  "Control",
  "Meta",
  "CapsLock",
] as const;

export type LedgerShortcutModifier = (typeof LEDGER_SHORTCUT_MODIFIER_VALUES)[number];

export type LedgerShortcutSettings = {
  navigation: LedgerShortcutModifier[];
  extendSelection: LedgerShortcutModifier[];
};

export const DEFAULT_LEDGER_DISPLAY_SETTINGS = {
  rowPaddingY: 5,
  editorWidthPercent: LEDGER_EDITOR_SIZE_MAX,
  editorHeightPercent: LEDGER_EDITOR_SIZE_MAX,
  fontFamily: "system",
  fontSizePx: 14,
  zoomPercent: 100,
} as const;

export const DEFAULT_LEDGER_SHORTCUT_SETTINGS = {
  navigation: ["Alt"],
  extendSelection: ["Control", "Shift"],
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
  const fontFamily = LEDGER_FONT_FAMILY_VALUES.includes(
    candidate.fontFamily as LedgerFontFamily,
  )
    ? (candidate.fontFamily as LedgerFontFamily)
    : DEFAULT_LEDGER_DISPLAY_SETTINGS.fontFamily;
  const rawFontSize = candidate.fontSizePx;
  const fontSizePx =
    typeof rawFontSize === "number" && Number.isFinite(rawFontSize)
      ? Math.min(LEDGER_FONT_SIZE_MAX, Math.max(LEDGER_FONT_SIZE_MIN, Math.round(rawFontSize)))
      : DEFAULT_LEDGER_DISPLAY_SETTINGS.fontSizePx;
  const rawZoom = candidate.zoomPercent;
  const zoomPercent =
    typeof rawZoom === "number" && Number.isFinite(rawZoom)
      ? Math.min(LEDGER_ZOOM_MAX, Math.max(LEDGER_ZOOM_MIN, Math.round(rawZoom / LEDGER_ZOOM_STEP) * LEDGER_ZOOM_STEP))
      : DEFAULT_LEDGER_DISPLAY_SETTINGS.zoomPercent;

  return {
    rowPaddingY,
    editorWidthPercent,
    editorHeightPercent,
    fontFamily,
    fontSizePx,
    zoomPercent,
  };
}

export function normalizeLedgerShortcutSettings(value: unknown): LedgerShortcutSettings {
  const candidate =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const allowed = new Set<string>(LEDGER_SHORTCUT_MODIFIER_VALUES);

  function normalizeModifiers(
    raw: unknown,
    fallback: readonly LedgerShortcutModifier[],
  ): LedgerShortcutModifier[] {
    const values = Array.isArray(raw)
      ? raw.filter(
          (modifier): modifier is string =>
            typeof modifier === "string" && allowed.has(modifier),
        )
      : [];
    const selected = new Set(values);
    const normalized = LEDGER_SHORTCUT_MODIFIER_VALUES.filter((modifier) =>
      selected.has(modifier),
    );
    return normalized.length ? normalized : [...fallback];
  }

  return {
    navigation: normalizeModifiers(
      candidate.navigation,
      DEFAULT_LEDGER_SHORTCUT_SETTINGS.navigation,
    ),
    extendSelection: normalizeModifiers(
      candidate.extendSelection,
      DEFAULT_LEDGER_SHORTCUT_SETTINGS.extendSelection,
    ),
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
