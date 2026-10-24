import { computed, nextTick, ref, type ComputedRef, type Ref } from "vue";

import { ElMessage } from "element-plus";

import { queryRecords, queryRecordIds } from "@/api/records";
import { useAppStore } from "@/stores/app";
import type {
  ProjectRecord,
  RecordComplexQuery,
  RecordFieldFilter,
  RecordIdList,
  RecordList,
  RecordReplacePreview,
} from "@/types/api";
import {
  LedgerRecordCache,
  ledgerRecordQueryKey,
} from "@/utils/ledgerRecordCache";
import {
  resolveLedgerRecordRange,
  type LedgerRangeSettings,
} from "@/utils/ledgerRangeSettings";
import {
  applyLedgerTableView,
  type LedgerFilterMap,
  type LedgerRow,
  type LedgerSortState,
} from "@/utils/ledgerTableView";
import {
  makeGridCellHelpers,
  type GridCellPosition,
  type GridCellRange,
} from "@/utils/gridSelectionModel";
import type { LedgerContext } from "@/composables/useLedgerContext";

/**
 * 台账记录的数据管线：分页拉取、LRU 缓存与缓存世代、请求票据、派生行，
 * 以及加载编排器 `loadRecords`（选区快照恢复、滚动定位、历史清理）。
 *
 * `loadRecords` 依赖单元格保存、范围刷新、选区等后续 composable 的状态，
 * 而这些 composable 又依赖本模块的 `tableRows`——初始化存在真实的环。
 * 因此视图依赖以惰性工厂注入：工厂在 setup 期只创建闭包不取值，
 * 到 loadRecords 真正执行时才求值，此时所有绑定均已就绪。
 *
 * `scheduleLedgerRangeRefresh` 的调度器仍留在 useLedgerRangeRefresh。
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

/** 跨行身份（行 id × 字段 id），加载前后恢复选区用。 */
export interface LedgerGridIdentity {
  rowId: string;
  fieldId: string;
}

/**
 * loadRecords 编排器的视图依赖。Ref 表示会被读写；getter 表示只读。
 * 全部成员仅在 loadRecords / buildRecordQuery 执行时被访问。
 */
export interface LedgerRecordsLoadDeps {
  /** 加载新数据即丢弃撤销历史。 */
  ledgerHistory: { clear: () => void };
  /** 显示范围设置（buildRecordQuery 解析查询区间）。 */
  ledgerRangeSettings: Ref<LedgerRangeSettings>;
  showLockedRecords: () => boolean;
  loadBatchSize: () => number;
  /** 范围已保存但尚未应用到已加载记录（useLedgerRangeRefresh）。 */
  pendingLedgerRangeApplication: Ref<boolean>;
  cancelLedgerRangeRefresh: () => void;
  scheduleLedgerRangeRefresh: (projectId: string) => void;
  /** 单元格保存进行中状态（useLedgerCellSave / useLedgerCellSaveState）。 */
  savingIds: () => Set<string>;
  hasDirtyLedgerChanges: () => boolean;
  editingGridCell: () => GridCellPosition | null;
  clearAllCellSaveStates: () => void;
  fieldErrors: Ref<Record<string, string>>;
  /** 查找替换预览（useLedgerFindReplace）。 */
  findReplacePreview: Ref<RecordReplacePreview | null>;
  /** 网格选区（useLedgerGridSelection）。 */
  focusRecordId: Ref<string>;
  activeGridCell: Ref<GridCellPosition | null>;
  gridSelectionAnchor: () => GridCellPosition | null;
  gridCellRange: () => GridCellRange | null;
  selectedGridCellKeys: () => Set<string>;
  captureGridIdentity: (position: GridCellPosition | null) => LedgerGridIdentity | null;
  restoreGridIdentity: (identity: LedgerGridIdentity | null) => GridCellPosition | null;
  selectedGridCellPositions: () => GridCellPosition[];
  replaceGridCellSelection: (
    positions: GridCellPosition[],
    active: GridCellPosition,
    anchor?: GridCellPosition,
    range?: GridCellRange | null,
  ) => void;
  clearGridCellSelection: () => void;
  /** 记录级（行）选区。 */
  selectedRecords: Ref<ProjectRecord[]>;
  selectedRecordIds: Ref<Set<string>>;
  selectedRecordCache: Map<string, ProjectRecord>;
  clearRecordSelection: () => void;
  /** 撤销历史的全量快照基线。 */
  rememberAll: () => void;
  /** 视图滚动与布局编排。 */
  clearBottomScrollTimers: () => void;
  clearSelectionsAfterLedgerViewChange: () => void;
  refreshTableLayout: (requestIsCurrent: () => boolean) => Promise<void>;
  scrollToFocusedRecord: (requestIsCurrent: () => boolean) => Promise<boolean>;
  scrollTableToBottomOnce: (requestIsCurrent?: () => boolean) => Promise<boolean>;
}

