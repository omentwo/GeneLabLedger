export const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const UTC_SUFFIX = /(?:Z|[+-]\d\d:\d\d)$/;

/**
 * Parse an API timestamp as UTC.
 *
 * New API responses include an explicit UTC offset.  Older SQLite rows may
 * contain a naive ISO string; those values were written as UTC and therefore
 * receive the legacy `Z` suffix here before parsing.
 */
export function parseUtcDateTime(value: string): Date {
  const normalized = UTC_SUFFIX.test(value) ? value : `${value}Z`;
  return new Date(normalized);
}

export function formatShanghaiDateTime(value: string | null): string {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = parseUtcDateTime(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    timeZone: SHANGHAI_TIME_ZONE,
    hour12: false,
  });
}

const shanghaiDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shanghaiDateKey(value = new Date()): string {
  const parts = Object.fromEntries(
    shanghaiDateFormatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDateKey(value: string, days: number): string {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText ?? 0);
  const month = Number(monthText ?? 0);
  const day = Number(dayText ?? 0);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function shiftMonthKey(value: string, months: number): string {
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText ?? 0);
  const month = Number(monthText ?? 0);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return shifted.toISOString().slice(0, 7);
}
