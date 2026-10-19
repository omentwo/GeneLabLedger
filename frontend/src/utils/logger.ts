/**
 * 单一日志出口。
 *
 * 桌面端用户看不到 DevTools，直接散落 `console.error` 既无法统一格式，
 * 也无法在将来转发到主进程日志文件。这里集中处理三件事：
 * 1. 统一前缀，便于在控制台按模块过滤；
 * 2. 把 `unknown` 异常规范成可读文本，避免 `[object Object]`；
 * 3. 保留一个进程内最近错误环形缓冲，供设置页或问题反馈读取。
 *
 * 注意：本模块只做记录，不改变任何业务流程，也不吞掉异常。
 */

export type LogScope =
  | "window"
  | "ledger"
  | "quick-entry"
  | "reports"
  | "settings"
  | "clipboard";

export interface LogRecord {
  scope: LogScope;
  message: string;
  detail: unknown;
  at: number;
}

const MAX_RECENT_ERRORS = 50;
const recentErrors: LogRecord[] = [];

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "";
  try {
    const serialized = JSON.stringify(error);
    return serialized === "{}" ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

export function logError(scope: LogScope, message: string, error?: unknown): void {
  const detail = error === undefined ? "" : describeError(error);
  const record: LogRecord = {
    scope,
    message,
    detail: error ?? null,
    at: Date.now(),
  };
  recentErrors.push(record);
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
  if (detail) console.error(`[${scope}] ${message}：${detail}`);
  else console.error(`[${scope}] ${message}`);
}

/** 只读快照，供诊断界面展示最近错误。 */
export function recentErrorRecords(): readonly LogRecord[] {
  return [...recentErrors];
}
