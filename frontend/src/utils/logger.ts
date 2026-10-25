/**
 * 单一日志出口。
 *
 * 桌面端用户看不到 DevTools，直接散落 `console.error` 既无法统一格式，
 * 也无法在将来转发到主进程日志文件。这里集中处理两件事：
 * 1. 统一前缀，便于在控制台按模块过滤；
 * 2. 把 `unknown` 异常规范成可读文本，避免 `[object Object]`。
 *
 * 注意：本模块只做记录，不改变任何业务流程，也不吞掉异常。
 */

export type LogScope =
  | "window"
  | "ledger"
  | "quick-entry"
  | "ledger-tools"
  | "reports"
  | "settings"
  | "clipboard";

function describeError(error: unknown): string {
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
  if (detail) console.error(`[${scope}] ${message}：${detail}`);
  else console.error(`[${scope}] ${message}`);
}
