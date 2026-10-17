import type { ProjectRecord, RecordComplexQuery } from "@/types/api";
import { shanghaiDateKey } from "@/utils/datetime";

export const LEDGER_RANGE_SETTINGS_KEY = "ledger_range_settings";
export const LEDGER_RANGE_MONTHS_MAX = 120;
export const LEDGER_RANGE_COUNT_MAX = 10_000;

export interface LedgerRangeSettings {
  version: 1;
  mode: "all" | "months" | "count";
  months: number;
  count: number;
  includeUndated: boolean;
  /** Keep records dated after today; without it a future date hides the row. */
  includeFuture: boolean;
}

export type LedgerRecordRange = Pick<RecordComplexQuery,
  "experiment_date_from" | "experiment_date_to" | "include_undated" | "tail_count"
>;

export const DEFAULT_LEDGER_RANGE_SETTINGS: LedgerRangeSettings = {
  version: 1, mode: "all", months: 3, count: 50, includeUndated: true, includeFuture: true,
};

export function normalizeLedgerRangeSettings(value: unknown): LedgerRangeSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const positiveInteger = (candidate: unknown, fallback: number, maximum: number) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(1, Math.min(maximum, Math.round(candidate))) : fallback;
  return {
    version: 1,
    mode: source.mode === "months" || source.mode === "count" ? source.mode : "all",
    months: positiveInteger(source.months, 3, LEDGER_RANGE_MONTHS_MAX),
    count: positiveInteger(source.count, 50, LEDGER_RANGE_COUNT_MAX),
    includeUndated: typeof source.includeUndated === "boolean" ? source.includeUndated : true,
    includeFuture: typeof source.includeFuture === "boolean" ? source.includeFuture : true,
  };
}

/** Shift calendar months and clamp the day to the target month's last day. */
export function ledgerMonthStart(today: string, months: number): string {
  const [year = 0, month = 1, day = 1] = today.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function resolveLedgerRecordRange(
  settings: LedgerRangeSettings, today = shanghaiDateKey(),
): LedgerRecordRange {
  if (settings.mode === "count") return { tail_count: settings.count };
  if (settings.mode === "months") {
    const range: LedgerRecordRange = {
      experiment_date_from: ledgerMonthStart(today, settings.months),
      include_undated: settings.includeUndated,
    };
    // An omitted upper bound keeps future-dated rows; the ledger date is a
    // business date, so a planned experiment must not vanish from the view.
    if (!settings.includeFuture) range.experiment_date_to = today;
    return range;
  }
  return {};
}

export function matchesLedgerRecordRange(record: ProjectRecord, range: LedgerRecordRange): boolean {
  if (!range.experiment_date_from && !range.experiment_date_to) return true;
  if (!record.experiment_date) return Boolean(range.include_undated);
  return (!range.experiment_date_from || record.experiment_date >= range.experiment_date_from)
    && (!range.experiment_date_to || record.experiment_date <= range.experiment_date_to);
}

export function ledgerRangeLabel(settings: LedgerRangeSettings): string {
  if (settings.mode === "months") {
    return settings.includeFuture
      ? `近 ${settings.months} 个月及以后`
      : `近 ${settings.months} 个月`;
  }
  if (settings.mode === "count") return `末尾 ${settings.count} 条`;
  return "全部显示";
}
