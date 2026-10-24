import { computed, ref, type ComputedRef, type Ref } from "vue";

import { queryRecords, queryRecordIds } from "@/api/records";
import { useAppStore } from "@/stores/app";
import type { ProjectRecord, RecordComplexQuery, RecordIdList, RecordList } from "@/types/api";
import {
  LedgerRecordCache,
} from "@/utils/ledgerRecordCache";
import {
  applyLedgerTableView,
  type LedgerFilterMap,
  type LedgerRow,
  type LedgerSortState,
} from "@/utils/ledgerTableView";
import type { LedgerContext } from "@/composables/useLedgerContext";

/**
 * 台账记录的数据管线：分页拉取、LRU 缓存与缓存世代、请求票据、派生行。
 *
 * 刻意留在外面的两块：
 * - `loadRecords` 编排器（选区快照恢复、滚动定位、历史清理）——它是视图逻辑，
 *   等选区（P1-3）与单元格保存（P1-5）成为 composable 后再迁移；
 * - `scheduleLedgerRangeRefresh`——依赖 cell-save 进行中状态与编排器本身。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，调用方在
 * `<script setup>` 顶层解构，组件测试经 `_instance.setupState` 读取。
 */
export interface LedgerRecordsView {
  /** 尚未落库的插入草稿行，拼在已加载记录之后。 */
  draftRows: Ref<LedgerRow[]>;
  ledgerSort: Ref<LedgerSortState>;
  ledgerFilters: Ref<LedgerFilterMap>;
}

/** 一次记录加载的票据：持有序号与 AbortController，用于乱序防线。 */
export interface RecordsRequestTicket {
  sequence: number;
  controller: AbortController;
  /**
   * 序号仍是最新且未被中止。中止只会由更新的请求触发，而新请求必然
   * 递增序号，因此「已中止」蕴含「序号过期」；两个条件合并不改变语义。
   */
  isCurrent: () => boolean;
}

export const LEDGER_RECORD_CACHE_MAX_RECORDS = 10_000;

export function useLedgerRecords(
  context: LedgerContext,
  view: LedgerRecordsView,
): {
  loading: Ref<boolean>;
  recordTotal: Ref<number>;
  loadedRecordCount: Ref<number>;
  baseTableRows: ComputedRef<LedgerRow[]>;
  tableRows: ComputedRef<LedgerRow[]>;
  tableRowIndexById: ComputedRef<Map<string, number>>;
  queryAllRecordBatches: (
    query: RecordComplexQuery,
    signal?: AbortSignal,
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<RecordList>;
  queryLedgerRecordIds: (query: RecordComplexQuery) => Promise<RecordIdList>;
  ledgerRecordCache: LedgerRecordCache;
  LEDGER_RECORD_CACHE_MAX_RECORDS: number;
  projectRecordCacheGeneration: (projectId: string) => number;
  invalidateProjectRecordCache: (projectId: string) => void;
  beginRecordsRequest: () => RecordsRequestTicket;
  finishRecordsRequest: (ticket: RecordsRequestTicket) => void;
  disposeRecords: () => void;
} {
  const appStore = useAppStore();
  const loading = ref(false);
  const recordTotal = ref(0);
  const loadedRecordCount = ref(0);
  let loadSequence = 0;
  let recordsAbortController: AbortController | null = null;
  const ledgerRecordCache = new LedgerRecordCache({ maxEntries: 2 });
  const projectRecordCacheGenerations = new Map<string, number>();

  const baseTableRows = computed<LedgerRow[]>(() => [
    ...context.records.value,
    ...view.draftRows.value,
  ]);
  const tableRows = computed<LedgerRow[]>(() =>
    applyLedgerTableView(
      baseTableRows.value,
      context.fields.value,
      view.ledgerSort.value,
      view.ledgerFilters.value,
    ),
  );
  const tableRowIndexById = computed(
    () => new Map(tableRows.value.map((row, index) => [row.id, index] as const)),
  );

  async function queryAllRecordBatches(
    query: RecordComplexQuery,
    signal?: AbortSignal,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<RecordList> {
    const items: ProjectRecord[] = [];
    let total = 0;
    let offset = 0;
    // The spreadsheet's locale-aware/natural sort is authoritative. SQL ordering
    // can differ for pathology numbers, text and empty cells, so sorted tails
    // must be selected after applying that same comparator to the candidates.
    const sortedTail = Boolean(query.tail_count && query.sort);
    const transportQuery = sortedTail ? { ...query, tail_count: undefined } : query;
    while (true) {
      const batch = await queryRecords({ ...transportQuery, offset }, signal);
      total = batch.total;
      items.push(...batch.items);
      offset += batch.items.length;
      onProgress?.(items.length, total);
      if (!batch.items.length || offset >= total) break;
    }
    if (sortedTail) {
      const projectFields = appStore.projectById(query.project_id)?.fields ?? [];
      const sort = query.sort
        ? { fieldId: query.sort.field_id, order: query.sort.direction === "desc" ? "descending" : "ascending" } as const
        : null;
      const selected = applyLedgerTableView(items, projectFields, sort, {}, query);
      onProgress?.(selected.length, selected.length);
      return { items: selected, total: selected.length, limit: query.limit, offset: 0 };
    }
    return { items, total, limit: query.limit, offset: 0 };
  }

  async function queryLedgerRecordIds(query: RecordComplexQuery): Promise<RecordIdList> {
    if (query.tail_count && query.sort) {
      const result = await queryAllRecordBatches(query);
      return { record_ids: result.items.map((record) => record.id), total: result.total };
    }
    return queryRecordIds(query);
  }

  function projectRecordCacheGeneration(projectId: string): number {
    return projectRecordCacheGenerations.get(projectId) ?? 0;
  }

  function invalidateProjectRecordCache(projectId: string): void {
    if (!projectId) return;
    ledgerRecordCache.invalidateProject(projectId);
    projectRecordCacheGenerations.set(
      projectId,
      projectRecordCacheGeneration(projectId) + 1,
    );
  }

  function beginRecordsRequest(): RecordsRequestTicket {
    const sequence = ++loadSequence;
    recordsAbortController?.abort();
    const controller = new AbortController();
    recordsAbortController = controller;
    return {
      sequence,
      controller,
      isCurrent: () => sequence === loadSequence && !controller.signal.aborted,
    };
  }

  function finishRecordsRequest(ticket: RecordsRequestTicket): void {
    if (ticket.sequence === loadSequence) {
      loading.value = false;
      if (recordsAbortController === ticket.controller) recordsAbortController = null;
    }
  }

  /** 视图卸载时调用：中止在途请求并清空缓存与世代表。 */
  function disposeRecords(): void {
    recordsAbortController?.abort();
    recordsAbortController = null;
    ledgerRecordCache.clear();
    projectRecordCacheGenerations.clear();
  }

  return {
    loading,
    recordTotal,
    loadedRecordCount,
    baseTableRows,
    tableRows,
    tableRowIndexById,
    queryAllRecordBatches,
    queryLedgerRecordIds,
    ledgerRecordCache,
    LEDGER_RECORD_CACHE_MAX_RECORDS,
    projectRecordCacheGeneration,
    invalidateProjectRecordCache,
    beginRecordsRequest,
    finishRecordsRequest,
    disposeRecords,
  };
}
