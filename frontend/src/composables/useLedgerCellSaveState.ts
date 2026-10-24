import { ref, type Ref } from "vue";

/**
 * 台账单元格保存的状态机（P1-5 状态层）。
 *
 * 拥有五态标签（dirty/saving/saved/error）、乐观锁版本计数和
 * “已保存”标签的自动清除定时器。保存管线（saveField /
 * saveFieldWithPreview / pasteGrid）与剪切快照都通过这里的
 * 版本接口做并发判定，本层不发起任何请求。
 *
 * 版本语义：每次写路径推进版本；清除定时器与校验回滚都比对
 * 版本，避免清掉或回滚一个已被新保存覆盖的状态。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export type CellSaveStatus = "dirty" | "saving" | "saved" | "error";
export type CellSaveState = { status: CellSaveStatus; message?: string };

const SAVED_LABEL_CLEAR_DELAY = 1500;

export function useLedgerCellSaveState(): {
  cellSaveStates: Ref<Map<string, CellSaveState>>;
  persistedKey: (recordId: string, fieldId: string) => string;
  setCellSaveState: (recordId: string, fieldId: string, state: CellSaveState) => void;
  /** 清除单个单元格的状态标签（含其清理定时器）。 */
  clearCellSaveState: (key: string) => void;
  clearAllCellSaveStates: () => void;
  /** 原始版本读取（可能 undefined）；需要默认值的调用方自行 `?? 0`。 */
  peekCellSaveVersion: (key: string) => number | undefined;
  /** 推进版本并返回新值。 */
  nextCellSaveVersion: (key: string) => number;
  /** 以指定值恢复版本（校验回滚用）。 */
  restoreCellSaveVersion: (key: string, version: number) => void;
  dropCellSaveVersion: (key: string) => void;
  beginCellSave: (key: string) => void;
  endCellSave: (key: string) => void;
  cellSaveInFlightCount: (key: string) => number;
  hasCellSaveInFlight: () => boolean;
  dropCellSaveInFlight: (key: string) => void;
  clearCellSaveInFlight: () => void;
  /** 同一记录的保存任务严格串行，避免乱序覆盖。 */
  enqueueRecordSave: <T>(recordId: string, task: () => Promise<T>) => Promise<T>;
} {
  const cellSaveStates = ref(new Map<string, CellSaveState>());
  const cellSaveVersions = new Map<string, number>();
  const cellSaveClearTimers = new Map<string, number>();
  const cellSaveInFlightCounts = new Map<string, number>();
  const recordSaveQueues = new Map<string, Promise<unknown>>();

  function persistedKey(recordId: string, fieldId: string): string {
    return `${recordId}:${fieldId}`;
  }

  function clearCellSaveState(key: string): void {
    const pendingTimer = cellSaveClearTimers.get(key);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    cellSaveClearTimers.delete(key);
    if (!cellSaveStates.value.has(key)) return;
    const next = new Map(cellSaveStates.value);
    next.delete(key);
    cellSaveStates.value = next;
  }

  function setCellSaveState(recordId: string, fieldId: string, state: CellSaveState): void {
    const key = persistedKey(recordId, fieldId);
    const pendingTimer = cellSaveClearTimers.get(key);
    if (pendingTimer !== undefined) {
      window.clearTimeout(pendingTimer);
      cellSaveClearTimers.delete(key);
    }
    const next = new Map(cellSaveStates.value);
    next.set(key, state);
    cellSaveStates.value = next;
    if (state.status === "saved") {
      const version = cellSaveVersions.get(key);
      const timer = window.setTimeout(() => {
        cellSaveClearTimers.delete(key);
        if (cellSaveVersions.get(key) !== version) return;
        if (cellSaveStates.value.get(key)?.status === "saved") clearCellSaveState(key);
      }, SAVED_LABEL_CLEAR_DELAY);
      cellSaveClearTimers.set(key, timer);
    }
  }

  function clearAllCellSaveStates(): void {
    cellSaveClearTimers.forEach((timer) => window.clearTimeout(timer));
    cellSaveClearTimers.clear();
    cellSaveStates.value = new Map();
    cellSaveVersions.clear();
  }

  function peekCellSaveVersion(key: string): number | undefined {
    return cellSaveVersions.get(key);
  }

  function nextCellSaveVersion(key: string): number {
    const version = (cellSaveVersions.get(key) ?? 0) + 1;
    cellSaveVersions.set(key, version);
    return version;
  }

  function restoreCellSaveVersion(key: string, version: number): void {
    cellSaveVersions.set(key, version);
  }

  function dropCellSaveVersion(key: string): void {
    cellSaveVersions.delete(key);
  }

  function beginCellSave(key: string): void {
    cellSaveInFlightCounts.set(key, (cellSaveInFlightCounts.get(key) ?? 0) + 1);
  }

  function endCellSave(key: string): void {
    const remaining = (cellSaveInFlightCounts.get(key) ?? 1) - 1;
    if (remaining > 0) cellSaveInFlightCounts.set(key, remaining);
    else cellSaveInFlightCounts.delete(key);
  }

  function cellSaveInFlightCount(key: string): number {
    return cellSaveInFlightCounts.get(key) ?? 0;
  }

  function hasCellSaveInFlight(): boolean {
    return cellSaveInFlightCounts.size > 0;
  }

  function dropCellSaveInFlight(key: string): void {
    cellSaveInFlightCounts.delete(key);
  }

  function clearCellSaveInFlight(): void {
    cellSaveInFlightCounts.clear();
    recordSaveQueues.clear();
  }

  function enqueueRecordSave<T>(recordId: string, task: () => Promise<T>): Promise<T> {
    const previous = recordSaveQueues.get(recordId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    recordSaveQueues.set(recordId, current);
    const clearQueue = () => {
      if (recordSaveQueues.get(recordId) === current) recordSaveQueues.delete(recordId);
    };
    void current.then(clearQueue, clearQueue);
    return current;
  }

  return {
    cellSaveStates,
    persistedKey,
    setCellSaveState,
    clearCellSaveState,
    clearAllCellSaveStates,
    peekCellSaveVersion,
    nextCellSaveVersion,
    restoreCellSaveVersion,
    dropCellSaveVersion,
    beginCellSave,
    endCellSave,
    cellSaveInFlightCount,
    hasCellSaveInFlight,
    dropCellSaveInFlight,
    clearCellSaveInFlight,
    enqueueRecordSave,
  };
}