export function useLedgerRecords(
  context: LedgerContext,
  view: LedgerRecordsView,
  loadDeps: () => LedgerRecordsLoadDeps,
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
  updateCachedRecord: (projectId: string, record: ProjectRecord) => void;
  beginRecordsRequest: () => RecordsRequestTicket;
  finishRecordsRequest: (ticket: RecordsRequestTicket) => void;
  disposeRecords: () => void;
  loadRecords: (
    projectId?: string,
    options?: {
      showLoading?: boolean;
      preserveHistory?: boolean;
      preserveSelection?: boolean;
      stabilizeTable?: boolean;
      preferCache?: boolean;
      deferForPendingEdits?: boolean;
    },
  ) => Promise<boolean>;
  buildRecordQuery: (
    projectId?: string,
    queryView?: {
      filters?: LedgerFilterMap;
      sort?: LedgerSortState;
      includeDisplayRange?: boolean;
    },
  ) => RecordComplexQuery;
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

  /** 单格保存后的缓存原地更新：不动新鲜期，不做世代失效。 */
  function updateCachedRecord(projectId: string, record: ProjectRecord): void {
    if (!projectId) return;
    ledgerRecordCache.updateRecord(projectId, record);
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

  /** 与视图选区同一套键/范围展开规则（同样的行源，键值必然一致）。 */
  const identityCells = makeGridCellHelpers(
    () => tableRows.value,
    () => context.fields.value,
  );

  function buildRecordQuery(
    projectId = context.activeProjectId.value,
    queryView: {
      filters?: LedgerFilterMap;
      sort?: LedgerSortState;
      includeDisplayRange?: boolean;
    } = {},
  ): RecordComplexQuery {
    const deps = loadDeps();
    const filters = queryView.filters ?? view.ledgerFilters.value;
    const sort = queryView.sort === undefined ? view.ledgerSort.value : queryView.sort;
    const fieldFilters: RecordFieldFilter[] = [];
    Object.entries(filters).forEach(([fieldId, filter]) => {
      if (!filter) return;
      if (filter.kind === "text") {
        fieldFilters.push({ field_id: fieldId, operator: "contains", value: filter.value });
        return;
      }
      if (filter.kind === "options") {
        if (filter.values.length === 1 && filter.values[0] === "") {
          fieldFilters.push({ field_id: fieldId, operator: "is_empty" });
          return;
        }
        fieldFilters.push({ field_id: fieldId, operator: "in", values: filter.values });
        return;
      }
      fieldFilters.push({
        field_id: fieldId,
        operator: "date_between",
        start: filter.start || null,
        end: filter.end || null,
      });
    });
    return {
      project_id: projectId,
      ...(queryView.includeDisplayRange === false
        ? {}
        : resolveLedgerRecordRange(deps.ledgerRangeSettings.value)),
      include_locked: deps.showLockedRecords(),
      field_filters: fieldFilters,
      sort: sort
        ? {
            field_id: sort.fieldId,
            direction: sort.order === "descending" ? "desc" : "asc",
          }
        : null,
      limit: deps.loadBatchSize(),
      offset: 0,
    };
  }

  async function loadRecords(
    projectId: string | undefined = context.activeProjectId.value,
    options: {
      showLoading?: boolean;
      preserveHistory?: boolean;
      preserveSelection?: boolean;
      stabilizeTable?: boolean;
      preferCache?: boolean;
      deferForPendingEdits?: boolean;
    } = {},
  ): Promise<boolean> {
    const deps = loadDeps();
    if (!options.preserveHistory) deps.ledgerHistory.clear();
    if (!projectId) {
      context.records.value = [];
      recordTotal.value = 0;
      loadedRecordCount.value = 0;
      return true;
    }
    const showLoading = options.showLoading ?? true;
    let retryRangeRefresh = false;
    const request = beginRecordsRequest();
    const currentQuery = buildRecordQuery(projectId);
    deps.cancelLedgerRangeRefresh();
    const currentQueryKey = ledgerRecordQueryKey(currentQuery);
    const queryCacheGeneration = projectRecordCacheGeneration(projectId);
    const cacheHit = options.preferCache
      && ledgerRecordCache.isFresh(currentQueryKey)
      ? ledgerRecordCache.get(currentQueryKey)
      : null;
    loadedRecordCount.value = cacheHit?.snapshot.records.length ?? 0;
    if (showLoading && !cacheHit) loading.value = true;
    try {
      let loaded: ProjectRecord[] = [];
      let total = 0;
      if (cacheHit) {
        total = cacheHit.snapshot.total;
        loaded = cacheHit.snapshot.records;
      } else {
        const page = await queryAllRecordBatches(
          currentQuery,
          request.controller.signal,
          (loadedCount, nextTotal) => {
            if (!request.isCurrent() || projectId !== context.activeProjectId.value) return;
            loadedRecordCount.value = loadedCount;
            recordTotal.value = nextTotal;
          },
        );
        if (projectRecordCacheGeneration(projectId) !== queryCacheGeneration) {
          retryRangeRefresh = Boolean(options.deferForPendingEdits);
          return false;
        }
        total = page.total;
        loaded = page.items;
        if (loaded.length <= LEDGER_RECORD_CACHE_MAX_RECORDS) {
          ledgerRecordCache.set(currentQueryKey, projectId, { records: loaded, total });
        } else {
          ledgerRecordCache.invalidateProject(projectId);
        }
      }
      if (!request.isCurrent() || projectId !== context.activeProjectId.value) return false;
      if (
        deps.pendingLedgerRangeApplication.value
        && currentQueryKey !== ledgerRecordQueryKey(buildRecordQuery(projectId))
      ) {
        retryRangeRefresh = true;
        return false;
      }
      if (
        options.deferForPendingEdits
        && (deps.editingGridCell() || deps.savingIds().size || deps.hasDirtyLedgerChanges())
      ) {
        retryRangeRefresh = true;
        return false;
      }
      const stabilizeTable = options.stabilizeTable || deps.pendingLedgerRangeApplication.value;
      if (deps.pendingLedgerRangeApplication.value) {
        deps.clearBottomScrollTimers();
        deps.clearSelectionsAfterLedgerViewChange();
        deps.focusRecordId.value = "";
        deps.findReplacePreview.value = null;
      }
      const preserveGridSelection =
        options.preserveSelection && context.tableProjectId.value === projectId;
      const activeIdentity = preserveGridSelection
        ? deps.captureGridIdentity(deps.activeGridCell.value)
        : null;
      const anchorIdentity = preserveGridSelection
        ? deps.captureGridIdentity(deps.gridSelectionAnchor())
        : null;
      const selectionRange = deps.gridCellRange();
      const rangeIdentities = preserveGridSelection && selectionRange
        ? {
            anchor: deps.captureGridIdentity(selectionRange.anchor),
            focus: deps.captureGridIdentity(selectionRange.focus),
          }
        : null;
      context.records.value = loaded;
      deps.pendingLedgerRangeApplication.value = false;
      if (deps.ledgerRangeSettings.value.mode !== "all" && options.preserveSelection) {
        const visibleIds = new Set(loaded.map((record) => record.id));
        deps.selectedRecordIds.value = new Set(
          [...deps.selectedRecordIds.value].filter((id) => visibleIds.has(id)),
        );
        for (const id of deps.selectedRecordCache.keys()) {
          if (!visibleIds.has(id)) deps.selectedRecordCache.delete(id);
        }
      }
      recordTotal.value = total;
      loadedRecordCount.value = loaded.length;
      context.tableProjectId.value = projectId;
      if (preserveGridSelection) {
        const positions = deps.selectedGridCellPositions();
        const active = deps.restoreGridIdentity(activeIdentity) ?? positions[0] ?? null;
        const anchor = deps.restoreGridIdentity(anchorIdentity) ?? active;
        const rangeAnchor = deps.restoreGridIdentity(rangeIdentities?.anchor ?? null);
        const rangeFocus = deps.restoreGridIdentity(rangeIdentities?.focus ?? null);
        let restoredRange: GridCellRange | null = null;
        if (rangeAnchor && rangeFocus) {
          const candidate = { anchor: rangeAnchor, focus: rangeFocus };
          const rectangle = identityCells.positionsForRange(candidate);
          if (
            rectangle.length === positions.length
            && rectangle.every((position) => deps.selectedGridCellKeys().has(identityCells.key(position)))
          ) restoredRange = candidate;
        }
        if (active) deps.replaceGridCellSelection(positions, active, anchor ?? active, restoredRange);
        else {
          deps.activeGridCell.value = null;
          deps.clearGridCellSelection();
        }
      } else {
        deps.activeGridCell.value = null;
        deps.clearGridCellSelection();
      }
      deps.fieldErrors.value = {};
      deps.clearAllCellSaveStates();
      deps.selectedRecords.value = [];
      if (!options.preserveSelection) deps.clearRecordSelection();
      deps.rememberAll();
      const requestIsCurrent = () => (
        request.isCurrent()
        && projectId === context.activeProjectId.value
      );
      if (stabilizeTable) await deps.refreshTableLayout(requestIsCurrent);
      else await nextTick();
      if (!requestIsCurrent()) return false;
      if (options.preserveSelection && deps.selectedRecordIds.value.size) {
        context.records.value.forEach((record) => {
          if (deps.selectedRecordIds.value.has(record.id)) {
            deps.selectedRecordCache.set(record.id, record);
          }
        });
        deps.selectedRecords.value = context.records.value.filter((record) =>
          deps.selectedRecordIds.value.has(record.id),
        );
      }
      const scrolledToFocus = await deps.scrollToFocusedRecord(requestIsCurrent);
      if (stabilizeTable && !scrolledToFocus) {
        await deps.scrollTableToBottomOnce(requestIsCurrent);
      }
      return true;
    } catch (error) {
      if (!request.isCurrent()) return false;
      ElMessage.error(error instanceof Error ? error.message : "台账读取失败");
      return false;
    } finally {
      finishRecordsRequest(request);
      if (retryRangeRefresh) deps.scheduleLedgerRangeRefresh(projectId);
    }
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
    updateCachedRecord,
    beginRecordsRequest,
    finishRecordsRequest,
    disposeRecords,
    loadRecords,
    buildRecordQuery,
  };
}
