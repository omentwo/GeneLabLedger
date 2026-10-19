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

/**
 * Normalize a hand-typed business date to `YYYY-MM-DD`.
 *
 * Accepts `2026-7-27`, `2026/07/27` and `2026.07.27`, and rejects values that
 * do not exist in the calendar (`2026-02-30`).  The ledger grid, the quick
 * entry window and the fill helper all share this single implementation so a
 * date typed in one place cannot be accepted by another and rejected here.
 */
export function normalizeDateInput(value: string): string {
  const cleaned = value.trim().replace(/[/.]/g, "-");
  if (!cleaned) return "";
  const match = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error("日期格式应为 YYYY-MM-DD，例如 2026-07-27");
  const [, year, month, day] = match;
  const normalized = `${year}-${String(Number(month)).padStart(2, "0")}-${String(
    Number(day),
  ).padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(year) ||
    date.getMonth() + 1 !== Number(month) ||
    date.getDate() !== Number(day)
  ) {
    throw new Error("日期无效，请重新输入");
  }
  return normalized;
}
