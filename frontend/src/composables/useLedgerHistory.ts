import { computed, ref } from "vue";

import type { ProjectRecord, RecordOperationDirection } from "@/types/api";

export const LEDGER_HISTORY_LIMIT = 20;

export interface LedgerHistoryEntry {
  operationId: string;
  projectId: string;
  label: string;
  before: ProjectRecord[];
  after: ProjectRecord[];
}

export function cloneLedgerRecord(record: ProjectRecord): ProjectRecord {
  return {
    ...record,
    values: { ...record.values },
    cell_highlight_colors: { ...record.cell_highlight_colors },
  };
}

function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ledger-operation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createLedgerHistoryEntry(
  projectId: string,
  label: string,
  before: ProjectRecord[],
  after: ProjectRecord[],
): LedgerHistoryEntry {
  return {
    operationId: newOperationId(),
    projectId,
    label,
    before: before.map(cloneLedgerRecord),
    after: after.map(cloneLedgerRecord),
  };
}

export function useLedgerHistory(limit = LEDGER_HISTORY_LIMIT) {
  const entries = ref<LedgerHistoryEntry[]>([]);
  const cursor = ref(0);
  const busy = ref(false);
  const canUndo = computed(() => cursor.value > 0 && !busy.value);
  const canRedo = computed(() => cursor.value < entries.value.length && !busy.value);

  function clear(): void {
    entries.value = [];
    cursor.value = 0;
  }

  function push(entry: LedgerHistoryEntry): void {
    const next = entries.value.slice(0, cursor.value);
    next.push(entry);
    if (next.length > limit) next.splice(0, next.length - limit);
    entries.value = next;
    cursor.value = next.length;
  }

  async function run(
    direction: RecordOperationDirection,
    replay: (entry: LedgerHistoryEntry, direction: RecordOperationDirection) => Promise<void>,
  ): Promise<boolean> {
    if (busy.value) return false;
    const index = direction === "undo" ? cursor.value - 1 : cursor.value;
    const entry = entries.value[index];
    if (!entry) return false;
    const expectedCursor = cursor.value;
    busy.value = true;
    try {
      await replay(entry, direction);
      // A refresh/project reload may clear the history while the request is
      // in flight.  In that case the server operation has completed, but the
      // old cursor must not be applied to the new/empty history.
      if (cursor.value !== expectedCursor || entries.value[index] !== entry) return true;
      cursor.value += direction === "undo" ? -1 : 1;
      return true;
    } finally {
      busy.value = false;
    }
  }

  function undo(replay: (entry: LedgerHistoryEntry) => Promise<void>): Promise<boolean> {
    return run("undo", replay);
  }

  function redo(replay: (entry: LedgerHistoryEntry) => Promise<void>): Promise<boolean> {
    return run("redo", replay);
  }

  return {
    entries,
    cursor,
    busy,
    canUndo,
    canRedo,
    clear,
    push,
    undo,
    redo,
  };
}
