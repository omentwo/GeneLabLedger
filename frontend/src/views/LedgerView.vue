<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Lock,
  Minus,
  Plus,
  Settings2 as Setting,
} from "@lucide/vue";
import {
  ElMessage,
  ElMessageBox,
  TableV2FixedDir,
  type Column,
} from "element-plus";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
  type CSSProperties,
} from "vue";
import { useRoute, useRouter } from "vue-router";

import { ApiError } from "@/api/client";
import {
  createLedgerNativePreview,
  DEFAULT_LEDGER_PREVIEW_SCOPE,
  type LedgerPreviewScope,
} from "@/api/preview";
import {
  fetchPreviewCapabilities,
  isNativeEngineAvailable,
  monitorNativePreviewJob,
  nativeEngineLabelFor,
} from "@/utils/nativePreviewJob";
import {
  DEFAULT_LEDGER_DISPLAY_SETTINGS,
  LEDGER_FONT_FAMILY_OPTIONS,
  LEDGER_DISPLAY_SETTINGS_KEY,
  LEDGER_ZOOM_MAX,
  LEDGER_ZOOM_MIN,
  LEDGER_ZOOM_STEP,
  getSetting,
  normalizeLedgerDisplaySettings,
  putSetting,
  type LedgerDisplaySettings,
} from "@/api/system";
import {
  applyRecordOperation,
  deleteRecord,
  getRecordsByIds,
  commitCellBatch,
  previewCellBatch,
  FIND_REPLACE_RECORD_LIMIT,
  previewReorderByDate,
  applyReorderByDate,
  queryRecords,
  setRecordLock,
  setCellsHighlight,
  setRecordsHighlight,
  setRecordsReportGenerated,
  updateRecord,
} from "@/api/records";
import EditableChoiceInput from "@/components/EditableChoiceInput.vue";
import EditableDateInput from "@/components/EditableDateInput.vue";
import LedgerTemplateManager from "@/components/LedgerTemplateManager.vue";
import ProjectFieldManager from "@/components/ProjectFieldManager.vue";
import { updateField } from "@/api/projects";
import { useAppStore } from "@/stores/app";
import {
  cloneLedgerRecord,
  createLedgerHistoryEntry,
  useLedgerHistory,
  type LedgerHistoryEntry,
} from "@/composables/useLedgerHistory";
import type {
  FieldDefinition,
  ProjectRecord,
  RecordStatus,
  NativePreviewTask,
  PreviewCapabilities,
  PrintEngine,
  RecordCellBatchCommitResult,
  RecordBatchNewRecord,
  RecordCellChange,
  RecordReorderByDatePreview,
} from "@/types/api";
import type {
  QuickEntryChangedPayload,
  QuickEntryProjectChange,
} from "@/types/electron";
import {
  buildGridFillEntries,
  type GridFillMode,
} from "@/utils/ledgerFill";
import {
  buildBatchNewRecords,
  countMissingPasteRows,
  parsePasteEntries,
  resolvePasteTargets,
} from "@/utils/ledgerPaste";
import { normalizeDateInput, shanghaiDateKey } from "@/utils/datetime";
import {
  nextGridScrollOffset,
  type GridAutoScrollDirection,
} from "@/utils/gridAutoScroll";
import {
  calculateLedgerBestFitWidth,
  LEDGER_COLUMN_MAX_WIDTH,
  LEDGER_COLUMN_MIN_WIDTH,
  ledgerCellHorizontalPadding,
} from "@/utils/ledgerColumnWidth";
import { desktopBridge } from "@/utils/desktop";
import LedgerContextMenu from "@/components/ledger/LedgerContextMenu.vue";
import LedgerValidationDialog from "@/components/ledger/LedgerValidationDialog.vue";
import LedgerReorderDialog from "@/components/ledger/LedgerReorderDialog.vue";
import LedgerExportPanel from "@/components/ledger/LedgerExportPanel.vue";
import LedgerHighlightDialog, { type HighlightMode } from "@/components/ledger/LedgerHighlightDialog.vue";
import LedgerSelectionBar from "@/components/ledger/LedgerSelectionBar.vue";
import LedgerFindReplaceDialog from "@/components/ledger/LedgerFindReplaceDialog.vue";
import LedgerCommandCard from "@/components/ledger/LedgerCommandCard.vue";
import { logError } from "@/utils/logger";
import { registerWindowCloseGuard } from "@/utils/windowCloseGuard";
import {
  GRID_CELL_KEY_SEPARATOR,
  makeGridCellHelpers,
  moveGridCellByTab as stepGridCellByTab,
  normalizedGridRange,
  sameGridCell,
  splitGridCellKey,
  type GridCellPosition,
  type GridCellRange,
  type NormalizedGridRange,
} from "@/utils/gridSelectionModel";
import { useLedgerContext } from "@/composables/useLedgerContext";
import { useLedgerRecords } from "@/composables/useLedgerRecords";
import { useLedgerGridSelection } from "@/composables/useLedgerGridSelection";
import { useGridPointerDrag } from "@/composables/useGridPointerDrag";
import { useGridFillDrag } from "@/composables/useGridFillDrag";
import {
  useLedgerCellSaveState,
  type CellSaveStatus,
} from "@/composables/useLedgerCellSaveState";
import { useLedgerValidationPanel } from "@/composables/useLedgerValidationPanel";
import { useLedgerGridClipboard } from "@/composables/useLedgerGridClipboard";
import { useLedgerGridScrollFocus } from "@/composables/useLedgerGridScrollFocus";
import { useLedgerCellSave, type ValidationCellRollbackSnapshot } from "@/composables/useLedgerCellSave";
import { useLedgerRangeRefresh } from "@/composables/useLedgerRangeRefresh";
import { useLedgerFindReplace } from "@/composables/useLedgerFindReplace";
import { useLedgerDraftRows } from "@/composables/useLedgerDraftRows";
import { useLedgerPersistDraft } from "@/composables/useLedgerPersistDraft";
import { buildValidationPromptCopy } from "@/utils/validationPrompt";
import {
  LEDGER_GRID_CLIPBOARD_MIME,
  expandLedgerSingleCellPaste,
  parseLedgerGridClipboardPayload,
  type LedgerGridClipboardCell as GridClipboardCell,
} from "@/utils/ledgerClipboard";
import {
  LEDGER_LAYOUT_SETTINGS_KEY,
  normalizeLedgerLayoutSettings,
  resolveLedgerProjectLayout,
  withLedgerProjectLayout,
  type LedgerLayoutSettingsDocument,
} from "@/utils/ledgerLayoutSettings";
import {
  LatestValuePersistence,
  shouldApplyLedgerEditCompletion,
} from "@/utils/ledgerPersistence";

import {
  type LedgerDraftPlacement,
  type LedgerFieldFilter,
  type LedgerFilterMap,
  type LedgerRow,
  type LedgerSortState,
} from "@/utils/ledgerTableView";
import { getRecordFieldValue as valueFor } from "@/utils/recordFieldValue";
import { summarizeLedgerSelection } from "@/utils/ledgerSelectionStats";
import {
  readLastLedgerProjectId,
  rememberLastLedgerProjectId,
  resolveInitialLedgerProjectId,
} from "@/utils/ledgerProjectPreference";
import {
  applyRecordSelectionRange,
  applyVisibleRecordSelection,
  normalizeRecordSelectionRange,
  recordSelectionRangeContains,
  recordMatchesSelectionScope,
  type RecordSelectionAction,
  type RecordSelectionRange,
  type RecordSelectionScope,
} from "@/utils/ledgerRecordSelection";
import { exportWorkbook } from "@/utils/workbook";
import {
  DEFAULT_LEDGER_RANGE_SETTINGS,
  LEDGER_RANGE_SETTINGS_KEY,
  LEDGER_RANGE_MONTHS_MAX,
  LEDGER_RANGE_COUNT_MAX,
  ledgerRangeLabel,
  normalizeLedgerRangeSettings,
  resolveLedgerRecordRange,
  type LedgerRangeSettings,
} from "@/utils/ledgerRangeSettings";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const ledgerHistory = useLedgerHistory();
const canUndoHistory = ledgerHistory.canUndo;
const canRedoHistory = ledgerHistory.canRedo;
const historyBusy = ledgerHistory.busy;

const ledgerContext = useLedgerContext();
const {
  activeProjectId,
  currentProject,
  fields,
  fieldById,
  records,
  tableRef,
} = ledgerContext;
const selectedRecords = ref<ProjectRecord[]>([]);
const ledgerDisplaySettings = ref<LedgerDisplaySettings>({
  ...DEFAULT_LEDGER_DISPLAY_SETTINGS,
});
const ledgerRangeSettings = ref<LedgerRangeSettings>({ ...DEFAULT_LEDGER_RANGE_SETTINGS });
const ledgerRangeDraft = ref<LedgerRangeSettings>({ ...DEFAULT_LEDGER_RANGE_SETTINGS });
const ledgerRangeSaving = ref(false);
let persistedLedgerRange: unknown = null;
const ledgerRangeSummary = computed(() => ledgerRangeLabel(ledgerRangeSettings.value));
const ledgerRangeDates = computed(() => {
  const range = resolveLedgerRecordRange(ledgerRangeDraft.value);
  if (!range.experiment_date_from) return "";
  return range.experiment_date_to
    ? `${range.experiment_date_from} 至 ${range.experiment_date_to}`
    : `${range.experiment_date_from} 起`;
});
const ledgerTableCardRef = ref<HTMLElement | null>(null);
const projectStripRef = ref<HTMLElement | null>(null);
const ledgerHorizontalScrollbarRef = ref<HTMLElement | null>(null);
const LEDGER_HORIZONTAL_SCROLLBAR_HEIGHT = 10;
type AutosizeTextareaInstance = { resizeTextarea: () => void };
const autosizeTextareaRefs = new Map<string, AutosizeTextareaInstance>();
type GridCellEditSnapshot = { rowId: string; fieldId: string; value: string };
type GridPasteEntry = GridClipboardCell;
type RecordSelectionDragPreview = {
  range: RecordSelectionRange;
  selected: boolean;
  initialSelectedIds: ReadonlySet<string>;
};
type RecordSelectionDragState = {
  pointerId: number;
  anchorIndex: number;
  focusIndex: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  selected: boolean;
  initialSelectedIds: Set<string>;
  tableElement: HTMLElement;
  lastAppliedIndex: number | null;
  verticalScrollDirection: GridAutoScrollDirection;
};
const editingGridCell = ref<GridCellPosition | null>(null);
const editingGridSnapshot = ref<GridCellEditSnapshot | null>(null);
let gridCellEditFinishPromise: Promise<boolean> | null = null;
let gridCellEditSession = 0;
let suppressGridFocusReset = false;
const pointerDragThreshold = 10;
const recordSelectionDragging = ref(false);
const recordSelectionDragPreview = shallowRef<RecordSelectionDragPreview | null>(null);
let recordSelectionDragState: RecordSelectionDragState | null = null;
let recordSelectionDragFrame: number | null = null;
let pendingRecordSelectionIndex: number | null = null;
let recordSelectionAutoScrollFrame: number | null = null;
let recordSelectionAutoScrollTimestamp: number | null = null;
let recordSelectionAnchorId: string | null = null;
let suppressRecordSelectionClick = false;
let bottomScrollTimers: number[] = [];
const historyReplayLoading = ref(false);
const closeSaving = ref(false);
const preparingClose = ref(false);
const quickEntryRefreshInProgress = ref(false);
const cellSaveStatusLabels: Record<CellSaveStatus | "idle", string> = {
  dirty: "未保存",
  saving: "保存中",
  saved: "已保存",
  error: "失败",
  idle: "无改动",
};
const managerVisible = ref(false);
const templateManagerVisible = ref(false);
const ledgerLayoutSettings = ref<LedgerLayoutSettingsDocument>(
  normalizeLedgerLayoutSettings(null),
);
const columnWidthSaveQueues = new Map<string, LatestValuePersistence<number>>();
const previewScope = ref<LedgerPreviewScope>(DEFAULT_LEDGER_PREVIEW_SCOPE);
const previewEngine = ref<PrintEngine>("auto");
const previewCapabilities = ref<PreviewCapabilities | null>(null);
const nativePreviewLoading = ref(false);
const columnToolsVisible = ref(false);
const columnToolsOpenFieldId = ref("");
const columnToolsPosition = reactive({ left: 0, top: 0 });
const reorderDialogVisible = ref(false);
const reorderDate = ref("");
const reorderPreview = ref<RecordReorderByDatePreview | null>(null);
const reorderLoading = ref(false);
type LedgerColumnToolsDraft = {
  text: string;
  options: string[];
  start: string;
  end: string;
  emptyOnly: boolean;
};
const columnToolsDraft = reactive<LedgerColumnToolsDraft>({
  text: "",
  options: [],
  start: "",
  end: "",
  emptyOnly: false,
});
const ledgerSort = ref<LedgerSortState>(null);
const ledgerFilters = ref<LedgerFilterMap>({});
type LedgerContextMenuTarget = {
  kind: "cell" | "row";
  rowId: string;
  fieldId?: string;
};
const ledgerContextMenu = ref<{
  x: number;
  y: number;
  submenuLeft: boolean;
  target: LedgerContextMenuTarget;
} | null>(null);
const exportVisible = ref(false);
const moreActionsVisible = ref(false);
const showLockedRecords = ref(false);
const exportFilter = reactive({
  start: "",
  end: "",
});
const draftRows = ref<LedgerRow[]>([]);
const {
  loading,
  recordTotal,
  loadedRecordCount,
  baseTableRows,
  tableRows,
  tableRowIndexById,
  queryLedgerRecordIds,
  ledgerRecordCache,
  invalidateProjectRecordCache,
  updateCachedRecord,
  disposeRecords,
  loadRecords,
  buildRecordQuery,
} = useLedgerRecords(ledgerContext, { draftRows, ledgerSort, ledgerFilters }, () => ({
  ledgerHistory,
  ledgerRangeSettings,
  showLockedRecords: () => showLockedRecords.value,
  loadBatchSize: () => loadBatchSize.value,
  pendingLedgerRangeApplication,
  cancelLedgerRangeRefresh: () => cancelLedgerRangeRefresh(),
  scheduleLedgerRangeRefresh: (projectId: string) => scheduleLedgerRangeRefresh(projectId),
  savingIds: () => savingIds.value,
  hasDirtyLedgerChanges: () => hasDirtyLedgerChanges(),
  editingGridCell: () => editingGridCell.value,
  clearAllCellSaveStates,
  fieldErrors,
  findReplacePreview,
  focusRecordId,
  activeGridCell,
  gridSelectionAnchor: () => gridSelectionAnchor.value,
  gridCellRange: () => gridCellRange.value,
  selectedGridCellKeys: () => selectedGridCellKeys.value,
  captureGridIdentity,
  restoreGridIdentity,
  selectedGridCellPositions,
  replaceGridCellSelection,
  clearGridCellSelection,
  selectedRecords,
  selectedRecordIds,
  selectedRecordCache,
  clearRecordSelection,
  rememberAll,
  clearBottomScrollTimers,
  clearSelectionsAfterLedgerViewChange,
  refreshTableLayout,
  scrollToFocusedRecord,
  scrollTableToBottomOnce,
}));
const {
  activeGridCell,
  gridCellRange,
  selectedGridCellKeys,
  gridSelectionAnchor,
  captureGridIdentity,
  restoreGridIdentity,
  replaceGridCellSelection,
  toggleGridCell,
  clearGridCellSelection,
  selectedGridCellPositions,
  isGridCellSelected,
  selectGridCell,
  materializeGridCellRangeSelection,
} = useLedgerGridSelection({ fields, tableRows, tableRowIndexById });
const focusRecordId = ref("");
const highlightDialogVisible = ref(false);
const highlightLoading = ref(false);
const highlightColor = ref("#fff2cc");
const highlightTargetIds = ref<string[]>([]);
type CellHighlightTarget = { recordId: string; fieldId: string };
const highlightMode = ref<HighlightMode>("record");
const highlightCellTargets = ref<CellHighlightTarget[]>([]);
/**
 * 已修改但尚未写回服务端的单元格 key（`recordId:fieldId`）。
 *
 * 只用于"是否存在未保存修改"这类高频判断（100ms 范围刷新、关闭前置检查），
 * 避免每次都对 records × fields 做全量 diff。真正的保存载荷仍然由
 * `dirtyLedgerChanges()` 全量扫描生成，因此即使这个集合过期，也只会让
 * 刷新时机略微保守，不会丢失任何修改。
 */
let ledgerDisposed = false;
let removeQuickEntryChangedListener: (() => void) | undefined;
let quickEntryRefreshPromise: Promise<void> = Promise.resolve();
const QUICK_ENTRY_RETRY_DELAY_MS = 500;
let quickEntryRetryTimer: number | undefined;
const quickEntryRetryPending = new Map<string, number>();
const loadBatchSize = computed(() => ledgerDisplaySettings.value.loadBatchSize);
const selectedRecordIds = ref(new Set<string>());
const selectedRecordCache = new Map<string, ProjectRecord>();

const ledgerCellSaveState = useLedgerCellSaveState();
const {
  cellSaveStates,
  persistedKey,
  setCellSaveState,
  clearCellSaveState,
  clearAllCellSaveStates,
  peekCellSaveVersion,
  dropCellSaveVersion,
  hasCellSaveInFlight,
  dropCellSaveInFlight,
  clearCellSaveInFlight,
} = ledgerCellSaveState;
const ledgerValidationPanel = useLedgerValidationPanel({
  projectId: () => activeProjectId.value,
  peekCellSaveVersion,
  commitTokenPanel: async (panel) => {
    const result = await commitCellBatch(panel.token, true);
    const completedKeys = new Set(panel.cellKeys);
    result.records.forEach((record) => replaceRecordPreservingPending(record, completedKeys));
    panel.cellKeys.forEach((key) => {
      const [recordId = "", fieldId = ""] = key.split(":");
      if (recordId && fieldId) setCellSaveState(recordId, fieldId, { status: "saved" });
    });
    pushCellHistory(panel.label, result.changes, panel.projectId);
    ElMessage.success(`已保存 ${new Set(result.changes.map((change) => change.record_id)).size} 条记录`);
  },
});
const {
  validationPanel,
  validationCommitLoading,
  openValidationPanel,
  dismissValidationPanel,
  cancelValidationPanel,
  continueValidationCommit,
} = ledgerValidationPanel;

const {
  savingIds,
  fieldErrors,
  persistedValues,
  setSaving,
  fieldErrorFor,
  setFieldError,
  clearFieldError,
  rememberRecord,
  rememberAll,
  setValue,
  cellSaveStateFor,
  dirtyLedgerChanges,
  hasDirtyLedgerChanges,
  captureValidationCellRollback,
  rollbackValidationCells,
  replaceRecordPreservingPending,
  pushCellHistory,
  saveField,
} = useLedgerCellSave({
  cellSave: ledgerCellSaveState,
  panel: ledgerValidationPanel,
  history: ledgerHistory,
  records,
  fields,
  tableRows,
  fieldById,
  recordSelection: {
    selectedRecords,
    selectedRecordIds,
    selectedRecordCache,
  },
  activeProjectId: () => activeProjectId.value,
  isDraft: (record) => isDraft(record),
  persistDraft: (record) => persistDraft(record),
  replaceRecord,
  updateCachedRecord,
  scheduleLedgerRangeRefresh: (projectId) => scheduleLedgerRangeRefresh(projectId),
});
const {
  pendingLedgerRangeApplication,
  scheduleLedgerRangeRefresh,
  cancelLedgerRangeRefresh,
} = useLedgerRangeRefresh({
  isDisposed: () => ledgerDisposed,
  isRangeSaving: () => ledgerRangeSaving.value,
  getActiveProjectId: () => activeProjectId.value,
  isAllMode: () => ledgerRangeSettings.value.mode === "all",
  isBusy: () => savingIds.value.size > 0 || hasCellSaveInFlight() || loading.value,
  isBlockedByEdits: () => Boolean(editingGridCell.value) || hasDirtyLedgerChanges(),
  refresh: (projectId) => {
    void loadRecords(projectId, {
      showLoading: false, preserveHistory: true, preserveSelection: true, deferForPendingEdits: true,
    });
  },
});

const {
  isDraft,
  makeDraftRow,
  nextInsertGroupId,
  appendDraftRow,
  removeDraftRows,
  dirtyLedgerDrafts,
  snapshotRecord,
  reanchorPendingInsertedDrafts,
  cleanupInsertedGroupRegistry,
} = useLedgerDraftRows({
  draftRows,
  fields,
  currentProject,
  activeProjectId,
  loading,
  cellSave: {
    persistedKey,
    clearCellSaveState,
    dropCellSaveVersion,
    dropCellSaveInFlight,
    setSaving,
    fieldErrors,
  },
  selection: {
    activeGridCell,
    clearGridCellSelection,
  },
  editing: {
    editingGridSnapshot,
    clearGridCellEdit,
  },
  scrollToBottom: () => scrollTableToBottom(),
});

const {
  persistDraft,
} = useLedgerPersistDraft({
  fields,
  drafts: {
    draftRows,
    isDraft,
    removeDraftRows,
    reanchorPendingInsertedDrafts,
    cleanupInsertedGroupRegistry,
  },
  cellSave: {
    savingIds,
    fields,
    setFieldError,
    clearFieldError,
    setSaving,
    rememberRecord,
  },
  panel: {
    openValidationPanel,
  },
  editing: {
    editingGridSnapshot,
    clearGridCellEdit,
  },
  currentProject,
  records,
  loadedRecordCount,
  recordTotal,
  focusRecordId,
  ledgerRangeSettings,
  ledgerFilters,
  activeProjectId: () => activeProjectId.value,
  invalidateProjectRecordCache,
  pushHistory,
  queryRecordIds: (projectId) => queryLedgerRecordIds(buildRecordQuery(projectId)),
  loadRecords: (projectId, options) => loadRecords(projectId, options),
  scrollToFocusedRecord,
});

const {
  findReplaceVisible,
  findReplaceLoading,
  findReplacePreview,
  findReplaceScopeCount,
  findReplaceScopeLabel,
  findReplaceMode,
  findReplaceInputRef,
  findReplaceForm,
  findMatches,
  findCurrentMatch,
  findMatchStatus,
  setFindReplaceMode,
  openFindReplace,
  runFindReplacePreview,
  commitFindReplace,
  handleFindReplaceInputEnter,
  navigateFindMatch,
  cancelFindTermDebounce,
  focusFindReplaceInput,
  restoreFindReplaceGridFocus,
} = useLedgerFindReplace({
  fields,
  tableRows,
  tableRowIndexById,
  records,
  selection: {
    activeGridCell,
    gridSelectionAnchor,
    gridCellRange,
    selectedGridCellKeys,
    selectGridCell,
    selectedGridCellPositions,
  },
  clampCell: (position) => clampGridCell(position),
  tableRef,
  gridEditorRoot,
  editingGridCell,
  commitEditThen: () => finishGridCellEdit(true, false),
  focusCell: (position) => {
    void focusGridCell(position);
  },
  isDraft,
  getProjectId: () => activeProjectId.value,
  queryRecordIds: () => queryLedgerRecordIds(buildRecordQuery()),
  replaceRecord,
  pushCellHistory: (label, changes, projectId) => pushCellHistory(label, changes, projectId),
});
function registerFindReplaceInput(element: { focus: () => void } | null): void {
  findReplaceInputRef.value = element;
}
const recordSelectionScope = ref<RecordSelectionScope>("all");
let ledgerInitialized = false;
let projectViewGeneration = 0;
let projectLoadPromise: Promise<void> | null = null;
let ledgerLayoutSaveQueue: Promise<void> = Promise.resolve();

function normalizeQuickEntryProjectChange(
  change: { projectId?: unknown; revision?: unknown },
): QuickEntryProjectChange | null {
  const projectId = typeof change.projectId === "string" ? change.projectId.trim() : "";
  const revision = Number(change.revision);
  if (!projectId) return null;
  return {
    projectId,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 0,
  };
}

async function acknowledgeQuickEntryChanges(changes: QuickEntryProjectChange[]): Promise<void> {
  const bridge = desktopBridge();
  const acknowledged = changes.filter((change) => change.revision > 0);
  if (bridge?.windowKind !== "main" || !acknowledged.length) return;
  try {
    await bridge.acknowledgeQuickEntryChanges(acknowledged);
  } catch (error) {
    logError("ledger", "快速录入变更确认失败", error);
  }
}

function hasPendingLedgerEdits(): boolean {
  return Boolean(
    loading.value
    || editingGridCell.value
    || savingIds.value.size
    || hasCellSaveInFlight()
    || hasDirtyLedgerChanges(),
  );
}

function scheduleQuickEntryRetry(changes: QuickEntryProjectChange[] = []): void {
  changes.forEach((change) => {
    const previous = quickEntryRetryPending.get(change.projectId);
    if (previous === undefined || change.revision > previous) {
      quickEntryRetryPending.set(change.projectId, change.revision);
    }
  });
  if (quickEntryRetryTimer !== undefined) return;
  quickEntryRetryTimer = window.setTimeout(() => {
    quickEntryRetryTimer = undefined;
    if (ledgerDisposed) {
      quickEntryRetryPending.clear();
      return;
    }
    if (preparingClose.value) {
      scheduleQuickEntryRetry();
      return;
    }
    const pending = [...quickEntryRetryPending.entries()].map(([projectId, revision]) => ({
      projectId,
      revision,
    }));
    quickEntryRetryPending.clear();
    queueQuickEntryChanges(pending);
  }, QUICK_ENTRY_RETRY_DELAY_MS);
}

async function refreshQuickEntryChanges(changes: QuickEntryProjectChange[]): Promise<void> {
  if (ledgerDisposed || preparingClose.value) return;
  const latestByProject = new Map<string, QuickEntryProjectChange>();
  changes.forEach((change) => {
    const normalized = normalizeQuickEntryProjectChange(change);
    if (!normalized) return;
    const previous = latestByProject.get(normalized.projectId);
    if (!previous || normalized.revision >= previous.revision) {
      latestByProject.set(normalized.projectId, normalized);
    }
  });
  if (!latestByProject.size) return;

  latestByProject.forEach(({ projectId }) => invalidateProjectRecordCache(projectId));
  const currentChange = latestByProject.get(activeProjectId.value);
  const otherChanges = [...latestByProject.values()].filter((change) => (
    change.projectId !== activeProjectId.value
  ));
  if (otherChanges.length) await acknowledgeQuickEntryChanges(otherChanges);
  if (!currentChange) return;
  if (hasPendingLedgerEdits()) {
    scheduleQuickEntryRetry([currentChange]);
    return;
  }
  const currentProjectLoaded = await loadRecords(currentChange.projectId, {
    showLoading: false,
    preserveHistory: true,
    preserveSelection: true,
    deferForPendingEdits: true,
  });
  if (ledgerDisposed) return;
  if (!currentProjectLoaded) {
    // The load was deferred (edits started while it ran) or superseded; retry
    // instead of acknowledging, otherwise the change would never re-apply.
    scheduleQuickEntryRetry([currentChange]);
    return;
  }
  await acknowledgeQuickEntryChanges([currentChange]);
}

function queueQuickEntryChanges(changes: QuickEntryProjectChange[]): void {
  if (!changes.length) return;
  const task = quickEntryRefreshPromise
    .catch(() => undefined)
    .then(async () => {
      quickEntryRefreshInProgress.value = true;
      try { await refreshQuickEntryChanges(changes); }
      finally { quickEntryRefreshInProgress.value = false; }
    });
  quickEntryRefreshPromise = task.catch((error) => {
    logError("ledger", "快速录入变更刷新失败", error);
  });
}

function handleQuickEntryChanged(payload: QuickEntryChangedPayload): void {
  if (preparingClose.value) return; // Main keeps unacknowledged revisions for the next refresh.
  const change = normalizeQuickEntryProjectChange(payload);
  if (change) queueQuickEntryChanges([change]);
}

async function requestPendingQuickEntryChanges(): Promise<void> {
  const bridge = desktopBridge();
  if (bridge?.windowKind !== "main") return;
  try {
    await quickEntryRefreshPromise;
    const pending = await bridge.getPendingQuickEntryChanges();
    queueQuickEntryChanges(pending);
  } catch (error) {
    logError("ledger", "读取快速录入待刷新项目失败", error);
  }
}

function handleLedgerWindowFocus(): void {
  if (preparingClose.value) return;
  void requestPendingQuickEntryChanges();
}

type LedgerVirtualColumnKind = "selection" | "lock" | "field";
type LedgerVirtualColumn = Column<unknown> & {
  kind: LedgerVirtualColumnKind;
  fieldId?: string;
  field?: FieldDefinition;
  fieldIndex?: number;
};
const ledgerZoomScale = computed(() => ledgerDisplaySettings.value.zoomPercent / 100);
const ledgerBaseEditorHeight = computed(() => Math.round(
  (Math.max(32, ledgerDisplaySettings.value.fontSizePx + 18)
    * ledgerDisplaySettings.value.editorHeightPercent) / 100,
));
const ledgerVirtualRowHeight = computed(() => Math.max(
  34,
  Math.round(
    (ledgerBaseEditorHeight.value + ledgerDisplaySettings.value.rowPaddingY)
      * ledgerZoomScale.value,
  ),
));
const ledgerVirtualHeaderHeight = computed(() => Math.max(
  36,
  Math.round(44 * ledgerZoomScale.value),
));
const showLockColumn = computed(
  () => showLockedRecords.value && records.value.some((record) => record.locked),
);
const ledgerVirtualColumns = computed<LedgerVirtualColumn[]>(() => {
  const scale = ledgerZoomScale.value;
  return [
    {
      key: "__selection",
      dataKey: "id",
      kind: "selection",
      width: Math.max(44, Math.round(55 * scale)),
      fixed: TableV2FixedDir.LEFT,
      align: "center",
    },
    ...(showLockColumn.value
      ? [{
          key: "__lock",
          kind: "lock" as const,
          width: Math.max(36, Math.round(42 * scale)),
          fixed: TableV2FixedDir.LEFT,
          align: "center" as const,
        }]
      : []),
    ...fields.value.map((field, fieldIndex) => ({
      key: field.id,
      dataKey: field.id,
      kind: "field" as const,
      fieldId: field.id,
      field,
      fieldIndex,
      title: field.label,
      width: Math.max(48, Math.round(field.width * scale)),
      align: "center" as const,
    })),
  ];
});
const ledgerVirtualContentWidth = computed(() =>
  ledgerVirtualColumns.value.reduce((total, column) => total + column.width, 0),
);
const selectedCount = computed(() => selectedRecordIds.value.size);
const gridCellSelectionCount = computed(() => {
  const range = gridCellRange.value;
  if (!range) return selectedGridCellKeys.value.size;
  const normalized = normalizedGridRange(range);
  return (
    (normalized.rowEnd - normalized.rowStart + 1) *
    (normalized.columnEnd - normalized.columnStart + 1)
  );
});
const hasGridCellSelection = computed(() => gridCellSelectionCount.value > 0);
const batchSelectionActive = computed(() => selectedCount.value > 0 || hasGridCellSelection.value);
const gridCellInternalEditing = computed(() => Boolean(editingGridCell.value));
const columnToolsField = computed(
  () => fieldById.value.get(columnToolsOpenFieldId.value) ?? null,
);
const columnToolsFilterKind = computed<"text" | "options" | "date-range">(() => {
  const field = columnToolsField.value;
  if (!field) return "text";
  if (field.data_type === "date" || field.system_key === "experiment_date") return "date-range";
  if (field.data_type === "select" || field.options.length || field.system_key === "status") {
    return "options";
  }
  return "text";
});
const columnToolOptions = computed(() =>
  columnToolsField.value ? filterOptionsForField(columnToolsField.value) : [],
);
const contextMenuRow = computed<LedgerRow | null>(() => {
  const target = ledgerContextMenu.value?.target;
  if (!target) return null;
  return tableRows.value.find((row) => row.id === target.rowId) ?? null;
});
const contextMenuCell = computed<GridCellPosition | null>(() => {
  const target = ledgerContextMenu.value?.target;
  if (!target?.fieldId) return null;
  const rowIndex = tableRowIndexById.value.get(target.rowId) ?? -1;
  const columnIndex = fields.value.findIndex((field) => field.id === target.fieldId);
  return rowIndex >= 0 && columnIndex >= 0 ? { rowIndex, columnIndex } : null;
});
const contextDeleteRecordCount = computed(() => {
  const row = contextMenuRow.value;
  if (!row) return 0;
  return selectedRecordIds.value.has(row.id) ? Math.max(1, selectedRecordIds.value.size) : 1;
});
const contextSuggestedInsertRowCount = computed(() => {
  const target = ledgerContextMenu.value?.target;
  if (!target) return 1;
  if (target.kind === "row") {
    return selectedRecordIds.value.has(target.rowId)
      ? Math.max(1, selectedRecordIds.value.size)
      : 1;
  }
  const cell = contextMenuCell.value;
  if (!cell || !selectedGridCellKeys.value.has(gridCellKey(cell))) return 1;
  return Math.max(
    1,
    new Set(selectedGridCellPositions().map((position) => position.rowIndex)).size,
  );
});
const contextInsertRowCount = ref<number | "">(1);
const ledgerFontOption = computed(
  () =>
    LEDGER_FONT_FAMILY_OPTIONS.find(
      (option) => option.value === ledgerDisplaySettings.value.fontFamily,
    ) ?? LEDGER_FONT_FAMILY_OPTIONS[0],
);
const ledgerTableStyle = computed<CSSProperties>(
  () => {
    const scale = ledgerZoomScale.value;
    return ({
      "--ledger-row-gap": `${Math.round(ledgerDisplaySettings.value.rowPaddingY * scale)}px`,
      "--ledger-editor-width": `${ledgerDisplaySettings.value.editorWidthPercent}%`,
      "--ledger-editor-height": `${Math.max(28, Math.round(ledgerBaseEditorHeight.value * scale))}px`,
      "--ledger-selection-min-height": `${ledgerVirtualRowHeight.value}px`,
      "--ledger-cell-padding-x": `${Math.max(2, Math.round(ledgerCellHorizontalPadding(ledgerDisplaySettings.value.fontSizePx) * scale))}px`,
      "--ledger-font-family": ledgerFontOption.value?.css ?? "system-ui, sans-serif",
      "--ledger-font-size": `${Math.max(8, Math.round(ledgerDisplaySettings.value.fontSizePx * scale))}px`,
    }) as CSSProperties;
  },
);

function columnFilterKind(field: FieldDefinition): "text" | "options" | "date-range" {
  if (field.data_type === "date" || field.system_key === "experiment_date") return "date-range";
  if (field.data_type === "select" || field.options.length || field.system_key === "status") {
    return "options";
  }
  return "text";
}

function filterOptionsForField(field: FieldDefinition): string[] {
  const values = new Set(fieldOptions(field));
  if (field.system_key === "status") {
    values.add("待实验");
    values.add("已完成");
  }
  baseTableRows.value.forEach((row) => values.add(valueFor(row, field)));
  return [...values].sort((left, right) => {
    if (!left) return -1;
    if (!right) return 1;
    return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

function closeLedgerContextMenu(): void {
  ledgerContextMenu.value = null;
}

function closeColumnTools(): void {
  columnToolsOpenFieldId.value = "";
}

// 原生 title 悬浮提示：仅当单元格文本被截断时设置，浏览器自带延迟与滚动/移开关闭
function updateCellTitle(event: MouseEvent, content: string): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  if (target.scrollWidth > target.clientWidth + 1
    || target.scrollHeight > target.clientHeight + 1) {
    target.title = content;
  }
}

function clearCellTitle(event: MouseEvent): void {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) target.title = "";
}

function closeLedgerOverlays(): void {
  closeColumnTools();
  closeLedgerContextMenu();
}

function clearRecordSelection(): void {
  stopRecordSelectionDrag(false);
  recordSelectionAnchorId = null;
  selectedRecords.value = [];
  selectedRecordIds.value = new Set();
  selectedRecordCache.clear();
}

function clearSelectionsAfterLedgerViewChange(): void {
  activeGridCell.value = null;
  clearGridCellSelection();
  clearRecordSelection();
}

function clearBatchSelection(): void {
  clearRecordSelection();
  clearGridCellSelection();
}

async function restoreGridFocusAfterLedgerViewChange(
  activeIdentity: { rowId: string; fieldId: string } | null,
  anchorIdentity: { rowId: string; fieldId: string } | null,
): Promise<void> {
  await nextTick();
  const active = restoreGridIdentity(activeIdentity);
  const anchor = restoreGridIdentity(anchorIdentity);
  if (!active) {
    activeGridCell.value = null;
    gridSelectionAnchor.value = null;
    gridCellRange.value = null;
    return;
  }
  activeGridCell.value = active;
  gridSelectionAnchor.value = anchor ?? active;
  gridCellRange.value = null;
  await focusGridCell(active);
}

function resetColumnToolsDraft(field: FieldDefinition): void {
  columnToolsDraft.text = "";
  columnToolsDraft.options = [];
  columnToolsDraft.start = "";
  columnToolsDraft.end = "";
  columnToolsDraft.emptyOnly = false;
  const filter = ledgerFilters.value[field.id];
  if (!filter) return;
  if (filter.kind === "text") columnToolsDraft.text = filter.value;
  else if (filter.kind === "options") {
    if (columnFilterKind(field) === "text" && filter.values.length === 1 && filter.values[0] === "") {
      columnToolsDraft.emptyOnly = true;
    } else {
      columnToolsDraft.options = [...filter.values];
    }
  }
  else {
    columnToolsDraft.start = filter.start;
    columnToolsDraft.end = filter.end;
  }
}

function openColumnTools(field: FieldDefinition, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  resetColumnToolsDraft(field);
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const rect = trigger?.getBoundingClientRect();
  const width = 330;
  const height = columnFilterKind(field) === "options" ? 360 : 300;
  const left = rect?.left ?? event.clientX;
  const top = (rect?.bottom ?? event.clientY) + 6;
  columnToolsPosition.left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  columnToolsPosition.top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  columnToolsOpenFieldId.value = field.id;
}

function toggleColumnTools(): void {
  columnToolsVisible.value = !columnToolsVisible.value;
  if (!columnToolsVisible.value) closeColumnTools();
}

type LedgerTableScrollPosition = {
  top: number;
  left: number;
};

function handleLedgerTableScroll(position: { scrollLeft?: number; scrollTop?: number }): void {
  // 必须先于下方 scrollbar 早退：无横向滚动条时纵向滚动同样会丢焦点。
  keepGridFocusOnScroll();
  const scrollbar = ledgerHorizontalScrollbarRef.value;
  if (!scrollbar || typeof position.scrollLeft !== "number") return;
  if (Math.abs(scrollbar.scrollLeft - position.scrollLeft) > 0.5) {
    scrollbar.scrollLeft = position.scrollLeft;
  }
}

function handleLedgerHorizontalScrollbarScroll(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  tableRef.value?.scrollToLeft(target.scrollLeft);
}

function captureLedgerTableScroll(): LedgerTableScrollPosition | null {
  const tableRoot = ledgerTableCardRef.value;
  if (!tableRoot) return null;
  const body = gridTableBodyScrollElement(tableRoot);
  return body
    ? {
        top: body.scrollTop,
        left: ledgerHorizontalScrollbarRef.value?.scrollLeft ?? body.scrollLeft,
      }
    : null;
}

function restoreLedgerTableScroll(position: LedgerTableScrollPosition | null): void {
  if (!position) return;
  const tableRoot = ledgerTableCardRef.value;
  if (!tableRoot) return;
  const body = gridTableBodyScrollElement(tableRoot);
  if (!body) return;
  body.scrollTop = position.top;
  tableRef.value?.scrollToLeft(position.left);
  if (ledgerHorizontalScrollbarRef.value) {
    ledgerHorizontalScrollbarRef.value.scrollLeft = position.left;
  }
}

function setLedgerSort(field: FieldDefinition, order: "ascending" | "descending" | null): void {
  clearBottomScrollTimers();
  const activeIdentity = captureGridIdentity(activeGridCell.value);
  const anchorIdentity = captureGridIdentity(gridSelectionAnchor.value);
  const scrollPosition = captureLedgerTableScroll();
  ledgerSort.value = order ? { fieldId: field.id, order } : null;
  void persistLedgerProjectLayout();
  closeColumnTools();
  if (!draftRows.value.length || (ledgerRangeSettings.value.mode !== "all" && !hasDirtyLedgerChanges())) {
    void loadRecords(activeProjectId.value, { preserveHistory: true });
    return;
  }
  void (async () => {
    await restoreGridFocusAfterLedgerViewChange(activeIdentity, anchorIdentity);
    await nextTick();
    restoreLedgerTableScroll(scrollPosition);
  })();
}

function applyColumnFilter(): void {
  const field = columnToolsField.value;
  if (!field) return;
  clearBottomScrollTimers();
  const kind = columnFilterKind(field);
  if (kind === "date-range" && columnToolsDraft.start && columnToolsDraft.end &&
      columnToolsDraft.start > columnToolsDraft.end) {
    ElMessage.warning("开始日期不能晚于结束日期");
    return;
  }
  let filter: LedgerFieldFilter | undefined;
  if (kind === "options") {
    filter = { kind, values: [...columnToolsDraft.options] };
  } else if (kind === "date-range") {
    filter = { kind, start: columnToolsDraft.start, end: columnToolsDraft.end };
  } else if (columnToolsDraft.emptyOnly) {
    filter = { kind: "options", values: [""] };
  } else {
    filter = { kind, value: columnToolsDraft.text };
  }
  const nextFilters = { ...ledgerFilters.value };
  if (!filter || (filter.kind === "text" && !filter.value.trim()) ||
      (filter.kind === "options" && !filter.values.length) ||
      (filter.kind === "date-range" && !filter.start && !filter.end)) {
    delete nextFilters[field.id];
  } else {
    nextFilters[field.id] = filter;
  }
  ledgerFilters.value = nextFilters;
  void persistLedgerProjectLayout();
  clearSelectionsAfterLedgerViewChange();
  closeColumnTools();
  void loadRecords(activeProjectId.value, { preserveHistory: true });
}

function clearColumnFilter(): void {
  const field = columnToolsField.value;
  if (!field) return;
  clearBottomScrollTimers();
  const nextFilters = { ...ledgerFilters.value };
  delete nextFilters[field.id];
  ledgerFilters.value = nextFilters;
  void persistLedgerProjectLayout();
  clearSelectionsAfterLedgerViewChange();
  closeColumnTools();
  void loadRecords(activeProjectId.value, { preserveHistory: true });
}

function gridCellFromElement(element: EventTarget | null): GridCellPosition | null {
  if (!(element instanceof Element)) return null;
  const editor = element.closest<HTMLElement>("[data-row-id][data-field-index]");
  if (!editor) return null;
  const rowId = editor.dataset.rowId;
  const columnIndex = Number(editor.dataset.fieldIndex);
  if (!rowId || !Number.isInteger(columnIndex) || columnIndex < 0) return null;
  const rowIndex = tableRowIndexById.value.get(rowId) ?? -1;
  if (rowIndex < 0 || columnIndex >= fields.value.length) return null;
  return { rowIndex, columnIndex };
}

const gridCellHelpers = makeGridCellHelpers(() => tableRows.value, () => fields.value);
const clampGridCell = gridCellHelpers.clamp;
const gridCellKey = gridCellHelpers.key;
const gridCellPositionsForRange = gridCellHelpers.positionsForRange;
const {
  gridSelectionDragging,
  suppressGridClick,
  stopGridCellDrag,
  gridCellAtPoint,
  handleGridPointerDown,
} = useGridPointerDrag({
  cells: gridCellHelpers,
  selection: {
    activeGridCell,
    gridCellRange,
    selectedGridCellKeys,
    gridSelectionAnchor,
    selectGridCell,
    materializeGridCellRangeSelection,
  },
  tableRef,
  cellFromElement: gridCellFromElement,
  bodyScrollElement: gridTableBodyScrollElement,
  isEditingCell: isGridCellEditing,
  commitActiveEdit: () => {
    if (editingGridCell.value) void finishGridCellEdit(true, false);
  },
  focusCell: (position, options) => {
    void focusGridCell(position, options);
  },
  dragThreshold: pointerDragThreshold,
});
const {
  gridFillPreviewRange,
  gridFillPreviewSource,
  gridFillPreviewValues,
  gridFillPreviewSummary,
  gridFillPreviewPointer,
  stopGridFillDrag,
  handleGridFillPointerDown,
} = useGridFillDrag({
  fields,
  tableRows,
  gridCellRange,
  suppressGridClick,
  cellFromElement: gridCellFromElement,
  cellAtPoint: gridCellAtPoint,
  commitEditThen: () => (editingGridCell.value ? finishGridCellEdit(true, false) : Promise.resolve(true)),
  applyFill: applyGridFill,
  dragThreshold: pointerDragThreshold,
});
const { keepGridFocusOnScroll, revealGridPasteTarget, attachDocumentShortcuts } =
  useLedgerGridScrollFocus({
  cardRef: ledgerTableCardRef,
  tableRef,
  rowHeight: ledgerVirtualRowHeight,
  bodyScrollElement: gridTableBodyScrollElement,
  activeGridCell,
  selectionDragging: gridSelectionDragging,
  editingCell: editingGridCell,
  commitActiveEdit: () => finishGridCellEdit(true, false),
  isDisposed: () => ledgerDisposed,
  flashRecord: flashGridRecord,
  handleKeydown: handleGridKeydown,
  handlePaste: handleGridPaste,
  isNativeClipboardTarget: (target) => nativeGridClipboardTarget(target),
});
let removeDocumentGridShortcuts: (() => void) | null = null;

const {
  gridCutInProgress,
  gridClipboardSelection,
  lastGridClipboardPayload,
  clearLastGridClipboard,
  handleGridCopy,
  handleGridCut,
  nativeGridClipboardTarget,
  copyGridSelectionWithNativeCommand,
  copyGridSelectionToClipboard,
  cutGridSelectionToClipboard,
} = useLedgerGridClipboard({
  fields,
  tableRows,
  tableRowIndexById,
  loading,
  activeGridCell,
  selectedGridCellPositions,
  clampCell: (position) => clampGridCell(position),
  cellFromElement: gridCellFromElement,
  cellData: gridCellData,
  isEditingCell: isGridCellEditing,
  peekCellSaveVersion,
  persistedKey,
  projectId: () => activeProjectId.value,
  projectGeneration: () => projectViewGeneration,
  isDisposed: () => ledgerDisposed,
  clearCells: (positions) => clearGridCellRange("剪切", { positions, preserveSelection: true }),
});

function moveGridCell(position: GridCellPosition, rowDelta: number, columnDelta: number): GridCellPosition {
  return clampGridCell({
    rowIndex: position.rowIndex + rowDelta,
    columnIndex: position.columnIndex + columnDelta,
  });
}

function moveGridCellByTab(position: GridCellPosition, backwards: boolean): GridCellPosition {
  return stepGridCellByTab(position, backwards, gridCellHelpers.size());
}

function clearGridCellEdit(invalidateSession = true): void {
  editingGridCell.value = null;
  editingGridSnapshot.value = null;
  if (invalidateSession) gridCellEditSession += 1;
}

function isGridCellEditing(position: GridCellPosition | null): boolean {
  return sameGridCell(editingGridCell.value, position);
}

function gridColumnPositions(fieldIndex: number): GridCellPosition[] {
  if (fieldIndex < 0 || fieldIndex >= fields.value.length) return [];
  return tableRows.value.map((_, rowIndex) => ({ rowIndex, columnIndex: fieldIndex }));
}

const gridHeaderSelectionState = computed(() => {
  const states = new Map<string, "selected" | "partial">();
  const currentRows = tableRows.value;
  if (!currentRows.length) return states;

  const visibleRowIds = new Set(currentRows.map((row) => row.id));
  const visibleFieldIds = new Set(fields.value.map((field) => field.id));
  const selectedCountByField = new Map<string, number>();
  for (const key of selectedGridCellKeys.value) {
    const parts = splitGridCellKey(key);
    if (!parts) continue;
    if (!visibleRowIds.has(parts[0]) || !visibleFieldIds.has(parts[1])) continue;
    selectedCountByField.set(parts[1], (selectedCountByField.get(parts[1]) ?? 0) + 1);
  }
  for (const [fieldId, selectedCount] of selectedCountByField) {
    if (selectedCount === currentRows.length) states.set(fieldId, "selected");
    else states.set(fieldId, "partial");
  }
  return states;
});

async function handleLedgerHeaderClick(
  fieldIndex: number,
  event: PointerEvent,
): Promise<void> {
  if (fieldIndex < 0 || !tableRows.value.length) return;

  if (editingGridCell.value) {
    const saved = await finishGridCellEdit(true, false);
    if (!saved || editingGridCell.value) return;
  }

  event.preventDefault();
  const lastRowIndex = tableRows.value.length - 1;
  const active = { rowIndex: 0, columnIndex: fieldIndex };
  const modifierAdd = event.ctrlKey || event.metaKey;

  if (modifierAdd) {
    const positions = gridColumnPositions(fieldIndex);
    const targetKeys = new Set(positions.map(gridCellKey).filter(Boolean));
    const allSelected = positions.length > 0 && positions.every((position) => {
      const key = gridCellKey(position);
      return Boolean(key && selectedGridCellKeys.value.has(key));
    });
    const nextKeys = new Set(selectedGridCellKeys.value);
    targetKeys.forEach((key) => {
      if (allSelected) nextKeys.delete(key);
      else nextKeys.add(key);
    });
    selectedGridCellKeys.value = nextKeys;
    activeGridCell.value = active;
    if (!gridSelectionAnchor.value) gridSelectionAnchor.value = active;
    gridCellRange.value = null;
    void focusGridCell(active);
    return;
  }

  const modifierShift = event.shiftKey;
  if (modifierShift) {
    const anchorColumn = Math.max(
      0,
      Math.min(
        fields.value.length - 1,
        gridSelectionAnchor.value?.columnIndex ?? activeGridCell.value?.columnIndex ?? fieldIndex,
      ),
    );
    const range = {
      anchor: { rowIndex: 0, columnIndex: anchorColumn },
      focus: { rowIndex: lastRowIndex, columnIndex: fieldIndex },
    };
    replaceGridCellSelection(gridCellPositionsForRange(range), active, range.anchor, range);
    void focusGridCell(active);
    return;
  }

  const range = {
    anchor: { ...active },
    focus: { rowIndex: lastRowIndex, columnIndex: fieldIndex },
  };
  replaceGridCellSelection(gridColumnPositions(fieldIndex), active, active, range);
  void focusGridCell(active);
}

function gridCellClassName(row: LedgerRow, rowIndex: number, fieldIndex: number): string {
  const currentFields = fields.value;
  const active = activeGridCell.value;
  const editing = editingGridCell.value;
  const selectedKeys = selectedGridCellKeys.value;
  const selectedRange = gridCellRange.value
    ? normalizedGridRange(gridCellRange.value)
    : null;
  const fillPreview = gridFillPreviewRange.value;
  const fillSource = gridFillPreviewSource.value;
  if (fieldIndex < 0 || fieldIndex >= currentFields.length) return "";
  const classes: string[] = [];
  const field = currentFields[fieldIndex];
  if (field && row.cell_highlight_colors?.[field.id]) classes.push("cell-highlighted");
  const selectedByRange = Boolean(
    selectedRange
    && rowIndex >= selectedRange.rowStart
    && rowIndex <= selectedRange.rowEnd
    && fieldIndex >= selectedRange.columnStart
    && fieldIndex <= selectedRange.columnEnd
  );
  if (
    field
    && (selectedRange
      ? selectedByRange
      : selectedKeys.has(`${row.id}${GRID_CELL_KEY_SEPARATOR}${field.id}`))
  ) classes.push("grid-cell-selected");
  if (active?.rowIndex === rowIndex && active?.columnIndex === fieldIndex) {
    classes.push("grid-cell-active");
  }
  if (editing?.rowIndex === rowIndex && editing?.columnIndex === fieldIndex) {
    classes.push("grid-cell-editing");
  }
  if (
    fillPreview
    && rowIndex >= fillPreview.rowStart
    && rowIndex <= fillPreview.rowEnd
    && fieldIndex >= fillPreview.columnStart
    && fieldIndex <= fillPreview.columnEnd
    && (!fillSource
      || rowIndex < fillSource.rowStart
      || rowIndex > fillSource.rowEnd
      || fieldIndex < fillSource.columnStart
      || fieldIndex > fillSource.columnEnd)
  ) classes.push("grid-cell-fill-preview");
  const currentMatch = findCurrentMatch.value;
  if (currentMatch?.rowId === row.id && currentMatch.fieldId === field?.id) {
    classes.push("grid-cell-search-current");
  }
  return classes.join(" ");
}

function isGridFillHandleCell(rowIndex: number, columnIndex: number): boolean {
  const range = gridCellRange.value;
  if (!range || gridSelectionDragging.value) return false;
  const normalized = normalizedGridRange(range);
  return normalized.rowEnd === rowIndex && normalized.columnEnd === columnIndex;
}

function gridFillPreviewValue(rowIndex: number, columnIndex: number): string | null {
  const key = `${rowIndex}:${columnIndex}`;
  return gridFillPreviewValues.value.has(key)
    ? gridFillPreviewValues.value.get(key) ?? ""
    : null;
}

/** 属性选择器引号内仅需转义反斜杠与双引号；不依赖 jsdom 未实现的 CSS.escape。 */
function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function gridEditorRoot(position: GridCellPosition): HTMLElement | null {
  const root = ledgerTableCardRef.value;
  if (!root) return null;
  const rowId = tableRows.value[position.rowIndex]?.id;
  if (!rowId) return null;
  return root.querySelector<HTMLElement>(
    `[data-row-id="${cssAttrValue(rowId)}"][data-field-index="${position.columnIndex}"]`,
  );
}

function clearGridEditorTextSelection(editor: HTMLElement | null): void {
  if (!editor) return;
  editor.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((input) => {
    try {
      input.setSelectionRange(0, 0);
    } catch {
      // Date inputs do not expose a text selection range.
    }
  });
  window.getSelection()?.removeAllRanges();
}

async function focusGridCell(
  position: GridCellPosition,
  options: { scroll?: boolean } = {},
): Promise<void> {
  if (!tableRows.value.length || !fields.value.length) return;
  const nextPosition = clampGridCell(position);
  // clamp 恒返新对象；焦点格未变时跳过赋值，避免无谓的全表重绘。
  if (!sameGridCell(activeGridCell.value, nextPosition)) {
    activeGridCell.value = nextPosition;
  }
  suppressGridFocusReset = true;
  await nextTick();
  const editor = gridEditorRoot(nextPosition);
  const editing = isGridCellEditing(nextPosition);
  if (!editing) clearGridEditorTextSelection(editor);
  const focusTarget = editing
    ? editor?.querySelector<HTMLElement>(
        "input:not([type='date']), textarea, button, [tabindex]:not([tabindex='-1'])",
      )
    : editor;
  if (focusTarget) {
    focusTarget.focus({ preventScroll: true });
    if (options.scroll !== false) editor?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  window.setTimeout(() => {
    suppressGridFocusReset = false;
  }, 0);
}

function gridArrowDelta(key: string): { rowDelta: number; columnDelta: number } | null {
  if (key === "ArrowUp") return { rowDelta: -1, columnDelta: 0 };
  if (key === "ArrowDown") return { rowDelta: 1, columnDelta: 0 };
  if (key === "ArrowLeft") return { rowDelta: 0, columnDelta: -1 };
  if (key === "ArrowRight") return { rowDelta: 0, columnDelta: 1 };
  return null;
}

function selectOwnsArrowKey(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(".el-select")) return false;
  const dropdown = document.querySelector<HTMLElement>(".el-select-dropdown");
  return Boolean(dropdown && dropdown.getBoundingClientRect().height > 0);
}

function gridCellData(position: GridCellPosition): {
  record: LedgerRow;
  field: (typeof fields.value)[number];
} | null {
  const record = tableRows.value[position.rowIndex];
  const field = fields.value[position.columnIndex];
  return record && field ? { record, field } : null;
}

function spreadsheetColumnLabel(columnIndex: number): string {
  let value = columnIndex + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

const ledgerCellEditorPosition = computed(
  () => editingGridCell.value ?? activeGridCell.value,
);
const ledgerCellEditorCell = computed(() => {
  const position = ledgerCellEditorPosition.value;
  return position ? gridCellData(position) : null;
});
const ledgerCellEditorAddress = computed(() => {
  const position = ledgerCellEditorPosition.value;
  return position
    ? `${spreadsheetColumnLabel(position.columnIndex)}${position.rowIndex + 1}`
    : "—";
});
const ledgerCellEditorValue = computed(() => {
  const data = ledgerCellEditorCell.value;
  return data ? valueFor(data.record, data.field) : "";
});
const ledgerCellEditorDisabled = computed(
  () => !ledgerCellEditorCell.value || loading.value,
);
const ledgerCellEditorReadonly = computed(
  () => Boolean(ledgerCellEditorCell.value?.record.locked),
);
const ledgerCellEditorExpanded = ref(false);
const ledgerCellEditorTitle = computed(() => {
  const data = ledgerCellEditorCell.value;
  if (!data) return "尚未选择台账单元格";
  return `${ledgerCellEditorAddress.value} · ${data.field.label}${
    data.record.locked ? "（记录已锁定，只读）" : ""
  }`;
});

function toggleLedgerCellEditorExpanded(): void {
  ledgerCellEditorExpanded.value = !ledgerCellEditorExpanded.value;
}

async function finishGridCellEdit(commit = true, focusAfter = true): Promise<boolean> {
  const pendingFinish = gridCellEditFinishPromise;
  if (pendingFinish) {
    const saved = await pendingFinish;
    if (!saved) return false;
    if (gridCellEditFinishPromise && gridCellEditFinishPromise !== pendingFinish) {
      return finishGridCellEdit(commit, focusAfter);
    }
  }
  const editing = editingGridCell.value;
  const snapshot = editingGridSnapshot.value;
  const editSession = gridCellEditSession;
  if (!editing || !snapshot) return true;
  const finish = (async (): Promise<boolean> => {
    const record = tableRows.value.find((row) => row.id === snapshot.rowId);
    const field = fieldById.value.get(snapshot.fieldId);
    const data = record && field ? { record, field } : null;
    if (!data) {
      clearGridCellEdit();
      return true;
    }

    if (!commit) {
      setValue(data.record, data.field, snapshot.value, { markDirty: false });
      clearCellSaveState(persistedKey(data.record.id, data.field.id));
      clearFieldError(data.record, data.field);
    } else {
      const changedBeforeSave =
        !isDraft(data.record) &&
        valueFor(data.record, data.field) !==
          (persistedValues.get(persistedKey(data.record.id, data.field.id)) ?? "");
      const draftPathologySave =
        isDraft(data.record) && data.field.system_key === "pathology_number";
      const draftPathologyNeedsSave =
        draftPathologySave && valueFor(data.record, data.field).trim().length > 0;
      const saved = await saveField(data.record, data.field);
      if (
        fieldErrorFor(data.record, data.field) ||
        ((changedBeforeSave || draftPathologyNeedsSave) && !saved)
      ) return false;
    }

    if (!shouldApplyLedgerEditCompletion(
      snapshot,
      editingGridSnapshot.value,
      editSession,
      gridCellEditSession,
    )) return true;
    clearGridCellEdit();
    clearGridEditorTextSelection(gridEditorRoot(editing));
    if (focusAfter || sameGridCell(activeGridCell.value, editing)) {
      selectGridCell(editing);
      if (focusAfter) void focusGridCell(editing);
    }
    return true;
  })();
  gridCellEditFinishPromise = finish;
  try {
    return await finish;
  } finally {
    if (gridCellEditFinishPromise === finish) gridCellEditFinishPromise = null;
    scheduleLedgerRangeRefresh(activeProjectId.value);
  }
}

function enterGridCellEdit(
  position: GridCellPosition,
  replaceValue?: string,
  focusEditor = true,
): void {
  const nextPosition = clampGridCell(position);
  const data = gridCellData(nextPosition);
  if (!data || data.record.locked) return;
  if (isGridCellEditing(nextPosition)) {
    if (focusEditor) void focusGridCell(nextPosition);
    return;
  }
  if (editingGridCell.value) {
    void finishGridCellEdit(true, false).then((saved) => {
      if (saved && !editingGridCell.value) {
        enterGridCellEdit(nextPosition, replaceValue, focusEditor);
      }
    });
    return;
  }
  activeGridCell.value = nextPosition;
  // Keep the single-cell selection visible so its fill handle remains available
  // while the input is being edited, matching spreadsheet-style workflows.
  selectGridCell(nextPosition);
  gridCellEditSession += 1;
  editingGridCell.value = nextPosition;
  editingGridSnapshot.value = {
    rowId: data.record.id,
    fieldId: data.field.id,
    value: valueFor(data.record, data.field),
  };
  if (replaceValue !== undefined) setValue(data.record, data.field, replaceValue);
  if (focusEditor) void focusGridCell(nextPosition);
}

function beginLedgerCellEditorEdit(): void {
  const position = ledgerCellEditorPosition.value;
  const data = position ? gridCellData(position) : null;
  if (!position || !data || data.record.locked || loading.value) return;
  enterGridCellEdit(position, undefined, false);
}

function updateLedgerCellEditorValue(value: string): void {
  const position = ledgerCellEditorPosition.value;
  const data = position ? gridCellData(position) : null;
  if (!position || !data || data.record.locked || loading.value) return;
  if (!isGridCellEditing(position)) enterGridCellEdit(position, undefined, false);
  if (!isGridCellEditing(position)) return;
  setValue(data.record, data.field, value);
}

function handleLedgerCellEditorBlur(): void {
  if (editingGridCell.value) void finishGridCellEdit(true, false);
}

function handleLedgerCellEditorKeydown(event: KeyboardEvent): void {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === "u"
  ) {
    event.preventDefault();
    event.stopPropagation();
    toggleLedgerCellEditorExpanded();
    return;
  }
  if (event.isComposing || !editingGridCell.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    void finishGridCellEdit(false);
    return;
  }
  if (event.key === "Enter" && event.altKey) {
    event.stopPropagation();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    void finishGridCellEdit(true);
    return;
  }
  if (event.key === "Tab") {
    const editing = editingGridCell.value;
    const nextCell = moveGridCellByTab(editing, event.shiftKey);
    event.preventDefault();
    event.stopPropagation();
    void finishGridCellEdit(true, false).then((saved) => {
      if (!saved) return;
      selectGridCell(nextCell);
      void focusGridCell(nextCell);
    });
  }
}

function handleGridFocusOut(event: FocusEvent): void {
  const editing = editingGridCell.value;
  if (!editing) return;
  const relatedTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
  if (relatedTarget?.closest(".ledger-cell-editor-bar")) return;
  const relatedCell = gridCellFromElement(event.relatedTarget);
  if (sameGridCell(relatedCell, editing)) return;
  window.setTimeout(() => {
    if (!isGridCellEditing(editing)) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof Element && activeElement.closest(".ledger-cell-editor-bar")) return;
    if (sameGridCell(gridCellFromElement(activeElement), editing)) return;
    const dropdown = document.querySelector<HTMLElement>(".el-select-dropdown");
    if (dropdown?.contains(activeElement)) return;
    void finishGridCellEdit(true, false);
  }, 0);
}

function handleGridFocusIn(event: FocusEvent): void {
  const cell = gridCellFromElement(event.target);
  if (!cell) return;
  // focus() 同步派发 focusin，而 gridCellFromElement 恒返新对象；焦点格未变时
  // 跳过赋值，避免 gridCellClassName 对 activeGridCell 的依赖触发一次无谓的全表重绘。
  if (!sameGridCell(activeGridCell.value, cell)) activeGridCell.value = cell;
  if (!suppressGridFocusReset && !isGridCellEditing(cell)) {
    if (!isGridCellSelected(cell)) selectGridCell(cell);
    if (event.target === gridEditorRoot(cell)) void focusGridCell(cell);
  }
}

function gridTableBodyScrollElement(tableElement: HTMLElement): HTMLElement | null {
  // element-plus 的 el-vl 结构:body 是 overflow visible 的 wrapper,真正的原生
  // 滚动容器是其第一个子 div(无类名);拖拽自动滚动、滚轮与粘贴回位都必须
  // 读写它,读 wrapper 的 scrollTop 恒为 0,会让自动滚动第一帧就误判到底。
  const body = tableElement.querySelector<HTMLElement>(".el-table-v2__main .el-table-v2__body");
  if (!body) return null;
  for (const child of body.children) {
    if (child instanceof HTMLElement && child.scrollHeight > child.clientHeight) return child;
  }
  return body;
}

function recordSelectionRowFromElement(element: EventTarget | null): {
  row: LedgerRow;
  index: number;
} | null {
  if (!(element instanceof Element)) return null;
  const control = element.closest<HTMLElement>(
    ".ledger-v2-selection-control[data-row-id]",
  );
  const rowId = control?.dataset.rowId;
  if (!rowId) return null;
  const index = tableRowIndexById.value.get(rowId) ?? -1;
  const row = tableRows.value[index];
  return index >= 0 && row?.id === rowId ? { row, index } : null;
}

function recordSelectionIndexForScrollTop(
  state: RecordSelectionDragState,
  scrollTop: number,
): number | null {
  const body = gridTableBodyScrollElement(state.tableElement);
  const rect = body?.getBoundingClientRect();
  if (!rect || rect.height <= 0 || !tableRows.value.length) return null;
  const tableRect = state.tableElement.getBoundingClientRect();
  if (state.lastX < tableRect.left || state.lastX > tableRect.right) return null;
  const pointerY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, state.lastY));
  const index = Math.floor(
    (scrollTop + pointerY - rect.top) / ledgerVirtualRowHeight.value,
  );
  return Math.max(0, Math.min(tableRows.value.length - 1, index));
}

function recordSelectionIndexAtDragPoint(state: RecordSelectionDragState): number | null {
  const element = document.elementFromPoint?.(state.lastX, state.lastY) ?? null;
  const rowInfo = recordSelectionRowFromElement(element);
  if (rowInfo) return rowInfo.index;
  const body = gridTableBodyScrollElement(state.tableElement);
  return recordSelectionIndexForScrollTop(state, body?.scrollTop ?? 0);
}

function clearRecordSelectionDragFrame(): void {
  if (recordSelectionDragFrame !== null) {
    window.cancelAnimationFrame(recordSelectionDragFrame);
  }
  recordSelectionDragFrame = null;
  pendingRecordSelectionIndex = null;
}

function applyRecordSelectionDragIndex(index: number): void {
  const state = recordSelectionDragState;
  if (!state || index === state.lastAppliedIndex) return;
  const clampedIndex = Math.max(0, Math.min(tableRows.value.length - 1, index));
  state.focusIndex = clampedIndex;
  state.lastAppliedIndex = clampedIndex;
  recordSelectionDragPreview.value = {
    range: normalizeRecordSelectionRange(state.anchorIndex, clampedIndex),
    selected: state.selected,
    initialSelectedIds: state.initialSelectedIds,
  };
}

function flushRecordSelectionDragFrame(): void {
  if (recordSelectionDragFrame !== null) {
    window.cancelAnimationFrame(recordSelectionDragFrame);
  }
  recordSelectionDragFrame = null;
  const index = pendingRecordSelectionIndex;
  pendingRecordSelectionIndex = null;
  if (index !== null) applyRecordSelectionDragIndex(index);
}

function scheduleRecordSelectionDragIndex(index: number): void {
  pendingRecordSelectionIndex = index;
  if (recordSelectionDragFrame !== null) return;
  recordSelectionDragFrame = window.requestAnimationFrame(() => {
    recordSelectionDragFrame = null;
    const nextIndex = pendingRecordSelectionIndex;
    pendingRecordSelectionIndex = null;
    if (nextIndex !== null) applyRecordSelectionDragIndex(nextIndex);
  });
}

function clearRecordSelectionAutoScroll(): void {
  if (recordSelectionAutoScrollFrame !== null) {
    window.cancelAnimationFrame(recordSelectionAutoScrollFrame);
  }
  recordSelectionAutoScrollFrame = null;
  recordSelectionAutoScrollTimestamp = null;
}

function updateRecordSelectionAutoScroll(event: PointerEvent): void {
  const state = recordSelectionDragState;
  if (!state?.dragging) return;
  const body = gridTableBodyScrollElement(state.tableElement);
  const rect = body?.getBoundingClientRect() ?? state.tableElement.getBoundingClientRect();
  const tableRect = state.tableElement.getBoundingClientRect();
  const edgeSize = 42;
  const direction: GridAutoScrollDirection =
    event.clientX < tableRect.left || event.clientX > tableRect.right
      ? 0
      : event.clientY < rect.top + edgeSize
        ? -1
        : event.clientY > rect.bottom - edgeSize
          ? 1
          : 0;
  if (state.verticalScrollDirection === direction) return;
  state.verticalScrollDirection = direction;
  clearRecordSelectionAutoScroll();
  if (direction === 0) return;

  const scrollFrame = (timestamp: number): void => {
    recordSelectionAutoScrollFrame = null;
    const currentState = recordSelectionDragState;
    if (!currentState?.dragging || currentState.verticalScrollDirection === 0) {
      clearRecordSelectionAutoScroll();
      return;
    }
    const elapsed = recordSelectionAutoScrollTimestamp === null
      ? 1000 / 60
      : Math.min(50, timestamp - recordSelectionAutoScrollTimestamp);
    recordSelectionAutoScrollTimestamp = timestamp;
    const currentBody = gridTableBodyScrollElement(currentState.tableElement);
    const currentTop = currentBody?.scrollTop ?? 0;
    const maxTop = currentBody
      ? Math.max(0, currentBody.scrollHeight - currentBody.clientHeight)
      : 0;
    const nextTop = nextGridScrollOffset(
      currentTop,
      maxTop,
      currentState.verticalScrollDirection,
      480 * elapsed / 1000,
    );
    if (nextTop === currentTop) {
      currentState.verticalScrollDirection = 0;
      clearRecordSelectionAutoScroll();
      return;
    }
    if (tableRef.value) tableRef.value.scrollToTop(nextTop);
    else if (currentBody) currentBody.scrollTop = nextTop;
    const index = recordSelectionIndexForScrollTop(currentState, nextTop);
    if (index !== null) applyRecordSelectionDragIndex(index);
    recordSelectionAutoScrollFrame = window.requestAnimationFrame(scrollFrame);
  };
  recordSelectionAutoScrollFrame = window.requestAnimationFrame(scrollFrame);
}

function stopRecordSelectionDrag(resetClickSuppression = true): void {
  clearRecordSelectionAutoScroll();
  clearRecordSelectionDragFrame();
  document.removeEventListener("pointermove", handleRecordSelectionPointerMove);
  document.removeEventListener("pointerup", handleRecordSelectionPointerUp, true);
  document.removeEventListener("pointercancel", handleRecordSelectionPointerCancel, true);
  recordSelectionDragState = null;
  recordSelectionDragPreview.value = null;
  recordSelectionDragging.value = false;
  if (resetClickSuppression) {
    window.setTimeout(() => {
      suppressRecordSelectionClick = false;
    }, 0);
  }
}

function commitRecordSelectionDrag(): void {
  const state = recordSelectionDragState;
  if (!state?.dragging) return;
  flushRecordSelectionDragFrame();
  const next = applyRecordSelectionRange({
    records: tableRows.value,
    initialSelectedIds: state.initialSelectedIds,
    startIndex: state.anchorIndex,
    endIndex: state.focusIndex,
    selected: state.selected,
    isSelectable: recordRowSelectable,
  });
  commitRecordSelectionIds(next);
}

function handleRecordSelectionPointerDown(
  event: PointerEvent,
  row: LedgerRow,
  renderedRowIndex: number,
): void {
  if (event.button !== 0 || event.isPrimary === false) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(".el-checkbox") || !recordRowSelectable(row)) return;
  if (event.shiftKey) return;
  const tableElement = target.closest<HTMLElement>(".el-table-v2");
  if (!tableElement) return;
  const rowIndex = tableRowIndexById.value.get(row.id) ?? renderedRowIndex;
  if (rowIndex < 0) return;

  stopRecordSelectionDrag(false);
  suppressRecordSelectionClick = false;
  recordSelectionAnchorId = row.id;
  const initialSelectedIds = new Set(selectedRecordIds.value);
  recordSelectionDragState = {
    pointerId: event.pointerId,
    anchorIndex: rowIndex,
    focusIndex: rowIndex,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    dragging: false,
    selected: !initialSelectedIds.has(row.id),
    initialSelectedIds,
    tableElement,
    lastAppliedIndex: null,
    verticalScrollDirection: 0,
  };
  document.addEventListener("pointermove", handleRecordSelectionPointerMove, { passive: false });
  document.addEventListener("pointerup", handleRecordSelectionPointerUp, true);
  document.addEventListener("pointercancel", handleRecordSelectionPointerCancel, true);
}

function handleRecordSelectionPointerMove(event: PointerEvent): void {
  const state = recordSelectionDragState;
  if (!state || state.pointerId !== event.pointerId) return;
  if ((event.buttons & 1) !== 1) {
    commitRecordSelectionDrag();
    stopRecordSelectionDrag();
    return;
  }
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  if (!state.dragging) {
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
      < pointerDragThreshold) return;
    state.dragging = true;
    recordSelectionDragging.value = true;
    suppressRecordSelectionClick = true;
    applyRecordSelectionDragIndex(state.anchorIndex);
  }
  event.preventDefault();
  const index = recordSelectionIndexAtDragPoint(state);
  if (index !== null) scheduleRecordSelectionDragIndex(index);
  updateRecordSelectionAutoScroll(event);
}

function handleRecordSelectionPointerUp(event: PointerEvent): void {
  const state = recordSelectionDragState;
  if (!state || state.pointerId !== event.pointerId) return;
  if (state.dragging) {
    event.preventDefault();
    commitRecordSelectionDrag();
    stopRecordSelectionDrag();
    return;
  }
  stopRecordSelectionDrag(false);
}

function handleRecordSelectionPointerCancel(event: PointerEvent): void {
  if (!recordSelectionDragState || recordSelectionDragState.pointerId !== event.pointerId) return;
  stopRecordSelectionDrag();
}

function handleRecordSelectionClickCapture(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(".ledger-v2-selection-control[data-row-id] .el-checkbox")) return;
  if (suppressRecordSelectionClick) {
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressRecordSelectionClick = false;
    return;
  }
  if (!event.shiftKey || !recordSelectionAnchorId) return;
  const rowInfo = recordSelectionRowFromElement(target);
  const anchorIndex = tableRowIndexById.value.get(recordSelectionAnchorId) ?? -1;
  if (!rowInfo || anchorIndex < 0 || !recordRowSelectable(rowInfo.row)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const next = applyRecordSelectionRange({
    records: tableRows.value,
    initialSelectedIds: selectedRecordIds.value,
    startIndex: anchorIndex,
    endIndex: rowInfo.index,
    selected: !selectedRecordIds.value.has(rowInfo.row.id),
    isSelectable: recordRowSelectable,
  });
  commitRecordSelectionIds(next);
}

async function applyGridFill(
  source: NormalizedGridRange,
  target: NormalizedGridRange,
  mode: GridFillMode = "series",
): Promise<void> {
  const entries = buildGridFillEntries(
    source,
    target,
    fields.value,
    tableRows.value,
    valueFor,
    mode,
  );
  if (!entries.length) return;
  const changed = await pasteGrid(
    null,
    source.rowStart,
    source.columnStart,
    entries,
    undefined,
    "自动填充",
  );
  if (changed.length) {
    const selection = {
      anchor: { rowIndex: target.rowStart, columnIndex: target.columnStart },
      focus: { rowIndex: target.rowEnd, columnIndex: target.columnEnd },
    };
    replaceGridCellSelection(
      gridCellPositionsForRange(selection),
      selection.focus,
      selection.anchor,
      selection,
    );
  }
}

function rowHasDataOutsideRange(rowIndex: number, range: NormalizedGridRange): boolean {
  const row = tableRows.value[rowIndex];
  if (!row) return false;
  return fields.value.some((field, columnIndex) => {
    if (columnIndex >= range.columnStart && columnIndex <= range.columnEnd) return false;
    return valueFor(row, field).trim() !== "";
  });
}

function fillDownFromGridHandle(): void {
  const range = gridCellRange.value;
  if (!range) return;
  const source = normalizedGridRange(range);
  let lastRow = source.rowEnd;
  for (let rowIndex = source.rowEnd + 1; rowIndex < tableRows.value.length; rowIndex += 1) {
    if (!rowHasDataOutsideRange(rowIndex, source)) break;
    lastRow = rowIndex;
  }
  if (lastRow === source.rowEnd) {
    ElMessage.info("下方没有连续数据，无法自动填充");
    return;
  }
  const finishPromise = editingGridCell.value
    ? finishGridCellEdit(true, false)
    : Promise.resolve(true);
  void finishPromise.then((saved) => {
    if (saved) {
      return applyGridFill(source, {
        ...source,
        rowEnd: lastRow,
      });
    }
    return undefined;
  });
}

function handleGridClick(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest(".grid-fill-handle")) {
    suppressGridClick.value = false;
    return;
  }
  const cell = gridCellFromElement(event.target);
  if (!cell) return;
  if (suppressGridClick.value) {
    event.preventDefault();
    event.stopPropagation();
    suppressGridClick.value = false;
    return;
  }
  if (isGridCellEditing(cell)) {
    // Internal editing and cell selection are separate states. Keep the
    // single-cell selection (and its fill handle) while clicks move the text
    // caret inside the active editor.
    if (!isGridCellSelected(cell)) selectGridCell(cell);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    toggleGridCell(cell);
    return;
  }
  if (event.shiftKey) {
    const anchor = gridSelectionAnchor.value ?? activeGridCell.value ?? cell;
    const range = { anchor: clampGridCell(anchor), focus: clampGridCell(cell) };
    replaceGridCellSelection(
      gridCellPositionsForRange(range),
      cell,
      range.anchor,
      range,
    );
    return;
  }
  selectGridCell(cell);
}

function handleGridDoubleClick(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest(".grid-fill-handle")) {
    event.preventDefault();
    event.stopPropagation();
    fillDownFromGridHandle();
    return;
  }
  const cell = gridCellFromElement(event.target);
  if (!cell) return;
  if (isGridCellEditing(cell)) return;
  event.preventDefault();
  event.stopPropagation();
  enterGridCellEdit(cell);
}

function selectedRangeOrActive(cell: GridCellPosition): NormalizedGridRange {
  if (gridCellRange.value) return normalizedGridRange(gridCellRange.value);
  const positions = selectedGridCellPositions();
  if (!positions.length) {
    return {
      rowStart: cell.rowIndex,
      rowEnd: cell.rowIndex,
      columnStart: cell.columnIndex,
      columnEnd: cell.columnIndex,
    };
  }
  return {
    rowStart: Math.min(...positions.map((position) => position.rowIndex)),
    rowEnd: Math.max(...positions.map((position) => position.rowIndex)),
    columnStart: Math.min(...positions.map((position) => position.columnIndex)),
    columnEnd: Math.max(...positions.map((position) => position.columnIndex)),
  };
}

function runGridShortcutFill(
  cell: GridCellPosition,
  mode: "same" | "down" | "right" | "today",
): void {
  const range = selectedRangeOrActive(cell);
  const entries: GridPasteEntry[] = [];
  for (let rowIndex = range.rowStart; rowIndex <= range.rowEnd; rowIndex += 1) {
    for (let columnIndex = range.columnStart; columnIndex <= range.columnEnd; columnIndex += 1) {
      let value = "";
      if (mode === "today") {
        const field = fields.value[columnIndex];
        if (!field || (field.data_type !== "date" && field.system_key !== "experiment_date")) continue;
        value = shanghaiDateKey();
      } else if (mode === "down") {
        const source = gridCellData({ rowIndex: range.rowStart, columnIndex });
        if (!source || rowIndex === range.rowStart) continue;
        value = valueFor(source.record, source.field);
      } else if (mode === "right") {
        const source = gridCellData({ rowIndex, columnIndex: range.columnStart });
        if (!source || columnIndex === range.columnStart) continue;
        value = valueFor(source.record, source.field);
      } else {
        const source = gridCellData(cell);
        if (!source) continue;
        value = valueFor(source.record, source.field);
      }
      entries.push({
        rowOffset: rowIndex - range.rowStart,
        columnOffset: columnIndex - range.columnStart,
        value,
      });
    }
  }
  if (!entries.length) {
    ElMessage.info(mode === "today" ? "当前选区没有日期表头" : "当前选区没有可填充单元格");
    return;
  }
  void pasteGrid(null, range.rowStart, range.columnStart, entries, undefined, "快捷填充");
}

function handleGridKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  const undoModifier = event.ctrlKey || event.metaKey;
  if (
    undoModifier && !event.altKey && !event.shiftKey
    && (event.key.toLowerCase() === "c" || event.code === "KeyC")
  ) {
    if (nativeGridClipboardTarget(event.target)) return;
    const selection = gridClipboardSelection(gridCellFromElement(event.target) ?? activeGridCell.value);
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !copyGridSelectionWithNativeCommand(selection)) {
      void copyGridSelectionToClipboard(selection, false, "复制失败，请重新选中单元格后重试，并检查剪贴板权限");
    }
    return;
  }
  if (
    undoModifier && !event.altKey && !event.shiftKey
    && (event.key.toLowerCase() === "x" || event.code === "KeyX")
  ) {
    if (nativeGridClipboardTarget(event.target)) return;
    const selection = gridClipboardSelection(gridCellFromElement(event.target) ?? activeGridCell.value);
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void cutGridSelectionToClipboard(selection);
    return;
  }
  if (undoModifier && !event.altKey && ["z", "y"].includes(event.key.toLowerCase())) {
    const cell = gridCellFromElement(event.target);
    if (cell) {
      const row = tableRows.value[cell.rowIndex];
      const field = fields.value[cell.columnIndex];
      const editingUncommittedValue =
        row &&
        field &&
        (isDraft(row) ||
          valueFor(row, field) !== (persistedValues.get(persistedKey(row.id, field.id)) ?? ""));
      if (editingUncommittedValue) return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key.toLowerCase() === "z" && !event.shiftKey) void undoLedger();
    else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
      void redoLedger();
    }
    return;
  }
  const key = event.key.toLowerCase();
  const shortcutMode =
    (event.ctrlKey || event.metaKey) && !event.altKey
      ? event.key === "Enter"
        ? "same"
        : key === "d"
          ? "down"
          : key === "r"
            ? "right"
            : event.key === ";"
              ? "today"
              : null
      : null;
  // 虚拟滚动可能已把焦点单元格卸载出 DOM，keydown 的 target 落在渲染单元格之外；
  // 填充快捷键此时回退到状态层的活动单元格，与上方复制/剪切分支的处理保持一致。
  const cell = gridCellFromElement(event.target)
    ?? (shortcutMode && !nativeGridClipboardTarget(event.target) ? activeGridCell.value : null);
  if (!cell) return;
  activeGridCell.value = cell;

  if (shortcutMode) {
    event.preventDefault();
    event.stopPropagation();
    const run = () => runGridShortcutFill(cell, shortcutMode);
    if (isGridCellEditing(cell)) {
      void finishGridCellEdit(true, false).then((saved) => {
        if (saved) run();
      });
    } else {
      run();
    }
    return;
  }

  if (isGridCellEditing(cell)) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finishGridCellEdit(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !selectOwnsArrowKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      void finishGridCellEdit(true);
      return;
    }
    if (event.key === "Tab" && !selectOwnsArrowKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      const nextCell = moveGridCellByTab(cell, event.shiftKey);
      void finishGridCellEdit(true, false).then((saved) => {
        if (!saved) return;
        selectGridCell(nextCell);
        void focusGridCell(nextCell);
      });
      return;
    }
    // Once editing has started, arrow keys and other editing keys belong to
    // the native input/select control rather than grid navigation.
    return;
  }

  if (event.key === "F2") {
    const data = gridCellData(cell);
    if (!data || data.record.locked) return;
    event.preventDefault();
    event.stopPropagation();
    enterGridCellEdit(cell);
    return;
  }

  if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    const data = gridCellData(cell);
    if (!data || data.record.locked) return;
    event.preventDefault();
    event.stopPropagation();
    enterGridCellEdit(cell, event.key);
    return;
  }

  if (
    selectedGridCellKeys.value.size > 0 &&
    (event.key === "Delete" || event.key === "Backspace")
  ) {
    event.preventDefault();
    event.stopPropagation();
    void clearGridCellRange();
    return;
  }

  const delta = gridArrowDelta(event.key);
  if (!delta) return;
  if (selectedGridCellKeys.value.size !== 1) return;
  if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  const nextCell = moveGridCell(cell, delta.rowDelta, delta.columnDelta);
  selectGridCell(nextCell);
  void focusGridCell(nextCell);
}

function handleGridPaste(event: ClipboardEvent): void {
  const eventCell = gridCellFromElement(event.target);
  if (eventCell && isGridCellEditing(eventCell)) return;
  const destination = eventCell ?? activeGridCell.value;
  if (!destination) return;
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  const text = clipboard.getData("text/plain");
  const customPayload =
    parseLedgerGridClipboardPayload(clipboard.getData(LEDGER_GRID_CLIPBOARD_MIME)) ??
    lastGridClipboardPayload(text);
  if (!customPayload && !text) return;
  event.preventDefault();
  event.stopPropagation();
  let start = clampGridCell(destination);
  let exactCells = customPayload?.cells;
  let targetRange: GridCellRange | null = null;
  let targetPositions: GridCellPosition[] | null = null;
  const selectedRange = gridCellRange.value;
  if (selectedRange && selectedGridCellKeys.value.size > 1) {
    const positions = gridCellPositionsForRange(selectedRange);
    const isCompleteRectangle =
      positions.length === selectedGridCellKeys.value.size &&
      positions.every((position) => selectedGridCellKeys.value.has(gridCellKey(position)));
    const destinationSelected = selectedGridCellKeys.value.has(gridCellKey(start));
    const normalizedText = text.replace(/\r/g, "").replace(/\n$/, "");
    const plainSingleCell = !customPayload && !normalizedText.includes("\n") && !normalizedText.includes("\t")
      ? normalizedText
      : null;
    const sourceCells = exactCells ?? (plainSingleCell !== null
      ? [{ rowOffset: 0, columnOffset: 0, value: plainSingleCell }]
      : null);
    if (isCompleteRectangle && destinationSelected && sourceCells?.length === 1) {
      const normalizedRange = normalizedGridRange(selectedRange);
      start = {
        rowIndex: normalizedRange.rowStart,
        columnIndex: normalizedRange.columnStart,
      };
      targetRange = selectedRange;
      targetPositions = positions;
      exactCells = expandLedgerSingleCellPaste(
        sourceCells,
        normalizedRange.rowEnd - normalizedRange.rowStart + 1,
        normalizedRange.columnEnd - normalizedRange.columnStart + 1,
      );
    }
  }
  void pasteGrid(
    event,
    start.rowIndex,
    start.columnIndex,
    exactCells,
  ).then((positions) => {
    const selection = targetPositions ?? (positions.length ? positions : [start]);
    replaceGridCellSelection(selection, start, start, targetRange);
    void focusGridCell(start);
  });
}

function contextRowCopySelection(row: LedgerRow): {
  positions: GridCellPosition[];
  active: GridCellPosition;
} | null {
  const rowIndex = tableRowIndexById.value.get(row.id) ?? -1;
  if (rowIndex < 0 || !fields.value.length) return null;
  const positions = fields.value.map((_, columnIndex) => ({ rowIndex, columnIndex }));
  return { positions, active: positions[0]! };
}

function positionLedgerContextMenu(event: MouseEvent): void {
  const width = 160;
  const submenuWidth = 200;
  const height = 210;
  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
  ledgerContextMenu.value = {
    x,
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    submenuLeft: x + width + submenuWidth > window.innerWidth - 8,
    target: ledgerContextMenu.value!.target,
  };
}

function handleLedgerContextMenu(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".ledger-column-tools-popover, .ledger-column-tools-trigger")) return;
  const cell = gridCellFromElement(event.target);
  if (cell && isGridCellEditing(cell)) return;
  const rowId = target?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
  const row = cell
    ? tableRows.value[cell.rowIndex]
    : tableRows.value.find((item) => item.id === rowId);
  if (!row || isDraft(row)) return;

  event.preventDefault();
  event.stopPropagation();
  closeColumnTools();
  if (cell && !isGridCellSelected(cell)) selectGridCell(cell);
  ledgerContextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    submenuLeft: false,
    target: {
      kind: cell ? "cell" : "row",
      rowId: row.id,
      fieldId: cell ? fields.value[cell.columnIndex]?.id : undefined,
    },
  };
  positionLedgerContextMenu(event);
  contextInsertRowCount.value = Math.min(100, contextSuggestedInsertRowCount.value);
}

function finishContextMenuAction(): void {
  closeLedgerContextMenu();
}

async function contextCopy(): Promise<void> {
  const row = contextMenuRow.value;
  const cell = contextMenuCell.value;
  const selection =
    ledgerContextMenu.value?.target.kind === "row" && row
      ? (hasGridCellSelection.value ? gridClipboardSelection(null) : contextRowCopySelection(row))
      : cell
        ? gridClipboardSelection(cell)
        : null;
  finishContextMenuAction();
  if (!selection) {
    ElMessage.warning("复制范围已变化，请重新选择要复制的单元格");
    return;
  }
  const copying = copyGridSelectionToClipboard(selection);
  void focusGridCell(selection.active);
  await copying;
}

async function contextCut(): Promise<void> {
  const cell = contextMenuCell.value;
  if (!cell) {
    ElMessage.warning("请先选择要剪切的单元格");
    finishContextMenuAction();
    return;
  }
  const selection = gridClipboardSelection(cell);
  finishContextMenuAction();
  if (selection) await cutGridSelectionToClipboard(selection);
}

async function contextDelete(): Promise<void> {
  if (!contextMenuCell.value) {
    ElMessage.warning("请先选择单元格");
    finishContextMenuAction();
    return;
  }
  await clearGridCellRange("删除");
  finishContextMenuAction();
}

async function contextDeleteRecord(): Promise<void> {
  const row = contextMenuRow.value;
  const deleteSelection = Boolean(row && selectedRecordIds.value.has(row.id));
  finishContextMenuAction();
  if (!row || isDraft(row)) return;
  let targets: ProjectRecord[];
  try {
    targets = deleteSelection ? await selectedTargetRecords() : [row];
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "读取待删除记录失败");
    return;
  }
  await deleteLedgerRecords(targets);
}

function insertDraftRowsAt(
  anchorId: string,
  placement: LedgerDraftPlacement,
  count: number,
): boolean {
  if (!currentProject.value || loading.value) return false;
  const groupId = nextInsertGroupId();
  const inserted = Array.from({ length: count }, (_, order) =>
    makeDraftRow({ anchorId, placement, groupId, order }),
  );
  draftRows.value.push(...inserted);

  void nextTick(() => {
    const rowIndex = tableRowIndexById.value.get(inserted[0]?.id ?? "") ?? -1;
    const columnIndex = fields.value.findIndex(
      (field) => field.system_key === "pathology_number",
    );
    if (rowIndex >= 0 && columnIndex >= 0) {
      const position = { rowIndex, columnIndex };
      selectGridCell(position);
      void focusGridCell(position);
    }
  });
  return true;
}

function notifyInsertedRows(count: number): void {
  ElMessage.success(`已插入 ${count} 行，可按任意顺序填写；病理号填写后该行自动保存`);
  if (ledgerSort.value || Object.values(ledgerFilters.value).some(Boolean)) {
    ElMessage.info("当前台账有排序或筛选；记录保存后会继续按当前布局规则显示");
  }
}

function contextInsertRows(placement: LedgerDraftPlacement): void {
  const row = contextMenuRow.value;
  if (!row || isDraft(row)) return finishContextMenuAction();
  const count = Number(contextInsertRowCount.value);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    ElMessage.warning("请输入 1 到 100 之间的整数行数");
    return;
  }
  const anchorId = row.id;
  finishContextMenuAction();
  if (insertDraftRowsAt(anchorId, placement, count)) notifyInsertedRows(count);
}

async function clearGridCellRange(
  operationLabel = "清空",
  options: { positions?: GridCellPosition[]; preserveSelection?: boolean } = {},
): Promise<void> {
  const projectId = activeProjectId.value;
  const projectGeneration = projectViewGeneration;
  const selectionBefore = selectedGridCellKeys.value;
  const positions = options.positions ?? selectedGridCellPositions();
  if (!positions.length) return;
  let skippedLocked = 0;
  let skippedRequired = 0;
  const eligible: GridCellPosition[] = [];
  for (const { rowIndex, columnIndex } of positions) {
    const record = tableRows.value[rowIndex];
    const field = fields.value[columnIndex];
    if (!record || !field) continue;
    if (record.locked) {
      skippedLocked += 1;
      continue;
    }
    if (field.system_key === "pathology_number" || field.system_key === "status") {
      skippedRequired += 1;
      continue;
    }
    if (!valueFor(record, field)) continue;
    eligible.push({ rowIndex, columnIndex });
  }
  if (eligible.length) {
    const rowStart = Math.min(...eligible.map((position) => position.rowIndex));
    const columnStart = Math.min(...eligible.map((position) => position.columnIndex));
    await pasteGrid(
      null,
      rowStart,
      columnStart,
      eligible.map((position) => ({
        rowOffset: position.rowIndex - rowStart,
        columnOffset: position.columnIndex - columnStart,
        value: "",
      })),
      undefined,
      operationLabel,
    );
  }
  if (ledgerDisposed || projectId !== activeProjectId.value || projectGeneration !== projectViewGeneration) return;
  if (skippedLocked) ElMessage.info(`已跳过 ${skippedLocked} 个锁定单元格`);
  if (skippedRequired) ElMessage.info(`已保留 ${skippedRequired} 个病理号或状态单元格`);
  if (options.preserveSelection || selectedGridCellKeys.value !== selectionBefore) return;
  const currentActive = activeGridCell.value;
  const active =
    currentActive && positions.some((position) => sameGridCell(position, currentActive))
      ? clampGridCell(currentActive)
      : positions[0];
  if (!active) return;
  selectedGridCellKeys.value = new Set(positions.map(gridCellKey).filter(Boolean));
  activeGridCell.value = active;
  gridCellRange.value = positions.length === 1
    ? { anchor: { ...active }, focus: { ...active } }
    : null;
  void focusGridCell(active);
}

function clearBottomScrollTimers(): void {
  bottomScrollTimers.forEach((timer) => window.clearTimeout(timer));
  bottomScrollTimers = [];
}

function scrollTableToBottomLeft(): void {
  const lastRowIndex = tableRows.value.length - 1;
  if (lastRowIndex < 0) return;
  tableRef.value?.scrollToRow(lastRowIndex, "end");
  tableRef.value?.scrollToLeft(0);
  if (ledgerHorizontalScrollbarRef.value) {
    ledgerHorizontalScrollbarRef.value.scrollLeft = 0;
  }
}

function scrollTableToBottom(): void {
  clearBottomScrollTimers();
  const applyScroll = () => scrollTableToBottomLeft();
  void nextTick(() => {
    applyScroll();
    bottomScrollTimers.push(window.setTimeout(applyScroll, 40));
    bottomScrollTimers.push(window.setTimeout(applyScroll, 140));
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function scrollTableToBottomOnce(
  shouldApply: () => boolean = () => true,
): Promise<boolean> {
  clearBottomScrollTimers();
  await nextTick();
  await nextAnimationFrame();
  if (!shouldApply()) return false;
  const lastRowIndex = tableRows.value.length - 1;
  if (lastRowIndex >= 0) scrollTableToBottomLeft();
  await nextAnimationFrame();
  if (!shouldApply()) return false;
  if (lastRowIndex >= 0) scrollTableToBottomLeft();
  return true;
}

function autosizeTextareaKey(rowId: string, fieldId: string): string {
  return `${rowId}:${fieldId}`;
}

function setAutosizeTextareaRef(instance: unknown, rowId: string, fieldId: string): void {
  const key = autosizeTextareaKey(rowId, fieldId);
  const candidate = instance as Partial<AutosizeTextareaInstance> | null;
  if (candidate && typeof candidate.resizeTextarea === "function") {
    autosizeTextareaRefs.set(key, candidate as AutosizeTextareaInstance);
  } else {
    autosizeTextareaRefs.delete(key);
  }
}

async function remeasureVisibleTextareas(
  fieldId?: string,
  shouldApply: () => boolean = () => true,
): Promise<void> {
  await nextTick();
  if (!shouldApply()) return;
  autosizeTextareaRefs.forEach((instance, key) => {
    if (!fieldId || key.endsWith(`:${fieldId}`)) instance.resizeTextarea();
  });
  await nextTick();
  if (!shouldApply()) return;
}

async function refreshTableLayout(
  shouldApply: () => boolean = () => true,
): Promise<void> {
  await remeasureVisibleTextareas(undefined, shouldApply);
}

function fieldOptions(field: FieldDefinition): string[] {
  return field.options
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((option) => option.value);
}

function flashGridRecord(recordId: string): void {
  focusRecordId.value = recordId;
  window.setTimeout(() => {
    if (focusRecordId.value === recordId) focusRecordId.value = "";
  }, 2200);
}

async function scrollToFocusedRecord(
  shouldApply: () => boolean = () => true,
): Promise<boolean> {
  if (!focusRecordId.value) return false;
  const targetRecordId = focusRecordId.value;
  await nextTick();
  if (!shouldApply() || focusRecordId.value !== targetRecordId) return false;
  const rowIndex = tableRowIndexById.value.get(targetRecordId) ?? -1;
  if (rowIndex >= 0) tableRef.value?.scrollToRow(rowIndex, "center");
  window.setTimeout(() => {
    if (focusRecordId.value === targetRecordId) focusRecordId.value = "";
  }, 2200);
  return rowIndex >= 0;
}

function replaceRecord(updated: ProjectRecord): void {
  invalidateProjectRecordCache(updated.project_id);
  const index = records.value.findIndex((record) => record.id === updated.id);
  if (index >= 0) records.value.splice(index, 1, updated);
  const selectedIndex = selectedRecords.value.findIndex((record) => record.id === updated.id);
  if (selectedIndex >= 0) selectedRecords.value.splice(selectedIndex, 1, updated);
  rememberRecord(updated);
  if (selectedRecordIds.value.has(updated.id)) selectedRecordCache.set(updated.id, updated);
  scheduleLedgerRangeRefresh(updated.project_id);
}

function ledgerCloseState(): { dirty: boolean; busy: boolean } {
  return {
    dirty: Boolean(dirtyLedgerChanges().length || dirtyLedgerDrafts().length),
    busy: Boolean(closeSaving.value || savingIds.value.size || hasCellSaveInFlight() ||
      gridCellEditFinishPromise || gridCutInProgress.value || historyReplayLoading.value ||
      validationCommitLoading.value || findReplaceLoading.value || reorderLoading.value ||
      highlightLoading.value || loading.value || ledgerRangeSaving.value || quickEntryRefreshInProgress.value || projectLoadPromise),
  };
}

async function saveLedgerBeforeClose(): Promise<boolean> {
  const projectId = activeProjectId.value;
  const changes = dirtyLedgerChanges();
  const drafts = dirtyLedgerDrafts().map((record) => ({
    record,
    snapshot: snapshotRecord(record),
  }));
  if (!changes.length && !drafts.length) return true;
  closeSaving.value = true;
  try {
    if (drafts.some(({ record }) => !record.pathology_number.trim())) {
      ElMessage.warning("新增记录仍有未填写的病理号，请补全后再保存关闭");
      return false;
    }
    const newRecords: RecordBatchNewRecord[] = drafts.map(({ record }) => ({
      client_id: record.id,
      pathology_number: record.pathology_number.trim(),
      block_number: record.block_number?.trim() || null,
      status: record.status,
      experiment_date: record.experiment_date ? normalizeDateInput(record.experiment_date) : null,
      experiment_number: record.experiment_number?.trim() || null,
      values: { ...record.values },
      ...(record._insertAnchorId && record._insertPlacement === "before" ? { insert_before_record_id: record._insertAnchorId } : {}),
      ...(record._insertAnchorId && record._insertPlacement === "after" ? { insert_after_record_id: record._insertAnchorId } : {}),
    }));
    const preview = await previewCellBatch(projectId, changes, newRecords);
    const errors = preview.issues.filter((issue) => issue.severity === "error");
    if (preview.skipped_locked || errors.length) {
      ElMessage.error(errors[0]?.message ?? "修改中有锁定记录，未保存内容已保留");
      return false;
    }
    const warnings = preview.issues.filter((issue) => issue.severity === "warning");
    if (warnings.length) {
      try {
        await ElMessageBox.confirm([...new Set(warnings.map((issue) => issue.message))].join("；"), "保存前确认", {
          confirmButtonText: "继续保存", cancelButtonText: "返回修改", type: "warning", closeOnClickModal: false,
        });
      } catch {
        return false;
      }
    }
    const result = await commitCellBatch(preview.token, warnings.length > 0, drafts.length > 0);
    const completed = new Set(changes.map((change) => persistedKey(change.record_id, change.field_id)));
    result.records.filter((record) => !result.created_record_ids.includes(record.id))
      .forEach((record) => replaceRecordPreservingPending(record, completed));
    completed.forEach((key) => {
      const [recordId = "", fieldId = ""] = key.split(":");
      clearCellSaveState(key);
      const record = records.value.find((item) => item.id === recordId);
      const field = fields.value.find((item) => item.id === fieldId);
      if (record && field) clearFieldError(record, field);
    });
    if (drafts.length) {
      reconcileCommittedPaste(drafts, result.created_record_ids, result.records);
      pushHistory("关闭前保存台账", result.before, result.after, projectId);
    } else {
      pushCellHistory("关闭前保存台账", result.changes, projectId);
    }
    dismissValidationPanel();
    clearGridCellEdit();
    return !ledgerCloseState().dirty;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存失败，未保存内容已保留");
    return false;
  } finally {
    closeSaving.value = false;
  }
}

const removeCloseGuard = registerWindowCloseGuard({
  state: ledgerCloseState,
  save: saveLedgerBeforeClose,
  prepare: () => { preparingClose.value = true; },
  release: () => { preparingClose.value = false; },
});

function handleTableSelectionChange(rows: ProjectRecord[]): void {
  const visibleIds = new Set(records.value.map((record) => record.id));
  // Off-page rows are accepted only while explicitly retained in our selection.
  // A stale reserve-selection event must not resurrect a deleted/reset record.
  rows = rows.filter((record) => visibleIds.has(record.id) || selectedRecordIds.value.has(record.id));
  const rowIds = new Set(rows.map((record) => record.id));
  selectedRecords.value = rows;
  const next = new Set(selectedRecordIds.value);
  visibleIds.forEach((recordId) => next.delete(recordId));
  visibleIds.forEach((recordId) => {
    if (!rowIds.has(recordId)) selectedRecordCache.delete(recordId);
  });
  rows.forEach((record) => {
    next.add(record.id);
    selectedRecordCache.set(record.id, record);
  });
  selectedRecordIds.value = next;
  if (rows.length) {
    activeGridCell.value = null;
    clearGridCellSelection();
  }
}

function pushHistory(
  label: string,
  before: ProjectRecord[],
  after: ProjectRecord[],
  projectId = activeProjectId.value,
): void {
  if (!projectId || (!before.length && !after.length)) return;
  ledgerHistory.push(createLedgerHistoryEntry(projectId, label, before, after));
}

function reconcileOperationResult(result: {
  records: ProjectRecord[];
  deleted_ids: string[];
}): void {
  invalidateProjectRecordCache(activeProjectId.value);
  result.records.forEach((record) => invalidateProjectRecordCache(record.project_id));
  const deletedIds = new Set(result.deleted_ids);
  records.value = records.value.filter((record) => !deletedIds.has(record.id));
  result.records.forEach((record) => {
    const index = records.value.findIndex((current) => current.id === record.id);
    if (index >= 0) records.value.splice(index, 1, record);
    else records.value.push(record);
  });
  records.value.sort((left, right) => {
    return left.position - right.position || left.id.localeCompare(right.id);
  });
  clearRecordSelection();
  activeGridCell.value = null;
  clearGridCellSelection();
  rememberAll();
}

async function replayHistoryEntry(
  entry: LedgerHistoryEntry,
  direction: "undo" | "redo",
): Promise<void> {
  historyReplayLoading.value = true;
  try {
    await ensureProjectLoaded(entry.projectId);
    if (entry.kind === "cells") {
      const preview = await previewCellBatch(
        entry.projectId,
        entry.changes.map((change) => ({
          record_id: change.recordId,
          field_id: change.fieldId,
          value: direction === "undo" ? change.before : change.after,
          expected_value: direction === "undo" ? change.after : change.before,
        })),
      );
      const error = preview.issues.find((issue) => issue.severity === "error");
      if (error) throw new Error(error.message);
      if (preview.skipped_locked) throw new Error("撤销或恢复范围中包含锁定记录，请先解锁");
      const result = await commitCellBatch(preview.token, true);
      result.records.forEach(replaceRecord);
      await loadRecords(entry.projectId, { showLoading: false, preserveHistory: true });
      return;
    }
    const result = await applyRecordOperation({
      operation_id: entry.operationId,
      project_id: entry.projectId,
      direction,
      before: entry.before,
      after: entry.after,
    });
    reconcileOperationResult(result);
    await loadRecords(entry.projectId, { showLoading: false, preserveHistory: true });
  } catch (error) {
    try {
      await loadRecords(entry.projectId, { showLoading: false, preserveHistory: true });
    } catch {
      // Preserve the original replay error. A failed refresh must not erase
      // the history entry or hide the reason why undo/redo was rejected.
    }
    throw error;
  } finally {
    historyReplayLoading.value = false;
  }
}

function reconcileCommittedPaste(
  entries: Array<{ record: LedgerRow; snapshot: ProjectRecord }>,
  committedIds: string[],
  serverRecords: ProjectRecord[] = [],
): ProjectRecord[] | null {
  if (entries.length !== committedIds.length) return null;
  const activeIdentity = captureGridIdentity(activeGridCell.value);
  const anchorIdentity = captureGridIdentity(gridSelectionAnchor.value);
  const committedDraftIds = new Map<string, string>();
  const committedRecords: ProjectRecord[] = [];
  entries.forEach(({ record, snapshot }, index) => {
    const committedId = committedIds[index];
    if (!committedId) return;
    if (isDraft(record)) {
      const draftId = record.id;
      const serverRecord = serverRecords.find((item) => item.id === committedId);
      const persistedRecord = cloneLedgerRecord(serverRecord ?? { ...snapshot, id: committedId });
      const pendingFields = fields.value.flatMap((field) => {
        const value = valueFor(record, field);
        return value !== valueFor(snapshot, field) ? [{ field, value }] : [];
      });
      // Keep the server values as the save baseline, then carry later edits to
      // the new UUID. Reuse the row object so pending editor events use it too.
      rememberRecord(persistedRecord);
      reanchorPendingInsertedDrafts(record, persistedRecord);
      Object.assign(record, persistedRecord);
      delete record._draft;
      pendingFields.forEach(({ field, value }) => setValue(record, field, value));
      records.value.push(record);
      committedRecords.push(record);
      committedDraftIds.set(draftId, committedId);
      return;
    }
    rememberRecord(record);
    committedRecords.push(record);
  });
  if (committedDraftIds.size) {
    const persistedIds = new Set(committedDraftIds.values());
    draftRows.value = draftRows.value.filter((row) => !persistedIds.has(row.id));
    cleanupInsertedGroupRegistry();
    recordTotal.value += committedDraftIds.size;
    const remapIdentity = (identity: { rowId: string; fieldId: string } | null) => identity && ({
      ...identity, rowId: committedDraftIds.get(identity.rowId) ?? identity.rowId,
    });
    activeGridCell.value = restoreGridIdentity(remapIdentity(activeIdentity));
    gridSelectionAnchor.value = restoreGridIdentity(remapIdentity(anchorIdentity));
    selectedGridCellKeys.value = new Set([...selectedGridCellKeys.value].map((key) => {
      const [rowId = "", fieldId = ""] = key.split(GRID_CELL_KEY_SEPARATOR);
      return `${committedDraftIds.get(rowId) ?? rowId}${GRID_CELL_KEY_SEPARATOR}${fieldId}`;
    }));
    if (editingGridSnapshot.value && committedDraftIds.has(editingGridSnapshot.value.rowId)) {
      editingGridSnapshot.value = {
        ...editingGridSnapshot.value,
        rowId: committedDraftIds.get(editingGridSnapshot.value.rowId)!,
      };
      editingGridCell.value = restoreGridIdentity(editingGridSnapshot.value);
      if (!editingGridCell.value) clearGridCellEdit();
    }
  }
  return committedRecords;
}


async function loadLedgerDisplaySettings(): Promise<void> {
  try {
    const result = await getSetting<Partial<LedgerDisplaySettings>>(LEDGER_DISPLAY_SETTINGS_KEY);
    ledgerDisplaySettings.value = normalizeLedgerDisplaySettings(result.value);
    refreshTableLayout();
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "台账显示设置读取失败");
  }
}

async function loadPreviewEngineSetting(): Promise<void> {
  try {
    const result = await getSetting<PrintEngine>("report_print_engine");
    if (result.value && ["auto", "word", "wps"].includes(result.value)) {
      previewEngine.value = result.value;
    }
  } catch {
    // Preview remains usable with automatic engine selection when no setting exists.
  }
}

async function loadPreviewCapabilities(): Promise<void> {
  previewCapabilities.value = await fetchPreviewCapabilities();
}

function nativeEngineAvailable(engine: PrintEngine): boolean {
  return isNativeEngineAvailable(previewCapabilities.value, engine, "spreadsheet");
}

function nativeEngineLabel(): string {
  return nativeEngineLabelFor(previewEngine.value, "Excel", "Excel/WPS");
}

function monitorNativeLedgerJob(task: NativePreviewTask): Promise<void> {
  return monitorNativePreviewJob(task, {
    isDisposed: () => ledgerDisposed,
    engineLabel: nativeEngineLabel,
    failedMessage: "Excel/WPS 原生窗口打开失败",
  });
}

async function openLedgerNative(): Promise<void> {
  if (!currentProject.value) return;
  if (!nativeEngineAvailable(previewEngine.value)) {
    ElMessage.warning("当前电脑未检测到可用的 Excel/WPS 表格程序");
    return;
  }
  const scope = previewScope.value;
  const cells = scope === "selection" ? selectedPreviewCells() : [];
  if (scope === "selection" && !cells.length) {
    ElMessage.warning("请先选择要打开的单元格");
    return;
  }
  nativePreviewLoading.value = true;
  try {
    const task = await createLedgerNativePreview(currentProject.value.id, {
      action: "open",
      scope,
      include_locked: showLockedRecords.value,
      cells,
      print_engine: previewEngine.value,
    });
    void monitorNativeLedgerJob(task).catch((error) => {
      ElMessage.error(error instanceof Error ? error.message : "Excel/WPS 原生窗口状态读取失败");
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "无法打开 Excel/WPS 原生窗口");
  } finally {
    nativePreviewLoading.value = false;
  }
}

async function savePreviewEngineSetting(): Promise<void> {
  try {
    await putSetting("report_print_engine", previewEngine.value);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "打印引擎设置保存失败");
  }
}

async function persistZoomSetting(): Promise<void> {
  ledgerDisplaySettings.value = normalizeLedgerDisplaySettings(ledgerDisplaySettings.value);
  refreshTableLayout();
  try {
    const result = await putSetting(LEDGER_DISPLAY_SETTINGS_KEY, ledgerDisplaySettings.value);
    ledgerDisplaySettings.value = normalizeLedgerDisplaySettings(result.value);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "台账缩放设置保存失败");
  }
}

function zoomOut(): void {
  ledgerDisplaySettings.value.zoomPercent = Math.max(
    LEDGER_ZOOM_MIN,
    ledgerDisplaySettings.value.zoomPercent - LEDGER_ZOOM_STEP,
  );
  void persistZoomSetting();
}

function zoomIn(): void {
  ledgerDisplaySettings.value.zoomPercent = Math.min(
    LEDGER_ZOOM_MAX,
    ledgerDisplaySettings.value.zoomPercent + LEDGER_ZOOM_STEP,
  );
  void persistZoomSetting();
}

function resetZoom(): void {
  ledgerDisplaySettings.value.zoomPercent = 100;
  void persistZoomSetting();
}

async function undoLedger(): Promise<void> {
  try {
    const applied = await ledgerHistory.undo((entry) => replayHistoryEntry(entry, "undo"));
    if (applied) ElMessage.success("已撤销上一步台账操作");
  } catch (error) {
    await handleHistoryReplayError("undo", error);
  }
}

async function redoLedger(): Promise<void> {
  try {
    const applied = await ledgerHistory.redo((entry) => replayHistoryEntry(entry, "redo"));
    if (applied) ElMessage.success("已恢复下一步台账操作");
  } catch (error) {
    await handleHistoryReplayError("redo", error);
  }
}

function isHistoryConflict(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 409) return true;
  if (!(error instanceof Error)) return false;
  return error.message.includes("内容已变化") || error.message.includes("数据已发生变化");
}

async function handleHistoryReplayError(
  direction: "undo" | "redo",
  error: unknown,
): Promise<void> {
  const fallback = direction === "undo" ? "台账撤销失败" : "台账恢复失败";
  const message = error instanceof Error ? error.message : fallback;
  if (!isHistoryConflict(error)) {
    ElMessage.error(message);
    return;
  }

  const entry = ledgerHistory.peek(direction);
  if (!entry) {
    ElMessage.error(message);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `“${entry.label}”之后的数据已被修改，不能安全${direction === "undo" ? "撤销" : "恢复"}。是否跳过这条失效历史，继续处理更早的操作？`,
      `${direction === "undo" ? "撤销" : "恢复"}步骤已失效`,
      {
        confirmButtonText: "跳过此步骤",
        cancelButtonText: "保留，稍后处理",
        type: "warning",
      },
    );
    const discarded = ledgerHistory.discard(direction);
    if (discarded) ElMessage.info(`已跳过失效历史：“${discarded.label}”`);
  } catch (action) {
    if (action === "cancel" || action === "close") {
      ElMessage.warning(`${message}；该步骤已保留`);
      return;
    }
    ElMessage.error(message);
  }
}

async function ensureProjectLoaded(projectId: string): Promise<void> {
  if (activeProjectId.value !== projectId) {
    activeProjectId.value = projectId;
    await nextTick();
  }
  if (projectLoadPromise) await projectLoadPromise;
}

async function handleLockedVisibilityChange(): Promise<void> {
  focusRecordId.value = "";
  clearSelectionsAfterLedgerViewChange();
  await loadRecords(activeProjectId.value, { preserveHistory: true, stabilizeTable: true });
}

async function loadLedgerRangeSettings(): Promise<void> {
  try {
    const result = await getSetting<unknown>(LEDGER_RANGE_SETTINGS_KEY);
    persistedLedgerRange = result.value;
    ledgerRangeSettings.value = normalizeLedgerRangeSettings(result.value);
    ledgerRangeDraft.value = { ...ledgerRangeSettings.value };
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "记录显示范围读取失败");
  }
}

async function saveLedgerRangeSettings(): Promise<void> {
  if (ledgerRangeSaving.value) return;
  ledgerRangeSaving.value = true;
  cancelLedgerRangeRefresh();
  try {
    if (!await finishGridCellEdit(true, false)) return;
    if (dirtyLedgerChanges().length || savingIds.value.size || hasCellSaveInFlight() || loading.value) {
      ElMessage.warning("请先完成当前记录的修改，再切换显示范围");
      return;
    }
    const nextSettings = normalizeLedgerRangeSettings(ledgerRangeDraft.value);
    await putSetting(LEDGER_RANGE_SETTINGS_KEY, nextSettings, { expectedValue: persistedLedgerRange });
    persistedLedgerRange = nextSettings;
    ledgerRangeSettings.value = nextSettings;
    ledgerRangeDraft.value = { ...nextSettings };
    pendingLedgerRangeApplication.value = true;
    ledgerRecordCache.clear();
    if (editingGridCell.value || dirtyLedgerChanges().length || savingIds.value.size || loading.value) {
      ElMessage.success("显示范围已保存，完成当前编辑后应用");
      return;
    }
    moreActionsVisible.value = false;
    if (await loadRecords(activeProjectId.value, {
      preserveHistory: true, stabilizeTable: true, deferForPendingEdits: true,
    })) {
      ElMessage.success(`已设置${ledgerRangeLabel(nextSettings)}`);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录显示范围保存失败");
    if (error instanceof ApiError && error.status === 409) await loadLedgerRangeSettings();
  } finally {
    ledgerRangeSaving.value = false;
    if (pendingLedgerRangeApplication.value) scheduleLedgerRangeRefresh(activeProjectId.value);
  }
}

function openReorderDialog(): void {
  reorderDate.value = shanghaiDateKey(new Date());
  reorderPreview.value = null;
  reorderDialogVisible.value = true;
}

async function loadReorderPreview(): Promise<void> {
  if (!reorderDate.value) {
    ElMessage.warning("请选择需要重排的实验日期");
    return;
  }
  reorderLoading.value = true;
  try {
    reorderPreview.value = await previewReorderByDate(activeProjectId.value, reorderDate.value);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "重排预览失败");
  } finally {
    reorderLoading.value = false;
  }
}

async function confirmReorderByDate(): Promise<void> {
  const preview = reorderPreview.value;
  if (!preview) return;
  reorderLoading.value = true;
  try {
    const result = await applyReorderByDate(
      activeProjectId.value,
      preview.experiment_date,
      preview.expected_order_hash,
    );
    preview.projects.forEach((project) => invalidateProjectRecordCache(project.project_id));
    reorderDialogVisible.value = false;
    await loadRecords(activeProjectId.value, { preserveHistory: true, preserveSelection: true });
    ElMessage.success(`重排完成，共调整 ${result.changed_records} 条记录`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "按日期重排失败");
    reorderPreview.value = null;
  } finally {
    reorderLoading.value = false;
  }
}

function selectProject(projectId: string): void {
  if (activeProjectId.value === projectId) return;
  activeProjectId.value = projectId;
}

function scrollProjectTabs(direction: -1 | 1): void {
  projectStripRef.value?.scrollBy({ left: direction * 240, behavior: "smooth" });
}

function recordRowSelectable(row: LedgerRow): boolean {
  return !isDraft(row) && recordMatchesSelectionScope(row, recordSelectionScope.value);
}

const selectableVisibleRecords = computed(() =>
  tableRows.value.filter((row) => recordRowSelectable(row)),
);
const allVisibleRecordsSelected = computed(() => (
  selectableVisibleRecords.value.length > 0
  && selectableVisibleRecords.value.every((record) => selectedRecordIds.value.has(record.id))
));
const someVisibleRecordsSelected = computed(() => (
  !allVisibleRecordsSelected.value
  && selectableVisibleRecords.value.some((record) => selectedRecordIds.value.has(record.id))
));

function recordSelectedForRender(row: LedgerRow, renderedRowIndex: number): boolean {
  const preview = recordSelectionDragPreview.value;
  if (!preview) return selectedRecordIds.value.has(row.id);
  const rowIndex = tableRowIndexById.value.get(row.id) ?? renderedRowIndex;
  if (
    recordRowSelectable(row)
    && recordSelectionRangeContains(preview.range, rowIndex)
  ) return preview.selected;
  return preview.initialSelectedIds.has(row.id);
}

function commitRecordSelectionIds(nextIds: ReadonlySet<string>): void {
  handleTableSelectionChange(
    records.value.filter((record) => nextIds.has(record.id)),
  );
}

function setRecordSelected(record: LedgerRow, selected: boolean): void {
  if (!recordRowSelectable(record)) return;
  recordSelectionAnchorId = record.id;
  const nextIds = new Set(selectedRecordIds.value);
  if (selected) nextIds.add(record.id);
  else nextIds.delete(record.id);
  commitRecordSelectionIds(nextIds);
}

function setAllVisibleRecordsSelected(selected: boolean): void {
  recordSelectionAnchorId = null;
  if (selected) {
    void applyVisibleSelectionAction("select-all");
    return;
  }
  const visibleIds = new Set(selectableVisibleRecords.value.map((record) => record.id));
  const nextIds = new Set(selectedRecordIds.value);
  visibleIds.forEach((recordId) => nextIds.delete(recordId));
  handleTableSelectionChange(records.value.filter((record) => nextIds.has(record.id)));
}

async function selectionScopeAllows(action: RecordSelectionAction): Promise<boolean> {
  if (recordSelectionScope.value === "all" || !selectedRecordIds.value.size) return true;
  try {
    const containsLockedRecord = (await selectedTargetRecords()).some((record) => record.locked);
    if (!containsLockedRecord) return true;
    ElMessage.warning(
      `当前选择包含锁定记录，无法${action === "select-all" ? "全选" : "反选"}非锁定记录，请切换到“全部记录”并取消锁定记录的选择`,
    );
    return false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "检查已选记录失败");
    return false;
  }
}

async function applyVisibleSelectionAction(action: RecordSelectionAction): Promise<void> {
  if (!(await selectionScopeAllows(action))) return;
  recordSelectionAnchorId = null;
  const visibleRecords = tableRows.value.filter((row) => !isDraft(row));
  const next = applyVisibleRecordSelection({
    visibleRecords,
    selectedIds: selectedRecordIds.value,
    scope: recordSelectionScope.value,
    action,
  });
  const nextVisible = visibleRecords.filter((record) => next.has(record.id));
  visibleRecords.forEach((record) => {
    const selected = next.has(record.id);
    if (selected) {
      selectedRecordCache.set(record.id, record);
    } else {
      selectedRecordCache.delete(record.id);
    }
  });
  selectedRecordIds.value = next;
  selectedRecords.value = nextVisible;
}

function selectVisibleRecords(): void {
  void applyVisibleSelectionAction("select-all");
}

function invertVisibleSelection(): void {
  void applyVisibleSelectionAction("invert");
}

function rowCellStyle(row: LedgerRow, fieldId?: string): CSSProperties {
  const cellColor = fieldId ? row.cell_highlight_colors?.[fieldId] : undefined;
  const style: CSSProperties = row.highlight_color
    ? { "--record-highlight-color": row.highlight_color } as CSSProperties : {};
  if (cellColor) {
    style["--cell-highlight-color"] = cellColor;
  } else if (row.highlight_color) {
    style.backgroundColor = row.highlight_color;
  }
  return style;
}

async function selectedTargetRecords(): Promise<ProjectRecord[]> {
  const recordIds = [...selectedRecordIds.value];
  const missing = recordIds.filter(
    (recordId) =>
      !records.value.some((record) => record.id === recordId) && !selectedRecordCache.has(recordId),
  );
  if (missing.length) {
    const fetched = await getRecordsByIds(missing);
    fetched.forEach((record) => selectedRecordCache.set(record.id, record));
  }
  return recordIds
    .map(
      (recordId) =>
        records.value.find((record) => record.id === recordId) ?? selectedRecordCache.get(recordId),
    )
    .filter((record): record is ProjectRecord => Boolean(record));
}

async function mapInChunks<T, R>(
  values: T[],
  worker: (value: T) => Promise<R>,
  chunkSize = 25,
): Promise<R[]> {
  const result: R[] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    result.push(...(await Promise.all(values.slice(index, index + chunkSize).map(worker))));
  }
  return result;
}

function rowClassName({ row }: { row: LedgerRow }): string {
  const classes: string[] = [];
  if (isDraft(row)) classes.push("draft-row");
  else if (row.locked) classes.push("locked-row");
  if (row.highlight_color) classes.push("highlighted-row");
  if (row.id === focusRecordId.value) classes.push("search-focus-row");
  return classes.join(" ");
}

function collectGridCellHighlightTargets(): CellHighlightTarget[] {
  const targets: CellHighlightTarget[] = [];
  for (const { rowIndex, columnIndex } of selectedGridCellPositions()) {
    const row = tableRows.value[rowIndex];
    const field = fields.value[columnIndex];
    if (!row || !field || isDraft(row)) continue;
    targets.push({ recordId: row.id, fieldId: field.id });
  }
  return targets;
}

function openHighlightDialog(targets: ProjectRecord[]): void {
  const uniqueTargets = [...new Map(targets.map((record) => [record.id, record])).values()];
  if (!uniqueTargets.length) {
    ElMessage.warning("请先勾选需要标记的记录");
    return;
  }
  highlightMode.value = "record";
  highlightCellTargets.value = [];
  highlightTargetIds.value = uniqueTargets.map((record) => record.id);
  const firstColor = uniqueTargets[0]?.highlight_color ?? null;
  highlightColor.value =
    firstColor && uniqueTargets.every((record) => record.highlight_color === firstColor)
      ? firstColor
      : "#fff2cc";
  highlightDialogVisible.value = true;
}

function openSelectedHighlightDialog(): void {
  void selectedTargetRecords().then(openHighlightDialog).catch((error) => {
    ElMessage.error(error instanceof Error ? error.message : "读取所选记录失败");
  });
}

function openCellHighlightDialog(): void {
  const targets = collectGridCellHighlightTargets();
  if (!targets.length) {
    ElMessage.warning("当前选区没有可设置底色的已保存单元格");
    return;
  }
  highlightMode.value = "cell";
  highlightTargetIds.value = [];
  highlightCellTargets.value = targets;
  const colors = targets.map(
    ({ recordId, fieldId }) =>
      records.value.find((record) => record.id === recordId)?.cell_highlight_colors?.[fieldId] ??
      null,
  );
  const firstColor = colors[0];
  highlightColor.value =
    firstColor && colors.every((color) => color === firstColor) ? firstColor : "#fff2cc";
  highlightDialogVisible.value = true;
}

function openCurrentHighlightDialog(): void {
  if (hasGridCellSelection.value) openCellHighlightDialog();
  else openSelectedHighlightDialog();
}

async function submitHighlight(color: string | null): Promise<void> {
  if (highlightMode.value === "cell") {
    const targets = highlightCellTargets.value;
    if (!targets.length) return;
    const recordIds = [...new Set(targets.map((target) => target.recordId))];
    highlightLoading.value = true;
    try {
      const before = (await getRecordsByIds(recordIds)).map(snapshotRecord);
      if (before.length !== recordIds.length) throw new Error("部分目标记录已不存在，请刷新后重试");
      const updated = await setCellsHighlight(
        targets.map(({ recordId, fieldId }) => ({ record_id: recordId, field_id: fieldId })),
        color,
      );
      updated.forEach(replaceRecord);
      pushHistory(
        "批量修改单元格底色",
        before,
        updated,
        updated[0]?.project_id ?? activeProjectId.value,
      );
      highlightDialogVisible.value = false;
      ElMessage.success(
        color
          ? `已为 ${targets.length} 个单元格设置底色`
          : `已清除 ${targets.length} 个单元格的底色标记`,
      );
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "单元格底色保存失败");
    } finally {
      highlightLoading.value = false;
    }
    return;
  }
  const recordIds = highlightTargetIds.value;
  if (!recordIds.length) return;
  highlightLoading.value = true;
  try {
    const before = (await getRecordsByIds(recordIds)).map(snapshotRecord);
      if (before.length !== recordIds.length) throw new Error("部分目标记录已不存在，请刷新后重试");
    const updated = await setRecordsHighlight(recordIds, color);
    const updatedById = new Map(updated.map((record) => [record.id, record]));
    updated.forEach(replaceRecord);
    pushHistory(
      "批量修改台账底色",
      before,
      updated,
      updated[0]?.project_id ?? activeProjectId.value,
    );
    selectedRecords.value = selectedRecords.value.map(
      (record) => updatedById.get(record.id) ?? record,
    );
    highlightDialogVisible.value = false;
    ElMessage.success(
      color ? `已为 ${updated.length} 条记录设置底色` : `已清除 ${updated.length} 条记录的底色标记`,
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录底色保存失败");
  } finally {
    highlightLoading.value = false;
  }
}

function clearHighlight(): Promise<void> {
  return submitHighlight(null);
}

async function clearSelectedHighlight(): Promise<void> {
  if (hasGridCellSelection.value) {
    const targets = collectGridCellHighlightTargets();
    if (!targets.length) {
      ElMessage.warning("当前选区没有可清除底色的已保存单元格");
      return;
    }
    highlightMode.value = "cell";
    highlightTargetIds.value = [];
    highlightCellTargets.value = targets;
    await submitHighlight(null);
    return;
  }
  const recordIds = [...selectedRecordIds.value];
  if (!recordIds.length) {
    ElMessage.warning("请先勾选需要清除底色的记录");
    return;
  }
  highlightMode.value = "record";
  highlightTargetIds.value = recordIds;
  await submitHighlight(null);
}

async function handleManagerChanged(): Promise<void> {
  const changedProjectId = activeProjectId.value;
  invalidateProjectRecordCache(changedProjectId);
  await appStore.reloadProjects();
  const bridge = desktopBridge();
  if (bridge?.windowKind === "main" && changedProjectId) {
    void bridge
      .notifyQuickEntryFieldsChanged({ projectId: changedProjectId })
      .catch((error) => logError("ledger", "快速录入表头刷新通知失败", error));
  }
  const currentProjectId = activeProjectId.value;
  applyLedgerProjectLayout(currentProjectId);
  await persistLedgerProjectLayout(currentProjectId);
  await loadRecords();
}

let persistedLedgerLayout: unknown = null;
let layoutSaveGeneration = 0;

async function loadLedgerLayoutSettings(): Promise<void> {
  try {
    const result = await getSetting<unknown>(LEDGER_LAYOUT_SETTINGS_KEY);
    persistedLedgerLayout = result.value;
    ledgerLayoutSettings.value = normalizeLedgerLayoutSettings(result.value);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "台账布局设置读取失败");
  }
}

function applyLedgerProjectLayout(projectId: string): void {
  const project = appStore.projectById(projectId);
  const layout = resolveLedgerProjectLayout(
    ledgerLayoutSettings.value,
    projectId,
    project?.fields ?? [],
  );
  ledgerSort.value = layout.sort;
  ledgerFilters.value = layout.filters;
}

function virtualRowClass({ rowData }: { rowData: LedgerRow }): string {
  return rowClassName({ row: rowData });
}

function virtualRowProps({ rowData }: { rowData: LedgerRow }): Record<string, unknown> {
  return { "data-row-id": rowData.id };
}

function ledgerCellRenderState(row: LedgerRow, rowIndex: number, column: LedgerVirtualColumn) {
  const field = column.field!;
  const columnIndex = column.fieldIndex ?? -1;
  return {
    value: valueFor(row, field),
    error: fieldErrorFor(row, field),
    saveState: cellSaveStateFor(row, field),
    editing: isGridCellEditing({ rowIndex, columnIndex }),
    fillPreview: gridFillPreviewValue(rowIndex, columnIndex),
  };
}

function virtualCellProps({
  rowData,
  rowIndex,
  column,
}: {
  rowData: LedgerRow;
  rowIndex: number;
  column: LedgerVirtualColumn;
}): Record<string, unknown> {
  if (column.kind === "selection") {
    return {
      class: "ledger-selection-column",
      style: rowData.highlight_color ? { "--record-highlight-color": rowData.highlight_color } : undefined,
    };
  }
  if (column.kind === "lock") {
    return {
      class: "ledger-lock-column",
      style: rowData.highlight_color ? { "--record-highlight-color": rowData.highlight_color } : undefined,
    };
  }
  const fieldIndex = column.fieldIndex ?? -1;
  const fieldId = column.fieldId;
  return {
    class: ["ledger-editor-column", gridCellClassName(rowData, rowIndex, fieldIndex)],
    style: rowCellStyle(rowData, fieldId),
    "data-row-id": rowData.id,
    "data-field-index": fieldIndex,
  };
}

function virtualHeaderCellProps({
  column,
}: {
  column: LedgerVirtualColumn;
}): Record<string, unknown> {
  if (column.kind !== "field" || !column.fieldId) return {};
  const state = gridHeaderSelectionState.value.get(column.fieldId);
  return {
    class: state === "selected"
      ? "grid-header-selected"
      : state === "partial"
        ? "grid-header-partial"
        : "",
  };
}

function persistLedgerProjectLayout(projectId = activeProjectId.value): Promise<void> {
  if (!projectId) return Promise.resolve();
  ledgerLayoutSettings.value = withLedgerProjectLayout(
    ledgerLayoutSettings.value,
    projectId,
    {
      sort: ledgerSort.value,
      filters: ledgerFilters.value,
    },
  );
  const snapshot = ledgerLayoutSettings.value;
  const generation = layoutSaveGeneration;
  ledgerLayoutSaveQueue = ledgerLayoutSaveQueue
    .then(async () => {
      if (generation !== layoutSaveGeneration) return;
      await putSetting(LEDGER_LAYOUT_SETTINGS_KEY, snapshot, { expectedValue: persistedLedgerLayout });
      persistedLedgerLayout = snapshot;
    })
    .catch(async (error) => {
      layoutSaveGeneration += 1;
      await loadLedgerLayoutSettings();
      applyLedgerProjectLayout(activeProjectId.value);
      ElMessage.warning(error instanceof Error ? error.message : "台账布局设置保存失败");
    });
  return ledgerLayoutSaveQueue;
}

async function openQuickEntry(): Promise<void> {
  const project = currentProject.value;
  if (!project) return;
  const selectedFieldIds = project.fields
    .filter((field) => field.is_core || !field.hidden)
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((field) => field.id);
  const context = {
    projectId: project.id,
    selectedFieldIds,
  };
  const bridge = desktopBridge();
  if (bridge) {
    try {
      await bridge.openQuickEntry(context);
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "快速录入窗口打开失败");
    }
    return;
  }
  const target = router.resolve({
    name: "quick-entry",
    query: {
      project: context.projectId,
      fields: context.selectedFieldIds.join(","),
    },
  }).href;
  window.open(
    target,
    "gene-ledger-quick-entry",
    "popup=yes,width=820,height=680,resizable=yes,scrollbars=no",
  );
}

function fieldDefinitionById(fieldId: string): FieldDefinition | undefined {
  for (const project of appStore.projects) {
    const field = project.fields.find((item) => item.id === fieldId);
    if (field) return field;
  }
  return undefined;
}

function applyFieldWidth(fieldId: string, width: number): void {
  const field = fieldDefinitionById(fieldId);
  if (field) field.width = width;
}

function bestFitColumn(field: FieldDefinition): void {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  context.font = `${ledgerDisplaySettings.value.fontSizePx}px ${ledgerFontOption.value?.css ?? "system-ui"}`;
  const textWidth = tableRows.value.map((row) => valueFor(row, field)).reduce((maximum, value) => {
    const width = String(value ?? "")
      .split(/\r?\n/)
      .reduce((lineMaximum, line) => Math.max(lineMaximum, context.measureText(line).width), 0);
    return Math.max(maximum, width);
  }, 0);
  const headerTextWidth = context.measureText(field.label).width;
  handleHeaderResize(
    calculateLedgerBestFitWidth({
      bodyTextWidth: textWidth,
      headerTextWidth,
      fontSizePx: ledgerDisplaySettings.value.fontSizePx,
      editorWidthPercent: ledgerDisplaySettings.value.editorWidthPercent,
      toolsVisible: columnToolsVisible.value,
      sorted: ledgerSort.value?.fieldId === field.id,
      filtered: Boolean(ledgerFilters.value[field.id]),
    }),
    field.width,
    { columnKey: field.id },
  );
}

// Single delegated wheel listener on the table card: cells with overflowing
// values would otherwise capture the wheel, so non-editing cells forward the
// scroll to the table body instead (compact sizing behaviour).
function handleLedgerCellWheel(event: WheelEvent): void {
  const cell = gridCellFromElement(event.target);
  if (!cell || isGridCellEditing(cell)) return;
  // 滚动本体交给 el-vl 的内部滚轮处理(真实滚动容器在其内部子 div);
  // 这里若再手动 scrollTop 会与它叠加成双倍滚动。
  event.preventDefault();
}

function bestFitAllColumns(event?: MouseEvent): void {
  fields.value.forEach(bestFitColumn);
  (event?.currentTarget as HTMLElement | null)?.blur();
  ElMessage.success("已按当前加载结果调整所有可见列宽");
}

function handleHeaderResize(
  newWidth: number,
  _oldWidth: number,
  column: { columnKey?: string },
): void {
  const fieldId = column.columnKey;
  if (!fieldId) return;
  const field = fields.value.find((item) => item.id === fieldId);
  if (!field) return;
  const width = Math.min(
    LEDGER_COLUMN_MAX_WIDTH,
    Math.max(LEDGER_COLUMN_MIN_WIDTH, Math.round(newWidth)),
  );
  let queue = columnWidthSaveQueues.get(fieldId);
  if (!queue) {
    queue = new LatestValuePersistence<number>({
      initialValue: field.width,
      save: async (requestedWidth) => (await updateField(fieldId, { width: requestedWidth })).width,
      apply: (appliedWidth) => {
        applyFieldWidth(fieldId, appliedWidth);
        void remeasureVisibleTextareas(fieldId);
      },
      onLatestError: (error) => {
        ElMessage.error(error instanceof Error ? error.message : "列宽保存失败");
      },
    });
    columnWidthSaveQueues.set(fieldId, queue);
  } else {
    queue.syncCommittedValue(field.width);
  }
  if (width === field.width) return;
  queue.request(width);
}

/**
 * 一次网格粘贴/填充的运行时上下文：计划阶段（目标解析、草稿补建）
 * 的产物加上并发防线快照，供提交与校验面板两个阶段共享。
 */
interface PasteExecutionContext {
  projectId: string;
  operationLabel: string;
  viewIsCurrent: () => boolean;
  committableDrafts: Array<{ record: LedgerRow; snapshot: ProjectRecord }>;
  batchPreview: Awaited<ReturnType<typeof previewCellBatch>> | null;
  existingChanges: RecordCellChange[];
  cellVersions: Record<string, number>;
  rollbackSnapshots: Map<string, ValidationCellRollbackSnapshot>;
  appendedDraftIds: Set<string>;
  changedCells: number;
  skippedLocked: number;
  /** 剪贴板粘贴的回位目标；内部填充/清除路径（event=null）不需要。 */
  reveal?: { rowIndex: number; recordId: string | null };
}

async function commitPasteChanges(
  context: PasteExecutionContext,
  acceptWarnings: boolean,
): Promise<void> {
  const {
    projectId, operationLabel, viewIsCurrent, committableDrafts, batchPreview,
    existingChanges, cellVersions, changedCells, skippedLocked,
  } = context;
  if (acceptWarnings && !viewIsCurrent()) throw new Error("项目已切换，请重新执行该操作");
  let batchResult: RecordCellBatchCommitResult | null = null;
  committableDrafts.forEach(({ snapshot }) => setSaving(snapshot.id, true));
  try {
    if (batchPreview) {
      batchResult = await commitCellBatch(
        batchPreview.token,
        acceptWarnings,
        committableDrafts.length > 0,
      );
    }
  } finally {
    committableDrafts.forEach(({ snapshot }) => setSaving(snapshot.id, false));
  }
  if (batchResult) {
    invalidateProjectRecordCache(projectId);
    if (!ledgerDisposed) {
      if (committableDrafts.length) {
        pushHistory(`${operationLabel}台账数据`, batchResult.before, batchResult.after, projectId);
      } else {
        pushCellHistory(`${operationLabel}台账数据`, batchResult.changes, projectId);
      }
    }
  }
  if (!viewIsCurrent()) return;
  const completedKeys = new Set(
    existingChanges
      .map((change) => persistedKey(change.record_id, change.field_id))
      .filter((key) => (peekCellSaveVersion(key) ?? 0) === cellVersions[key]),
  );
  batchResult?.records.forEach((record) =>
    replaceRecordPreservingPending(record, completedKeys),
  );
  completedKeys.forEach((key) => {
    const [recordId = "", fieldId = ""] = key.split(":");
    if (recordId && fieldId) setCellSaveState(recordId, fieldId, { status: "saved" });
  });

  let committedDraftRecords: ProjectRecord[] = [];
  const committedAnchoredDraft = committableDrafts.some(
    ({ record }) => Boolean(record._insertAnchorId),
  );
  if (committableDrafts.length) {
    committedDraftRecords = reconcileCommittedPaste(
      committableDrafts,
      batchResult?.created_record_ids ?? [],
      batchResult?.records ?? [],
    ) ?? [];
    const pendingSaves = committedDraftRecords.flatMap((record) => fields.value.flatMap((field) => {
      const editing = editingGridSnapshot.value;
      if (editing?.rowId === record.id && editing.fieldId === field.id) return [];
      return cellSaveStates.value.get(persistedKey(record.id, field.id))?.status === "dirty"
        ? [saveField(record, field)]
        : [];
    }));
    await Promise.all(pendingSaves);
    if (!viewIsCurrent()) return;
    if (!committedDraftRecords.length && batchResult?.created_record_ids.length) {
      await loadRecords(projectId, { showLoading: false, preserveHistory: true });
    }
    const hasPendingEdits = committedDraftRecords.some((record) => fields.value.some((field) => {
      const status = cellSaveStates.value.get(persistedKey(record.id, field.id))?.status;
      return status === "dirty" || status === "saving" || status === "error";
    }));
    if (committedDraftRecords.length && committedAnchoredDraft && !hasPendingEdits) {
      await loadRecords(projectId, { showLoading: false, preserveHistory: true });
    }
  }
  if (!viewIsCurrent()) return;
  if (batchResult || committedDraftRecords.length) {
    scheduleLedgerRangeRefresh(projectId);
    ElMessage.success(`已${operationLabel} ${changedCells} 个单元格`);
  } else if (changedCells) {
    ElMessage.success(`已${operationLabel} ${changedCells} 个单元格，填写病理号后将自动保存`);
  }
  if (skippedLocked) ElMessage.info(`已跳过 ${skippedLocked} 个锁定单元格`);
}

/** 校验门禁分支：错误阻断、警告需确认；取消时回滚全部写入与补建的草稿行。 */
function openPasteValidationGate(
  context: PasteExecutionContext,
  allIssues: Awaited<ReturnType<typeof previewCellBatch>>["issues"],
  errors: typeof allIssues,
  warnings: typeof allIssues,
): void {
  const {
    projectId, operationLabel, viewIsCurrent, batchPreview,
    existingChanges, cellVersions, rollbackSnapshots, appendedDraftIds, skippedLocked,
  } = context;
  const prompt = errors.length
    ? {
        title: "无法保存",
        outcomeText: "本次更改尚未保存，请按提示调整后重试。",
        cancelText: "返回修改",
        continueText: "",
      }
    : buildValidationPromptCopy(warnings, {
        context: "batch",
        cancelBehavior: "discard",
        operationLabel,
      });
  openValidationPanel(
    {
      token: "",
      projectId,
      ...prompt,
      label: `${operationLabel}台账数据`,
      issues: allIssues,
      affectedCount: batchPreview?.affected_count ?? 0,
      skippedLocked: (batchPreview?.skipped_locked ?? 0) + skippedLocked,
      cellKeys: [...rollbackSnapshots.keys()],
      cellVersions,
      canContinue: !errors.length,
    },
    errors.length
      ? undefined
      : {
          action: () => commitPasteChanges(context, true).then(() => {
            if (context.viewIsCurrent() && context.reveal) {
              revealGridPasteTarget(context.reveal.rowIndex, context.reveal.recordId);
            }
          }),
          cancel: () => {
            if (!viewIsCurrent()) return;
            rollbackValidationCells([...rollbackSnapshots.values()], cellVersions);
            removeDraftRows(appendedDraftIds);
            ElMessage.info(`已取消${operationLabel}，并恢复操作前的内容`);
          },
        },
  );
  existingChanges.forEach((change) => {
    setCellSaveState(change.record_id, change.field_id, {
      status: errors.length ? "error" : "dirty",
      message: errors[0]?.message ?? "等待警告确认",
    });
  });
}

async function pasteGrid(
  event: ClipboardEvent | null,
  startRowIndex: number,
  startColumnIndex: number,
  exactCells?: GridPasteEntry[],
  textOverride?: string,
  operationLabel = "粘贴",
): Promise<GridCellPosition[]> {
  const text = exactCells
    ? ""
    : textOverride ?? event?.clipboardData?.getData("text/plain") ?? "";
  if (!exactCells && !text) return [];
  const projectId = activeProjectId.value;
  const projectGeneration = projectViewGeneration;
  const viewIsCurrent = () => !ledgerDisposed
    && projectId === activeProjectId.value
    && projectGeneration === projectViewGeneration;
  event?.preventDefault();
  // Pasting should preserve the current viewport and the starting cell.  A
  // pending "add record" scroll or a newly-created draft row must not move
  // the table to the bottom while the paste is being committed.
  clearBottomScrollTimers();
  const entries = exactCells ?? parsePasteEntries(text);
  if (!entries.length) return [];
  const rowCountBeforeAppend = tableRows.value.length;
  const rollbackSnapshots = new Map<string, ValidationCellRollbackSnapshot>();
  const draftIdsBeforePaste = new Set(draftRows.value.map((record) => record.id));
  const changedDraftRows = new Map<string, { record: LedgerRow }>();
  const existingChanges: RecordCellChange[] = [];
  let changedCells = 0;
  try {
    for (
      let index = 0;
      index < countMissingPasteRows(entries, startRowIndex, rowCountBeforeAppend);
      index += 1
    ) appendDraftRow(false);
    const appendedDraftIds = new Set(
      draftRows.value
        .filter((record) => !draftIdsBeforePaste.has(record.id))
        .map((record) => record.id),
    );
    const resolved = resolvePasteTargets(
      entries,
      startRowIndex,
      startColumnIndex,
      tableRows.value,
      fields.value,
      { exact: Boolean(exactCells) },
    );
    resolved.targets.forEach((target) => {
      const key = persistedKey(target.record.id, target.field.id);
      if (!rollbackSnapshots.has(key)) {
        rollbackSnapshots.set(key, captureValidationCellRollback(target.record, target.field));
      }
      if (!isDraft(target.record)) {
        existingChanges.push({
          record_id: target.record.id,
          field_id: target.field.id,
          value: target.value,
          expected_value: target.expectedValue,
        });
        setCellSaveState(target.record.id, target.field.id, { status: "saving" });
      }
      setValue(target.record, target.field, target.value);
      if (isDraft(target.record)) {
        changedDraftRows.set(target.record.id, {
          record: target.record,
        });
      }
      changedCells += 1;
    });
    const committableDrafts = [...changedDraftRows.values()].filter(
      ({ record }) => record.pathology_number.trim() && !savingIds.value.has(record.id),
    ).map((entry) => ({ ...entry, snapshot: snapshotRecord(entry.record) }));
    const cellKeys = [...rollbackSnapshots.keys()];
    const cellVersions = Object.fromEntries(
      cellKeys.map((key) => [key, peekCellSaveVersion(key) ?? 0]),
    );
    let batchPreview: Awaited<ReturnType<typeof previewCellBatch>> | null = null;
    committableDrafts.forEach(({ snapshot }) => setSaving(snapshot.id, true));
    try {
      if (existingChanges.length || committableDrafts.length) {
        batchPreview = await previewCellBatch(
          projectId,
          existingChanges,
          buildBatchNewRecords(
            committableDrafts.map(({ record }) => record),
            currentProject.value?.fields ?? [],
          ),
        );
      }
    } finally {
      committableDrafts.forEach(({ snapshot }) => setSaving(snapshot.id, false));
    }
    const allIssues = batchPreview?.issues ?? [];
    const errors = allIssues.filter((issue) => issue.severity === "error");
    const warnings = allIssues.filter((issue) => issue.severity === "warning");
    const context: PasteExecutionContext = {
      projectId,
      operationLabel,
      viewIsCurrent,
      committableDrafts,
      batchPreview,
      existingChanges,
      cellVersions,
      rollbackSnapshots,
      appendedDraftIds,
      changedCells,
      skippedLocked: resolved.skippedLocked,
      reveal: event
        ? { rowIndex: startRowIndex, recordId: tableRows.value[startRowIndex]?.id ?? null }
        : undefined,
    };

    if (errors.length || warnings.length) {
      if (!viewIsCurrent()) return [];
      openPasteValidationGate(context, allIssues, errors, warnings);
      return resolved.changedPositions;
    }

    await commitPasteChanges(context, false);
    if (!viewIsCurrent()) return [];
    if (allIssues.length) {
      openValidationPanel({
        token: "",
        projectId,
        title: "操作提示",
        label: `${operationLabel}台账数据`,
        outcomeText: `本次${operationLabel}已经完成。`,
        cancelText: "我知道了",
        continueText: "",
        issues: allIssues,
        affectedCount: batchPreview?.affected_count ?? 0,
        skippedLocked: (batchPreview?.skipped_locked ?? 0) + resolved.skippedLocked,
        cellKeys,
        cellVersions,
        canContinue: false,
      });
    }
    if (context.reveal) revealGridPasteTarget(context.reveal.rowIndex, context.reveal.recordId);
    return resolved.changedPositions;
  } catch (error) {
    if (!viewIsCurrent()) return [];
    await loadRecords(projectId, { showLoading: false, preserveHistory: true, preserveSelection: true });
    if (viewIsCurrent()) ElMessage.error(error instanceof Error ? error.message : "粘贴保存失败");
    return [];
  }
}

async function updateSelectedStatus(status: RecordStatus): Promise<void> {
  const targets = (await selectedTargetRecords()).filter((record) => !record.locked);
  if (!targets.length) {
    ElMessage.warning("没有可修改的未锁定记录");
    return;
  }
  loading.value = true;
  try {
    const before = targets.map(snapshotRecord);
    const updated = await mapInChunks(targets, (record) =>
      updateRecord(record.id, { status }),
    );
    updated.forEach(replaceRecord);
    pushHistory("批量修改状态", before, updated, targets[0]?.project_id ?? activeProjectId.value);
    ElMessage.success(`已将 ${targets.length} 条记录标记为${status}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "批量状态修改失败");
  } finally {
    loading.value = false;
  }
}

async function updateSelectedLock(locked: boolean): Promise<void> {
  const selectedTargets = await selectedTargetRecords();
  if (!selectedTargets.length) {
    ElMessage.warning("请先勾选记录");
    return;
  }
  loading.value = true;
  try {
    const updated = await mapInChunks(selectedTargets, (record) =>
      setRecordLock(record.id, locked),
    );
    updated.forEach(replaceRecord);
    if (locked && !showLockedRecords.value) {
      clearRecordSelection();
      await loadRecords(activeProjectId.value, { preserveHistory: true });
    }
    ElMessage.success(locked ? "所选记录已锁定" : "所选记录已解锁");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "锁定状态修改失败");
  } finally {
    loading.value = false;
  }
}

async function updateSelectedReportStatus(reportGenerated: boolean): Promise<void> {
  const targets = (await selectedTargetRecords()).filter((record) => !record.locked);
  if (!targets.length) {
    ElMessage.warning("没有可修改的未锁定记录");
    return;
  }
  loading.value = true;
  try {
    const before = targets.map(snapshotRecord);
    const updated: ProjectRecord[] = [];
    const targetIds = targets.map((record) => record.id);
    for (let index = 0; index < targetIds.length; index += 1000) {
      updated.push(
        ...(await setRecordsReportGenerated(targetIds.slice(index, index + 1000), reportGenerated)),
      );
    }
    updated.forEach(replaceRecord);
    pushHistory(
      "批量修改报告状态",
      before,
      updated,
      targets[0]?.project_id ?? activeProjectId.value,
    );
    ElMessage.success(reportGenerated ? "所选记录已标记为已生成报告" : "所选记录已恢复为未生成报告");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "报告状态修改失败");
  } finally {
    loading.value = false;
  }
}

function handleBatchStatusCommand(status: RecordStatus): void {
  void updateSelectedStatus(status);
}

function handleBatchReportCommand(command: "generated" | "pending"): void {
  void updateSelectedReportStatus(command === "generated");
}

function handleBatchHighlightCommand(command: "set" | "clear"): void {
  if (command === "set") openCurrentHighlightDialog();
  else void clearSelectedHighlight();
}

function handleBatchLockCommand(command: "lock" | "unlock"): void {
  void updateSelectedLock(command === "lock");
}

async function deleteLedgerRecords(selectedTargets: ProjectRecord[]): Promise<void> {
  if (!selectedTargets.length) {
    ElMessage.warning("请先勾选需要删除的记录");
    return;
  }
  const targets = selectedTargets.filter((record) => !record.locked);
  const lockedCount = selectedTargets.length - targets.length;
  if (!targets.length) {
    ElMessage.warning("所选记录均已锁定，请先解锁后再删除");
    return;
  }

  const lockedNote = lockedCount
    ? `；另有 ${lockedCount} 条锁定记录将保留`
    : "";
  const batchDelete = selectedTargets.length > 1;
  try {
    await ElMessageBox.confirm(
      batchDelete
        ? `确认永久删除所选的 ${targets.length} 条台账记录${lockedNote}？删除后无法恢复。`
        : `确认永久删除病理号“${targets[0]!.pathology_number}”的台账记录？删除后无法恢复。`,
      batchDelete ? "批量删除二次确认" : "删除记录二次确认",
      {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "无法打开删除确认");
    return;
  }

  loading.value = true;
  try {
    const results: PromiseSettledResult<void>[] = [];
    for (let index = 0; index < targets.length; index += 25) {
      results.push(
        ...(await Promise.allSettled(
          targets.slice(index, index + 25).map((record) => deleteRecord(record.id)),
        )),
      );
    }
    const deletedIds = new Set(
      targets
        .filter((_record, index) => results[index]?.status === "fulfilled")
        .map((record) => record.id),
    );
    const deletedRecords = targets
      .filter((record) => deletedIds.has(record.id))
      .map(snapshotRecord);
    targets.forEach((record) => invalidateProjectRecordCache(record.project_id));
    records.value = records.value.filter((record) => !deletedIds.has(record.id));
    recordTotal.value = Math.max(0, recordTotal.value - deletedIds.size);
    scheduleLedgerRangeRefresh(activeProjectId.value);
    clearRecordSelection();
    activeGridCell.value = null;
    clearGridCellSelection();
    rememberAll();
    pushHistory(
      batchDelete ? "批量删除台账记录" : "删除台账记录",
      deletedRecords,
      [],
      targets[0]?.project_id ?? activeProjectId.value,
    );
    const failedCount = targets.length - deletedIds.size;
    if (deletedIds.size) ElMessage.success(`已删除 ${deletedIds.size} 条记录`);
    if (failedCount) ElMessage.error(`${failedCount} 条记录删除失败，请刷新后重试`);
  } finally {
    loading.value = false;
  }
}

async function deleteSelectedRecords(): Promise<void> {
  try {
    await deleteLedgerRecords(await selectedTargetRecords());
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "读取所选记录失败");
  }
}

async function exportCurrentProject(): Promise<void> {
  if (!currentProject.value) return;
  try {
    const start = normalizeDateInput(exportFilter.start);
    const end = normalizeDateInput(exportFilter.end);
    if (start && end && start > end) throw new Error("导出开始日期不能晚于结束日期");
    exportFilter.start = start;
    exportFilter.end = end;
    const items: ProjectRecord[] = [];
    let offset = 0;
    while (true) {
      const page = await queryRecords({
        ...buildRecordQuery(activeProjectId.value, { includeDisplayRange: false }),
        include_locked: true,
        limit: 1000,
        offset,
      });
      items.push(...page.items);
      offset += page.items.length;
      if (!page.items.length || offset >= page.total) break;
    }
    const exportItems = items.filter((record) => {
      const date = record.experiment_date ?? "";
      return (!start || date >= start) && (!end || date <= end);
    });
    const saved = await exportWorkbook(
      [
        {
          name: currentProject.value.name,
          headers: ["_record_id", "_project_id", ...fields.value.map((field) => field.label)],
          hiddenColumns: [1, 2],
          rows: exportItems.map((record) => [
            record.id,
            record.project_id,
            ...fields.value.map((field) => valueFor(record, field)),
          ]),
        },
      ],
      `${currentProject.value.name}_台账`,
    );
    if (!saved) return;
    ElMessage.success(`已导出 ${exportItems.length} 条记录`);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "导出条件无效");
  }
}

function selectedPreviewCells(): Array<{ record_id: string; field_id: string }> {
  const cells: Array<{ record_id: string; field_id: string }> = [];
  for (const position of selectedGridCellPositions()) {
    const data = gridCellData(position);
    if (data && !isDraft(data.record)) {
      cells.push({ record_id: data.record.id, field_id: data.field.id });
    }
  }
  return cells;
}

watch(
  () => appStore.projects.map((project) => project.id).join(","),
  () => {
    if (!ledgerInitialized || !appStore.projects.length) return;
    if (!appStore.projects.some((project) => project.id === activeProjectId.value)) {
      activeProjectId.value = appStore.projects[0]?.id ?? "";
    }
  },
);
const selectedGridStats = computed(() => {
  const positions = selectedGridCellPositions();
  const summary = summarizeLedgerSelection(
    positions.flatMap((position) => {
      const data = gridCellData(position);
      return data
        ? [{ value: valueFor(data.record, data.field), dataType: data.field.data_type }]
        : [];
    }),
  );
  const states = positions.map((position) => {
    const data = gridCellData(position);
    return data ? cellSaveStates.value.get(persistedKey(data.record.id, data.field.id))?.status : undefined;
  });
  const saveStatus: CellSaveStatus | "idle" = states.includes("error")
    ? "error"
    : states.includes("saving")
      ? "saving"
      : states.includes("dirty")
        ? "dirty"
        : states.length && states.every((state) => state === "saved")
          ? "saved"
          : "idle";
  return {
    ...summary,
    saveStatus,
  };
});
watch(
  () => [
    ledgerDisplaySettings.value.rowPaddingY,
    ledgerDisplaySettings.value.editorWidthPercent,
    ledgerDisplaySettings.value.editorHeightPercent,
    ledgerDisplaySettings.value.fontFamily,
    ledgerDisplaySettings.value.fontSizePx,
    ledgerDisplaySettings.value.zoomPercent,
  ],
  () => {
    refreshTableLayout();
  },
);

watch(activeProjectId, async (projectId, previousProjectId) => {
  projectViewGeneration += 1;
  if (!ledgerInitialized || !projectId || projectId === previousProjectId) return;
  rememberLastLedgerProjectId(projectId);
  const load = (async () => {
    clearBottomScrollTimers();
    stopGridCellDrag(false);
    closeLedgerOverlays();
    dismissValidationPanel();
    applyLedgerProjectLayout(projectId);
    clearGridCellEdit();
    clearSelectionsAfterLedgerViewChange();
    draftRows.value = [];
    cleanupInsertedGroupRegistry();
    highlightDialogVisible.value = false;
    highlightTargetIds.value = [];
    highlightMode.value = "record";
    highlightCellTargets.value = [];
    persistedValues.clear();
    void router.replace({ query: { ...route.query, project: projectId } });
    await loadRecords(projectId, {
      preserveHistory: true,
      stabilizeTable: true,
      preferCache: true,
    });
  })();
  projectLoadPromise = load;
  try {
    await load;
  } finally {
    if (projectLoadPromise === load) projectLoadPromise = null;
  }
}, { flush: "sync" });

async function initializeLedger(): Promise<void> {
  await loadLedgerDisplaySettings();
  await loadLedgerRangeSettings();
  try {
    await appStore.bootstrap();
  } catch {
    if (!appStore.projects.length) return;
  }
  await loadLedgerLayoutSettings();
  const queryProject =
    typeof route.query.project === "string" ? route.query.project : "";
  const initialProjectId = resolveInitialLedgerProjectId(
    queryProject,
    readLastLedgerProjectId(),
    appStore.projects.map((project) => project.id),
  );
  activeProjectId.value = initialProjectId;
  await nextTick();
  ledgerInitialized = true;
  if (!initialProjectId) {
    records.value = [];
    return;
  }
  rememberLastLedgerProjectId(initialProjectId);
  await router.replace({ query: { ...route.query, project: initialProjectId } });
  applyLedgerProjectLayout(initialProjectId);
  await loadRecords(initialProjectId, { stabilizeTable: true });
}

function handleLedgerDocumentPointerDown(event: PointerEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".ledger-column-tools-popover, .ledger-column-tools-trigger, .ledger-context-menu")) {
    return;
  }
  closeLedgerOverlays();
}

function handleLedgerDocumentKeydown(event: KeyboardEvent): void {
  if (
    !event.isComposing &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  ) {
    const key = event.key.toLowerCase();
    if (key === "f" || key === "h") {
      event.preventDefault();
      event.stopPropagation();
      openFindReplace(key === "f" ? "find" : "replace", !findReplaceVisible.value);
      return;
    }
  }
  if (event.key !== "Escape" || findReplaceVisible.value) return;
  if (!columnToolsOpenFieldId.value && !ledgerContextMenu.value) return;
  closeLedgerOverlays();
  event.stopPropagation();
}

function handleLedgerDocumentScroll(): void {
  closeLedgerOverlays();
}

onMounted(() => {
  document.addEventListener("click", handleRecordSelectionClickCapture, true);
  document.addEventListener("pointerdown", handleLedgerDocumentPointerDown);
  document.addEventListener("keydown", handleLedgerDocumentKeydown);
  document.addEventListener("scroll", handleLedgerDocumentScroll, true);
  window.addEventListener("resize", handleLedgerDocumentScroll);
  window.addEventListener("focus", handleLedgerWindowFocus);
  removeDocumentGridShortcuts = attachDocumentShortcuts();
  const bridge = desktopBridge();
  if (bridge?.windowKind === "main") {
    removeQuickEntryChangedListener = bridge.onQuickEntryChanged(handleQuickEntryChanged);
    void requestPendingQuickEntryChanges();
  }
  void loadPreviewEngineSetting();
  void loadPreviewCapabilities();
  void initializeLedger();
});

onBeforeUnmount(() => {
  removeCloseGuard();
  ledgerDisposed = true;
  cancelLedgerRangeRefresh();
  removeDocumentGridShortcuts?.();
  removeDocumentGridShortcuts = null;
  if (quickEntryRetryTimer !== undefined) window.clearTimeout(quickEntryRetryTimer);
  quickEntryRetryTimer = undefined;
  quickEntryRetryPending.clear();
  cancelFindTermDebounce();
  ledgerHistory.clear();
  document.removeEventListener("click", handleRecordSelectionClickCapture, true);
  document.removeEventListener("pointerdown", handleLedgerDocumentPointerDown);
  document.removeEventListener("keydown", handleLedgerDocumentKeydown);
  document.removeEventListener("scroll", handleLedgerDocumentScroll, true);
  window.removeEventListener("resize", handleLedgerDocumentScroll);
  window.removeEventListener("focus", handleLedgerWindowFocus);
  removeQuickEntryChangedListener?.();
  removeQuickEntryChangedListener = undefined;
  stopGridCellDrag(false);
  stopGridFillDrag();
  stopRecordSelectionDrag(false);
  disposeRecords();
  clearGridCellEdit();
  activeGridCell.value = null;
  clearGridCellSelection();
  clearLastGridClipboard();
  bottomScrollTimers.forEach((timer) => window.clearTimeout(timer));
  bottomScrollTimers = [];
  autosizeTextareaRefs.clear();
  columnWidthSaveQueues.clear();
  clearCellSaveInFlight();
  clearAllCellSaveStates();
});
</script>

<template>
  <div class="page-stack ledger-page">
    <LedgerCommandCard
      :can-undo="canUndoHistory"
      :can-redo="canRedoHistory"
      :history-busy="historyBusy"
      v-model:show-locked="showLockedRecords"
      v-model:more-visible="moreActionsVisible"
      :column-tools-open="columnToolsVisible"
      :has-cell-selection="hasGridCellSelection"
      :busy="loading"
      :native-preview-loading="nativePreviewLoading"
      :native-preview-available="nativeEngineAvailable('auto')"
      :word-available="nativeEngineAvailable('word')"
      :wps-available="nativeEngineAvailable('wps')"
      :engine-label="nativeEngineLabel()"
      v-model:preview-engine="previewEngine"
      v-model:preview-scope="previewScope"
      v-model:range-mode="ledgerRangeDraft.mode"
      v-model:range-months="ledgerRangeDraft.months"
      v-model:range-count="ledgerRangeDraft.count"
      v-model:range-include-undated="ledgerRangeDraft.includeUndated"
      v-model:range-include-future="ledgerRangeDraft.includeFuture"
      :months-max="LEDGER_RANGE_MONTHS_MAX"
      :count-max="LEDGER_RANGE_COUNT_MAX"
      :range-dates="ledgerRangeDates"
      :range-saving="ledgerRangeSaving"
      @undo="undoLedger"
      @redo="redoLedger"
      @add-record="appendDraftRow"
      @open-quick-entry="openQuickEntry"
      @locked-visibility-change="handleLockedVisibilityChange"
      @toggle-export="exportVisible = !exportVisible"
      @reorder="openReorderDialog"
      @find-replace="openFindReplace()"
      @toggle-column-tools="toggleColumnTools"
      @best-fit-all="bestFitAllColumns($event)"
      @manage-projects="managerVisible = true"
      @save-preview-engine="savePreviewEngineSetting"
      @open-native="openLedgerNative"
      @save-range="saveLedgerRangeSettings"
    >        <div
          class="ledger-cell-editor-bar"
          :class="{
            'is-expanded': ledgerCellEditorExpanded,
            'is-readonly': ledgerCellEditorReadonly,
          }"
          role="group"
          :aria-label="ledgerCellEditorTitle"
          :title="ledgerCellEditorTitle"
        >
          <span class="ledger-cell-editor-address">{{ ledgerCellEditorAddress }}</span>
          <el-input
            id="ledger-cell-editor-input"
            class="ledger-cell-editor-input"
            type="textarea"
            resize="none"
            :rows="ledgerCellEditorExpanded ? 4 : 1"
            :model-value="ledgerCellEditorValue"
            :disabled="ledgerCellEditorDisabled"
            :readonly="ledgerCellEditorReadonly"
            :placeholder="ledgerCellEditorCell
              ? `编辑 ${ledgerCellEditorCell.field.label}`
              : '选择单元格后可编辑完整内容'"
            :aria-label="ledgerCellEditorCell
              ? `编辑单元格 ${ledgerCellEditorAddress}，${ledgerCellEditorCell.field.label}`
              : '单元格编辑栏'"
            autocomplete="off"
            spellcheck="false"
            @focus="beginLedgerCellEditorEdit"
            @update:model-value="updateLedgerCellEditorValue"
            @blur="handleLedgerCellEditorBlur"
            @keydown="handleLedgerCellEditorKeydown"
          />
          <button
            type="button"
            class="ledger-cell-editor-toggle"
            :aria-expanded="ledgerCellEditorExpanded"
            aria-controls="ledger-cell-editor-input"
            aria-keyshortcuts="Control+Shift+U"
            :aria-label="ledgerCellEditorExpanded ? '收起单元格编辑栏' : '展开单元格编辑栏'"
            :title="ledgerCellEditorExpanded
              ? '收起编辑栏（Ctrl+Shift+U）'
              : '展开编辑栏（Ctrl+Shift+U）'"
            @pointerdown.stop.prevent
            @click.stop="toggleLedgerCellEditorExpanded"
          >
            <ArrowUp v-if="ledgerCellEditorExpanded" :size="15" aria-hidden="true" />
            <ArrowDown v-else :size="15" aria-hidden="true" />
          </button>
        </div>
    </LedgerCommandCard>

    <LedgerExportPanel
      v-model:visible="exportVisible"
      v-model:start="exportFilter.start"
      v-model:end="exportFilter.end"
      @export="exportCurrentProject"
    />

    <LedgerSelectionBar
      v-model:selection-scope="recordSelectionScope"
      :selected-count="selectedCount"
      :has-cell-selection="hasGridCellSelection"
      :editing="gridCellInternalEditing"
      :highlight-busy="highlightLoading"
      :batch-active="batchSelectionActive"
      @select-all="selectVisibleRecords"
      @invert-selection="invertVisibleSelection"
      @highlight="handleBatchHighlightCommand"
      @status="handleBatchStatusCommand"
      @report="handleBatchReportCommand"
      @lock="handleBatchLockCommand"
      @delete-selected="deleteSelectedRecords"
      @clear-selection="clearBatchSelection"
    />

    <section
      ref="ledgerTableCardRef"
      class="page-card ledger-table-card"
      tabindex="-1"
      @wheel="handleLedgerCellWheel"
      @pointerdown.capture="handleGridPointerDown"
      @click.capture="handleGridClick"
      @dblclick.capture="handleGridDoubleClick"
      @focusin.capture="handleGridFocusIn"
      @focusout.capture="handleGridFocusOut"
      @keydown.capture="handleGridKeydown"
      @copy.capture="handleGridCopy"
      @cut.capture="handleGridCut"
      @paste.capture="handleGridPaste"
      @contextmenu.capture="handleLedgerContextMenu"
    >
      <transition name="ledger-overlay-pop">
        <div
          v-if="gridFillPreviewRange && gridFillPreviewSummary"
          class="grid-fill-preview-popover"
          :style="{
            left: `${gridFillPreviewPointer.left}px`,
            top: `${gridFillPreviewPointer.top}px`,
          }"
        >
          <span>{{ gridFillPreviewSummary }}</span>
        </div>
      </transition>
      <div
        v-loading="loading"
        class="ledger-table-surface"
        :style="ledgerTableStyle"
        :element-loading-text="recordTotal > 0
          ? `正在读取记录… ${loadedRecordCount}/${recordTotal}`
          : '正在切换或读取项目数据…'"
        element-loading-background="var(--app-loading-mask)"
        element-loading-custom-class="ledger-loading-mask"
      >
        <el-auto-resizer>
          <template #default="{ height, width }">
            <el-table-v2
              v-if="height > 0 && width > 0"
              ref="tableRef"
              :class="{
                'grid-selection-dragging': gridSelectionDragging,
                'record-selection-dragging': recordSelectionDragging,
              }"
              :columns="ledgerVirtualColumns"
              :data="tableRows"
              :width="width"
              :height="height"
              :footer-height="ledgerVirtualContentWidth > width
                ? LEDGER_HORIZONTAL_SCROLLBAR_HEIGHT
                : 0"
              :row-height="ledgerVirtualRowHeight"
              :header-height="ledgerVirtualHeaderHeight"
              :cache="2"
              row-key="id"
              :row-class="virtualRowClass"
              :row-props="virtualRowProps"
              :cell-props="virtualCellProps"
              :header-cell-props="virtualHeaderCellProps"
              fixed
              @scroll="handleLedgerTableScroll"
            >
              <template #footer>
                <div
                  v-if="ledgerVirtualContentWidth > width"
                  ref="ledgerHorizontalScrollbarRef"
                  class="ledger-table-horizontal-scrollbar"
                  aria-label="台账横向滚动条"
                  @scroll.passive="handleLedgerHorizontalScrollbarScroll"
                >
                  <div
                    class="ledger-table-horizontal-scrollbar-content"
                    :style="{ width: `${Math.max(ledgerVirtualContentWidth, width)}px` }"
                  />
                </div>
              </template>

              <template #header-cell="{ column }">
                <div v-if="column.kind === 'selection'" class="ledger-v2-selection-control">
                  <el-checkbox
                    :model-value="allVisibleRecordsSelected"
                    :indeterminate="someVisibleRecordsSelected"
                    :disabled="!selectableVisibleRecords.length"
                    aria-label="选择全部可见记录"
                    @pointerdown.stop
                    @click.stop
                    @change="setAllVisibleRecordsSelected(Boolean($event))"
                  />
                </div>
                <div v-else-if="column.kind === 'lock'" aria-hidden="true" />
                <div
                  v-else-if="column.field"
                  class="ledger-header-label"
                  @click="handleLedgerHeaderClick(column.fieldIndex ?? -1, $event)"
                >
                  <span>{{ column.field?.label }}</span>
                  <button
                    v-if="columnToolsVisible"
                    type="button"
                    class="ledger-column-tools-trigger"
                    :class="{
                      active: columnToolsOpenFieldId === column.fieldId,
                      sorted: ledgerSort?.fieldId === column.fieldId,
                      filtered: Boolean(ledgerFilters[column.fieldId]),
                    }"
                    :aria-label="`打开${column.field?.label ?? ''}排序和筛选`"
                    @pointerdown.stop
                    @click.stop="openColumnTools(column.field!, $event)"
                    @dblclick.stop
                    @contextmenu.stop.prevent
                  >
                    <Setting :size="14" :stroke-width="1.7" aria-hidden="true" />
                  </button>
                  <span v-if="ledgerSort?.fieldId === column.fieldId" class="ledger-sort-indicator">
                    <ArrowUp v-if="ledgerSort?.order === 'ascending'" :size="13" aria-label="升序" />
                    <ArrowDown v-else :size="13" aria-label="降序" />
                  </span>
                  <span v-if="ledgerFilters[column.fieldId]" class="ledger-filter-indicator" />
                </div>
              </template>

              <template #cell="{ rowData: row, rowIndex, column }">
                <div
                  v-if="column.kind === 'selection'"
                  class="ledger-v2-selection-control"
                  :data-row-id="row.id"
                  :data-row-index="rowIndex"
                  :title="recordRowSelectable(row)
                    ? '上下拖动可连续选择；Shift+点击选择范围'
                    : undefined"
                  @pointerdown.stop="handleRecordSelectionPointerDown($event, row, rowIndex)"
                  @click.stop
                >
                  <el-checkbox
                    :model-value="recordSelectedForRender(row, rowIndex)"
                    :disabled="!recordRowSelectable(row)"
                    :aria-label="`选择记录 ${row.pathology_number || row.id}`"
                    @change="setRecordSelected(row, Boolean($event))"
                  />
                </div>
                <div v-else-if="column.kind === 'lock'" class="ledger-v2-lock-state">
                  <el-icon
                    v-if="row.locked"
                    class="row-lock"
                    title="整条记录已锁定"
                  >
                    <Lock />
                  </el-icon>
                </div>
                <template v-else-if="column.field">
                  <div
                    v-for="cellData in [ledgerCellRenderState(row, rowIndex, column)]"
                    :key="column.fieldId"
                    class="cell-field"
                    :class="{
                      'cell-field-invalid': cellData.error,
                      'cell-field-editing': cellData.editing,
                    }"
                    :data-row-id="row.id"
                    :data-field-index="column.fieldIndex"
                    :tabindex="cellData.editing ? -1 : 0"
                  >
                    <template v-if="cellData.editing">
                      <EditableDateInput
                        v-if="column.field?.data_type === 'date'
                          || column.field?.system_key === 'experiment_date'"
                        :model-value="cellData.value"
                        :readonly="row.locked"
                        @update:model-value="setValue(row, column.field!, $event)"
                        @change="saveField(row, column.field!)"
                      />
                      <EditableChoiceInput
                        v-else-if="column.field!.options.length
                          || column.field?.data_type === 'select'"
                        :model-value="cellData.value"
                        :options="fieldOptions(column.field!)"
                        :readonly="row.locked"
                        @update:model-value="setValue(row, column.field!, $event)"
                        @change="saveField(row, column.field!)"
                      />
                      <el-input
                        v-else-if="!column.field?.is_core"
                        :ref="(instance: unknown) => setAutosizeTextareaRef(
                          instance,
                          row.id,
                          column.field!.id,
                        )"
                        type="textarea"
                        :autosize="{ minRows: 1, maxRows: 1 }"
                        resize="none"
                        :model-value="cellData.value"
                        :readonly="row.locked"
                        :inputmode="column.field?.data_type === 'number' ? 'decimal' : undefined"
                        @update:model-value="setValue(row, column.field!, String($event))"
                        @change="saveField(row, column.field!)"
                      />
                      <el-input
                        v-else
                        :model-value="cellData.value"
                        :readonly="row.locked"
                        :inputmode="column.field?.data_type === 'number' ? 'decimal' : undefined"
                        @update:model-value="setValue(row, column.field!, String($event))"
                        @change="saveField(row, column.field!)"
                      />
                    </template>
                    <span
                      v-else
                      class="cell-field-value"
                      @mouseenter="updateCellTitle($event, cellData.value)"
                      @mouseleave="clearCellTitle"
                    >
                      {{ cellData.value }}
                    </span>
                    <span
                      v-if="cellData.fillPreview !== null"
                      class="grid-fill-preview-value"
                    >
                      {{ cellData.fillPreview || "（空）" }}
                    </span>
                    <span
                      v-if="isGridFillHandleCell(rowIndex, column.fieldIndex ?? -1)"
                      class="grid-fill-handle"
                      role="button"
                      tabindex="-1"
                      aria-label="拖动或双击自动填充"
                      title="拖动序列填充；按住 Ctrl 拖动复制；双击向下自动填充"
                      @pointerdown.stop.prevent="handleGridFillPointerDown"
                    />
                    <span
                      v-if="cellData.error"
                      class="cell-field-error"
                    >
                      {{ cellData.error }}
                    </span>
                    <span
                      v-if="isDraft(row)
                        && column.field?.system_key === 'pathology_number'
                        && cellData.value.trim()"
                      class="cell-save-state is-dirty"
                      title="这条记录尚未写入台账"
                    >
                      未保存
                    </span>
                    <span
                      v-else-if="cellData.saveState"
                      class="cell-save-state"
                      :class="`is-${cellData.saveState?.status}`"
                      :title="cellData.saveState?.message ?? ''"
                    >
                      {{
                        cellData.saveState?.status === 'saving'
                          ? '保存中'
                          : cellData.saveState?.status === 'saved'
                            ? '已保存'
                            : cellData.saveState?.status === 'error'
                              ? '失败'
                              : '未保存'
                      }}
                    </span>
                  </div>
                </template>
              </template>

              <template #empty>
                <el-empty description="当前项目暂无记录" :image-size="64" />
              </template>
            </el-table-v2>
          </template>
        </el-auto-resizer>
      </div>
      <transition name="ledger-overlay-pop">
        <div
          v-if="columnToolsField"
          class="ledger-column-tools-popover"
          :style="{ left: `${columnToolsPosition.left}px`, top: `${columnToolsPosition.top}px` }"
          @pointerdown.stop
          @click.stop
          @contextmenu.prevent
        >
          <div class="ledger-column-tools-title">{{ columnToolsField.label }}</div>
          <div class="ledger-column-tools-sort">
            <el-button size="small" @click="setLedgerSort(columnToolsField, 'ascending')">升序</el-button>
            <el-button size="small" @click="setLedgerSort(columnToolsField, 'descending')">降序</el-button>
            <el-button
              size="small"
              :disabled="ledgerSort?.fieldId !== columnToolsField.id"
              @click="setLedgerSort(columnToolsField, null)"
            >
              取消排序
            </el-button>
          </div>
          <el-button class="ledger-best-fit-button" size="small" @click="bestFitColumn(columnToolsField)">
            当前列最佳宽度
          </el-button>
          <div class="ledger-column-tools-filter-label">筛选</div>
          <el-select
            v-if="columnToolsFilterKind === 'options'"
            v-model="columnToolsDraft.options"
            class="ledger-column-tools-filter-control"
            multiple
            collapse-tags
            collapse-tags-tooltip
            clearable
            placeholder="选择筛选值"
          >
            <el-option
              v-for="option in columnToolOptions"
              :key="option"
              :label="option || '（空白）'"
              :value="option"
            />
          </el-select>
          <el-input
            v-else-if="columnToolsFilterKind === 'text'"
            v-model="columnToolsDraft.text"
            class="ledger-column-tools-filter-control"
            clearable
            placeholder="包含文字"
            @keyup.enter="applyColumnFilter"
          />
          <el-checkbox
            v-if="columnToolsFilterKind === 'text'"
            v-model="columnToolsDraft.emptyOnly"
            class="ledger-column-tools-empty-filter"
          >
            只显示空值
          </el-checkbox>
          <div v-else class="ledger-column-tools-date-range">
            <el-date-picker
              v-model="columnToolsDraft.start"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="开始日期"
            />
            <el-date-picker
              v-model="columnToolsDraft.end"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="结束日期"
            />
          </div>
          <div class="ledger-column-tools-actions">
            <el-button size="small" type="primary" @click="applyColumnFilter">应用筛选</el-button>
            <el-button size="small" @click="clearColumnFilter">清除筛选</el-button>
          </div>
        </div>
      </transition>
      <transition name="ledger-overlay-pop">
        <LedgerContextMenu
          :menu="ledgerContextMenu"
          :can-cut="ledgerContextMenu?.target.kind === 'cell' && hasGridCellSelection && !loading && !gridCutInProgress"
          :can-delete-cells="ledgerContextMenu?.target.kind === 'cell' && hasGridCellSelection"
          :busy="loading"
          :delete-record-count="contextDeleteRecordCount"
          :delete-record-locked="Boolean(contextMenuRow?.locked)"
          v-model:insert-row-count="contextInsertRowCount"
          @cut="contextCut"
          @copy="contextCopy"
          @delete-cells="contextDelete"
          @delete-record="contextDeleteRecord"
          @insert-rows="contextInsertRows"
        />
      </transition>
      <div class="ledger-bottom-bar">
        <div class="project-tab-navigation" aria-label="项目标签滚动">
          <el-button
            text
            :icon="ArrowLeft"
            aria-label="向左滚动项目标签"
            @click="scrollProjectTabs(-1)"
          />
          <el-button
            text
            :icon="ArrowRight"
            aria-label="向右滚动项目标签"
            @click="scrollProjectTabs(1)"
          />
        </div>
        <section ref="projectStripRef" class="project-strip" role="tablist" aria-label="检测项目">
          <button
            v-for="project in appStore.projects"
            :key="project.id"
            class="project-tab"
            :class="{ active: project.id === activeProjectId }"
            type="button"
            role="tab"
            :aria-selected="project.id === activeProjectId"
            :title="project.name"
            @click="selectProject(project.id)"
          >
            <span>{{ project.name }}</span>
          </button>
        </section>
        <div class="ledger-zoom-footer">
          <div v-if="hasGridCellSelection || selectedCount" class="ledger-selection-stats">
            <span v-if="hasGridCellSelection">已选 {{ gridCellSelectionCount }} 个单元格</span>
            <span v-else>已选 {{ selectedCount }} 条记录</span>
            <template v-if="hasGridCellSelection">
              <span>非空 {{ selectedGridStats.nonEmpty }}</span>
              <span v-if="selectedGridStats.numericCount">数字 {{ selectedGridStats.numericCount }}</span>
              <span v-if="selectedGridStats.numericCount">合计 {{ selectedGridStats.sum }}</span>
              <span v-if="selectedGridStats.average !== null">平均 {{ selectedGridStats.average.toFixed(2) }}</span>
              <span v-if="selectedGridStats.min !== null">最小 {{ selectedGridStats.min }}</span>
              <span v-if="selectedGridStats.max !== null">最大 {{ selectedGridStats.max }}</span>
              <span>状态 {{ cellSaveStatusLabels[selectedGridStats.saveStatus] }}</span>
            </template>
          </div>
          <span class="ledger-record-total">{{ ledgerRangeSummary }} · 共 {{ recordTotal }} 条</span>
          <div class="ledger-zoom-control" aria-label="台账缩放">
            <el-button text :icon="Minus" aria-label="缩小台账" :disabled="historyReplayLoading" @click="zoomOut" />
            <el-slider
              v-model="ledgerDisplaySettings.zoomPercent"
              class="ledger-zoom-slider"
              :min="LEDGER_ZOOM_MIN"
              :max="LEDGER_ZOOM_MAX"
              :step="LEDGER_ZOOM_STEP"
              :disabled="historyReplayLoading"
              :show-tooltip="false"
              @change="persistZoomSetting"
            />
            <button
              type="button"
              class="ledger-zoom-value"
              aria-label="重置台账缩放"
              @click="resetZoom"
            >
              {{ ledgerDisplaySettings.zoomPercent }}%
            </button>
            <el-button text :icon="Plus" aria-label="放大台账" :disabled="historyReplayLoading" @click="zoomIn" />
            <el-button text :disabled="historyReplayLoading" @click="resetZoom">重置</el-button>
          </div>
        </div>
      </div>
    </section>
  </div>

  <LedgerTemplateManager
    v-model="templateManagerVisible"
    :selected-project-id="activeProjectId"
  />

  <ProjectFieldManager
    v-model="managerVisible"
    :selected-project-id="activeProjectId"
    @changed="handleManagerChanged"
    @select-project="selectProject"
    @open-templates="templateManagerVisible = true"
  />

  <LedgerReorderDialog
    v-model:visible="reorderDialogVisible"
    v-model:date="reorderDate"
    :preview="reorderPreview"
    :loading="reorderLoading"
    @changed="reorderPreview = null"
    @preview="loadReorderPreview"
    @confirm="confirmReorderByDate"
  />

  <LedgerFindReplaceDialog
    v-model:visible="findReplaceVisible"
    :loading="findReplaceLoading"
    :mode="findReplaceMode"
    v-model:field-id="findReplaceForm.fieldId"
    v-model:find="findReplaceForm.find"
    v-model:replacement="findReplaceForm.replacement"
    v-model:match-mode="findReplaceForm.matchMode"
    v-model:case-sensitive="findReplaceForm.caseSensitive"
    :fields="fields"
    :total-records="tableRows.length"
    :scope-label="findReplaceScopeLabel"
    :scope-count="findReplaceScopeCount"
    :preview="findReplacePreview"
    :match-status="findMatchStatus"
    :match-count="findMatches.length"
    :record-limit="FIND_REPLACE_RECORD_LIMIT"
    :register-input="registerFindReplaceInput"
    @set-mode="setFindReplaceMode"
    @opened="focusFindReplaceInput"
    @closed="restoreFindReplaceGridFocus"
    @enter="handleFindReplaceInputEnter"
    @navigate="navigateFindMatch"
    @preview="runFindReplacePreview"
    @commit="commitFindReplace"
  />

  <LedgerValidationDialog
    :panel="validationPanel"
    :loading="validationCommitLoading"
    @confirm="continueValidationCommit"
    @cancel="cancelValidationPanel"
  />

  <LedgerHighlightDialog
    v-model:visible="highlightDialogVisible"
    :mode="highlightMode"
    :cell-count="highlightCellTargets.length"
    :record-count="highlightTargetIds.length"
    :loading="highlightLoading"
    v-model:color="highlightColor"
    @clear="clearHighlight"
    @submit="submitHighlight(highlightColor)"
  />

</template>

<style scoped>
.ledger-page > .page-card {
  min-width: 0;
  border-color: var(--app-border);
  border-radius: var(--app-radius-card);
  box-shadow: 0 3px 14px rgb(45 42 38 / 3%);
}

.ledger-table-card :deep(.ledger-loading-mask) {
  transition-duration: 60ms;
}

.ledger-column-tools-trigger:focus-visible,
.ledger-zoom-value:focus-visible {
  outline: 2px solid var(--app-primary);
  outline-offset: -2px;
  background: var(--app-primary-soft);
}

/* Dialogs are teleported; scope the palette by the explicit page-specific class. */
:global(.ledger-dialog) {
  --el-border-radius-base: var(--app-radius-control);
  max-width: calc(100vw - 32px);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-dialog);
  background: var(--app-bg);
  box-shadow: 0 20px 60px rgb(45 42 38 / 14%);
  padding: var(--app-space-6);
}

:global(.ledger-dialog .el-dialog__header) {
  margin-bottom: var(--app-space-4);
  padding-bottom: var(--app-space-3);
  border-bottom: 1px solid var(--app-border-light);
}

:global(.ledger-dialog .el-dialog__footer) {
  margin-top: var(--app-space-4);
  border-top: 1px solid var(--app-border-light);
  padding-top: var(--app-space-4);
}

.readonly-cell {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  color: var(--app-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}


.ledger-page {
  --el-border-radius-base: var(--app-radius-control);
  color: var(--app-text);
  display: flex;
  height: calc(100dvh - 68px);
  min-height: 0;
  flex-direction: column;
  gap: var(--app-space-1);
  overflow: hidden;
}

.ledger-page > .page-card:not(.ledger-table-card),
.ledger-page > .selection-bar {
  flex: 0 0 auto;
}

.project-strip {
  display: flex;
  min-width: 80px;
  flex: 1 1 auto;
  align-self: stretch;
  align-items: flex-end;
  gap: var(--app-space-optical);
  border: 0;
  background: transparent;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.project-strip::-webkit-scrollbar {
  display: none;
}

.project-tab {
  position: relative;
  isolation: isolate;
  display: flex;
  min-width: 80px;
  max-width: 200px;
  min-height: 28px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-control) var(--app-radius-control) 0 0;
  color: var(--app-muted);
  background: var(--app-bg);
  padding: var(--app-space-1) var(--app-space-2);
  text-align: center;
  cursor: pointer;
  transition:
    color 160ms ease,
    border-color 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease,
    transform 160ms ease;
  white-space: nowrap;
}

.project-tab::before {
  content: none;
}

.project-tab::after {
  position: absolute;
  top: 0;
  right: 12px;
  left: 12px;
  height: 2px;
  border-radius: var(--app-radius-pill);
  background: var(--app-primary);
  content: "";
  opacity: 0;
}

.project-tab:hover:not(.active) {
  border-color: var(--app-border-strong);
  color: var(--app-primary-text);
  background: var(--app-hover);
  transform: translateY(-1px);
}

.project-tab.active {
  border-color: var(--app-primary-border);
  color: var(--app-primary-hover);
  background: var(--app-primary-soft);
  transform: translateY(-1px);
}

.project-tab.active::before,
.project-tab.active::after {
  opacity: 1;
}

.project-tab:focus-visible {
  outline: 2px solid var(--app-primary);
  outline-offset: 2px;
}

.project-tab span {
  position: relative;
  z-index: 1;
  max-width: 100%;
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1.2;
  text-overflow: ellipsis;
}

.ledger-cell-editor-bar {
  box-sizing: border-box;
  display: flex;
  min-width: 220px;
  height: 32px;
  flex: 1 1 320px;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid var(--app-control-border);
  border-radius: var(--app-radius-control);
  background: var(--app-bg);
  transition: height 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}

.ledger-cell-editor-bar.is-expanded {
  height: 104px;
}

.ledger-cell-editor-bar:focus-within {
  border-color: var(--app-primary);
  box-shadow: 0 0 0 2px var(--app-primary-soft);
}

.ledger-cell-editor-bar.is-readonly {
  background: var(--app-surface-soft);
}

.ledger-cell-editor-address {
  box-sizing: border-box;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--app-border);
  color: var(--app-muted);
  background: var(--app-surface-soft);
  user-select: none;
}

.ledger-cell-editor-bar.is-expanded .ledger-cell-editor-address {
  align-items: flex-start;
  padding-top: var(--app-space-2);
}

.ledger-cell-editor-address {
  width: 52px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.ledger-cell-editor-input {
  min-width: 0;
  height: 100%;
  flex: 1 1 auto;
}

.ledger-cell-editor-bar :deep(.el-textarea__inner),
.ledger-cell-editor-bar :deep(.el-textarea.is-disabled .el-textarea__inner) {
  box-sizing: border-box;
  height: 100% !important;
  min-height: 30px;
  padding: var(--app-space-1) var(--app-space-2);
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  resize: none;
  overflow-x: hidden;
  overflow-y: hidden;
  white-space: pre;
}

.ledger-cell-editor-bar.is-expanded :deep(.el-textarea__inner) {
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ledger-cell-editor-bar :deep(.el-textarea__inner) {
  color: var(--app-text);
  font-family: var(--ledger-font-family, inherit);
  font-size: var(--ledger-font-size, 14px);
  line-height: 20px;
}

.ledger-cell-editor-bar :deep(.el-textarea.is-disabled .el-textarea__inner) {
  color: var(--app-muted);
}

.ledger-cell-editor-toggle {
  display: inline-flex;
  width: 30px;
  height: 100%;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--app-border);
  color: var(--app-muted);
  background: var(--app-surface-soft);
  cursor: pointer;
}

.ledger-cell-editor-toggle:hover {
  color: var(--app-text);
  background: var(--app-hover);
}

.ledger-cell-editor-toggle:focus-visible {
  position: relative;
  outline: 2px solid var(--app-primary);
  outline-offset: -2px;
}

:global(.ledger-toolbar-popover) {
  padding: var(--app-space-2) !important;
}

:global(.ledger-toolbar-popover .ledger-popover-section) {
  display: grid;
  gap: var(--app-space-2);
}

:global(.ledger-toolbar-popover .ledger-popover-section + .ledger-popover-section) {
  margin-top: var(--app-space-2);
  border-top: 1px solid var(--app-border-light);
  padding-top: var(--app-space-2);
}

:global(.ledger-toolbar-popover .ledger-popover-title) {
  color: var(--app-text);
  font-size: 12px;
  font-weight: 700;
}

:global(.ledger-toolbar-popover .ledger-popover-action-grid) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--app-space-2);
}

:global(.ledger-toolbar-popover .ledger-popover-action-grid .el-button) {
  width: 100%;
  justify-content: flex-start;
  margin: 0;
}

:global(.ledger-toolbar-popover .ledger-manage-project-action) {
  grid-column: 1 / -1;
}

:global(.ledger-toolbar-popover .ledger-native-open-options) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--app-space-2);
}

:global(.ledger-toolbar-popover .ledger-native-open-options label) {
  display: grid;
  min-width: 0;
  gap: var(--app-space-1);
  color: var(--app-muted);
  font-size: 12px;
}

:global(.ledger-toolbar-popover .ledger-preview-scope),
:global(.ledger-toolbar-popover .ledger-preview-engine),
:global(.ledger-toolbar-popover .ledger-native-open-button) {
  width: 100%;
}

.ledger-header-label {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: var(--app-space-1);
}

.ledger-column-tools-trigger {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--app-subtle);
  cursor: pointer;
  padding: 0;
}

.ledger-column-tools-trigger:hover,
.ledger-column-tools-trigger.active,
.ledger-column-tools-trigger.sorted,
.ledger-column-tools-trigger.filtered {
  background: var(--app-primary-soft);
  color: var(--app-primary-text);
}

.ledger-column-tools-trigger :deep(.el-icon) {
  font-size: 13px;
}

.ledger-sort-indicator {
  margin-left: -2px;
  color: var(--app-primary-text);
  font-size: 12px;
  font-weight: 700;
}

.ledger-filter-indicator {
  width: 5px;
  height: 5px;
  margin-left: -1px;
  border-radius: 50%;
  background: var(--app-warning);
}

.ledger-column-tools-popover,
.ledger-context-menu,
.grid-fill-preview-popover {
  position: fixed;
  z-index: 3000;
  box-sizing: border-box;
  user-select: none;
}

.grid-fill-preview-popover {
  display: grid;
  max-width: 340px;
  gap: var(--app-space-1);
  border: 1px solid var(--app-primary-mid);
  border-radius: var(--app-radius-control);
  background: var(--app-hover);
  box-shadow: 0 8px 24px rgb(45 42 38 / 10%);
  color: var(--app-primary-hover);
  font-size: 12px;
  line-height: 1.35;
  padding: var(--app-space-2) var(--app-space-2);
  pointer-events: none;
}

.ledger-column-tools-popover {
  width: 330px;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-card);
  background: var(--app-bg);
  box-shadow: 0 8px 26px rgb(45 42 38 / 10%);
  padding: var(--app-space-3);
}

.ledger-column-tools-title {
  margin-bottom: var(--app-space-2);
  color: var(--app-text);
  font-size: 14px;
  font-weight: 600;
}

.ledger-column-tools-sort,
.ledger-column-tools-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--app-space-2);
}

.ledger-column-tools-sort :deep(.el-button + .el-button),
.ledger-column-tools-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.ledger-column-tools-filter-label {
  margin: var(--app-space-3) 0 var(--app-space-2);
  color: var(--app-muted);
  font-size: 12px;
}

.ledger-column-tools-filter-control {
  width: 100%;
}

.ledger-column-tools-empty-filter {
  margin-top: var(--app-space-2);
}

.ledger-column-tools-date-range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--app-space-2);
}

.ledger-column-tools-date-range :deep(.el-date-editor) {
  width: 100%;
}

.ledger-column-tools-actions {
  justify-content: flex-end;
  margin-top: var(--app-space-3);
}

:deep(.search-focus-row > td) {
  background: var(--app-primary-soft) !important;
  transition: background-color 300ms ease;
}

.field-label {
  color: var(--app-muted);
  font-size: 12px;
}

.ledger-toolbar-divider {
  width: 1px;
  height: 20px;
  flex: 0 0 1px;
  background: var(--app-border);
}

.ledger-table-card:focus {
  /* 滚动后的焦点锚点(编程式 focus),不显示焦点环;活动单元格自带高亮。 */
  outline: none;
}

.ledger-table-card {
  display: flex;
  min-height: 0;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.ledger-table-surface {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--ledger-font-family, inherit);
  font-size: var(--ledger-font-size, 14px);
}

.ledger-bottom-bar {
  display: flex;
  min-width: 0;
  min-height: 38px;
  flex: 0 0 38px;
  align-items: flex-end;
  gap: var(--app-space-1);
  border-top: 1px solid var(--app-border);
  background: var(--app-bg);
  padding: var(--app-space-1) var(--app-space-2) 0;
}

.project-tab-navigation {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding-bottom: var(--app-space-optical);
}

.project-tab-navigation > :deep(.el-button) {
  width: 26px;
  height: 26px;
  margin-left: 0;
  padding: 0;
}

.ledger-zoom-footer {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: var(--app-space-2);
  padding-bottom: var(--app-space-optical);
}

.ledger-record-total {
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 24px;
  white-space: nowrap;
}

.ledger-zoom-control {
  display: inline-flex;
  min-width: 260px;
  align-items: center;
  gap: var(--app-space-1);
}

.ledger-zoom-slider {
  width: 110px;
}

.ledger-zoom-value {
  min-width: 42px;
  border: 0;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  font-size: 12px;
  text-align: center;
}

.ledger-zoom-value:hover {
  color: var(--app-primary-text);
}

.row-lock {
  color: var(--app-warning-text);
  font-size: 17px;
}

.cell-field {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--app-space-optical);
}

.grid-fill-handle {
  position: absolute;
  z-index: 4;
  right: 0;
  bottom: 0;
  width: 8px;
  height: 8px;
  box-sizing: border-box;
  border: 0;
  border-radius: 3px;
  background: transparent;
  cursor: crosshair;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
}

.grid-fill-handle::after {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 4px;
  height: 4px;
  border: 1px solid var(--app-bg);
  border-radius: 1px;
  background: var(--app-primary, var(--app-primary));
  content: "";
}

.grid-fill-handle:hover::after {
  box-shadow: 0 0 0 1px rgb(var(--app-primary-rgb) / 35%);
}

.grid-fill-preview-value {
  position: absolute;
  z-index: 3;
  inset: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px dashed var(--app-primary-mid);
  border-radius: 4px;
  background: var(--app-primary-soft);
  color: var(--app-primary-hover);
  font-size: 12px;
  line-height: 1.2;
  padding: 0 var(--app-space-1);
  pointer-events: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-field:not(.cell-field-editing) {
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}

.cell-field-editing {
  cursor: text;
}

.cell-field-value {
  box-sizing: border-box;
  display: block;
  width: var(--ledger-editor-width, 100%);
  min-height: var(--ledger-editor-height, 32px);
  max-height: calc(var(--ledger-editor-height, 32px) + 20px);
  overflow-x: hidden;
  overflow-y: auto;
  padding: max(1px, calc((var(--ledger-editor-height, 32px) - 20px) / 2)) var(--ledger-cell-padding-x, 5px);
  font-family: var(--ledger-font-family, inherit);
  font-size: var(--ledger-font-size, 14px);
  line-height: 20px;
  overflow-wrap: anywhere;
  text-align: center;
  white-space: pre-wrap;
}

.cell-field:not(.cell-field-editing) :deep(*) {
  user-select: none;
  -webkit-user-select: none;
  pointer-events: none;
}

.cell-field:not(.cell-field-editing) > .cell-field-value {
  pointer-events: auto;
}

.cell-field:not(.cell-field-editing) :deep(.el-input),
.cell-field:not(.cell-field-editing) :deep(.el-select),
.cell-field:not(.cell-field-editing) :deep(.editable-date-input) {
  pointer-events: none;
}

.cell-field:not(.cell-field-editing) :deep(.el-input__wrapper),
.cell-field:not(.cell-field-editing) :deep(.el-select__wrapper) {
  background: transparent;
  box-shadow: none;
}

.cell-field:not(.cell-field-editing) > .grid-fill-handle {
  pointer-events: auto;
}

.cell-field-error {
  color: var(--app-danger-text);
  font-size: 11px;
  line-height: 1.3;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}

.cell-field-invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--app-danger) inset;
}

.dialog-note {
  margin: 0 0 var(--app-space-4);
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
}

.cell-save-state {
  position: absolute;
  right: 3px;
  top: 1px;
  z-index: 3;
  color: var(--app-muted);
  font-size: 9px;
  line-height: 12px;
  pointer-events: none;
}

.cell-save-state.is-saving {
  color: var(--app-primary-text);
}

.cell-save-state.is-dirty {
  color: var(--app-warning-text);
  font-weight: 700;
}

.cell-save-state.is-saved {
  color: var(--app-success);
}

.cell-save-state.is-error {
  color: var(--app-danger-text);
  font-weight: 700;
}

.ledger-selection-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--app-space-2);
  color: var(--app-muted);
  font-size: 12px;
}

.two-column-dialog-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--app-space-4);
}

:deep(.ledger-validation-dialog) {
  max-width: calc(100vw - 32px);
}

/* Table V2 renders div-based virtual rows instead of native table elements. */
.ledger-table-surface :deep(.el-auto-resizer),
.ledger-table-surface :deep(.el-table-v2),
.ledger-table-surface :deep(.el-table-v2__root) {
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
}

.ledger-table-surface :deep(.el-table-v2) {
  border: 1px solid var(--app-border);
  font-family: inherit;
  font-size: inherit;
}

.ledger-table-surface :deep(.el-table-v2__main .el-vl__horizontal) {
  display: none;
}

.ledger-table-surface :deep(.el-table-v2__footer) {
  background: var(--app-bg);
}

.ledger-table-horizontal-scrollbar {
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--app-bg);
  opacity: 0;
  transition: opacity 0.34s ease-out;
  scrollbar-color: var(--app-muted) var(--app-surface-soft);
  scrollbar-width: thin;
}

.ledger-table-surface:hover .ledger-table-horizontal-scrollbar,
.ledger-table-surface:focus-within .ledger-table-horizontal-scrollbar {
  opacity: 1;
}

.ledger-table-horizontal-scrollbar::-webkit-scrollbar {
  height: 10px;
}

.ledger-table-horizontal-scrollbar::-webkit-scrollbar-track {
  border-radius: var(--app-radius-pill);
  background: var(--app-surface-soft);
}

.ledger-table-horizontal-scrollbar::-webkit-scrollbar-thumb {
  border: 2px solid var(--app-surface-soft);
  border-radius: var(--app-radius-pill);
  background: var(--app-muted);
}

.ledger-table-horizontal-scrollbar::-webkit-scrollbar-thumb:hover {
  background: var(--app-primary);
}

.ledger-table-horizontal-scrollbar-content {
  height: 1px;
  pointer-events: none;
}

.ledger-table-surface :deep(.el-table-v2__header-cell),
.ledger-table-surface :deep(.el-table-v2__row-cell) {
  box-sizing: border-box;
  border-right: 1px solid var(--app-border);
  border-bottom: 1px solid var(--app-border);
  padding: 0;
}

.ledger-table-surface :deep(.el-table-v2__header-row),
.ledger-table-surface :deep(.el-table-v2__row) {
  border-bottom: 0;
}

.ledger-table-surface :deep(.el-table-v2__header-cell) {
  justify-content: center;
  overflow: hidden;
  background: var(--app-surface-soft);
  color: var(--app-muted);
  text-align: center;
  user-select: none;
}

.ledger-table-surface :deep(.el-table-v2__row-cell) {
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--app-card);
  transition: background-color 150ms ease;
}

.ledger-table-surface :deep(.el-table-v2__left) {
  box-shadow: none;
}

.ledger-table-surface :deep(.el-table-v2__row.locked-row .el-table-v2__row-cell) {
  background: var(--app-bg);
}

.ledger-table-surface :deep(.el-table-v2__row.draft-row .el-table-v2__row-cell) {
  background: var(--app-hover);
}

.ledger-table-surface :deep(.el-table-v2__row:hover .el-table-v2__row-cell),
.ledger-table-surface :deep(.el-table-v2__row.is-hovered .el-table-v2__row-cell) {
  background: var(--app-hover);
}

.ledger-table-surface :deep(.el-table-v2__row.highlighted-row .el-table-v2__row-cell) {
  background-color: var(--record-highlight-color) !important;
}

.ledger-table-surface :deep(.el-table-v2__row.search-focus-row .el-table-v2__row-cell) {
  background: var(--app-primary-soft) !important;
  transition: background-color 300ms ease;
}

.ledger-table-surface :deep(.el-table-v2__row-cell.cell-highlighted) {
  background-color: var(--cell-highlight-color) !important;
}

.ledger-table-surface :deep(.el-table-v2__row-cell.grid-cell-selected) {
  background: var(--app-primary-soft) !important;
  box-shadow: inset 0 0 0 1px var(--app-primary-mid);
}

.ledger-table-surface :deep(.el-table-v2__row-cell.grid-cell-active),
.ledger-table-surface :deep(.el-table-v2__row-cell.grid-cell-editing) {
  box-shadow: inset 0 0 0 2px var(--app-primary);
}

.ledger-table-surface :deep(.el-table-v2__row-cell.grid-cell-search-current) {
  background: var(--app-primary-soft) !important;
  box-shadow: inset 0 0 0 2px var(--app-primary) !important;
}

.ledger-table-surface :deep(.el-table-v2__row-cell.grid-cell-editing) {
  background: var(--app-cell-editing-bg) !important;
}

.ledger-table-surface :deep(.el-table-v2__row-cell.grid-cell-fill-preview) {
  background: var(--app-primary-border) !important;
  box-shadow: inset 0 0 0 1px var(--app-primary-mid);
}

.ledger-table-surface :deep(.el-table-v2__header-cell.grid-header-selected) {
  background: var(--app-primary-soft) !important;
  box-shadow: inset 0 -2px 0 var(--app-primary);
}

.ledger-table-surface :deep(.el-table-v2__header-cell.grid-header-partial) {
  background: var(--app-hover) !important;
  box-shadow: inset 0 -2px 0 var(--app-primary-mid);
}

.ledger-table-surface :deep(.ledger-editor-column > .cell-field) {
  width: var(--ledger-editor-width, 100%);
  max-width: 100%;
  height: var(--ledger-editor-height, 32px);
  min-height: 0;
  justify-content: center;
  overflow: hidden;
}

.ledger-table-surface :deep(.ledger-editor-column .el-input),
.ledger-table-surface :deep(.ledger-editor-column .el-textarea),
.ledger-table-surface :deep(.ledger-editor-column .el-select),
.ledger-table-surface :deep(.ledger-editor-column .editable-date-input) {
  width: var(--ledger-editor-width, 100%);
  max-width: 100%;
  height: var(--ledger-editor-height, 32px);
  min-height: 0;
}

.ledger-table-surface :deep(.ledger-editor-column .el-input__wrapper),
.ledger-table-surface :deep(.ledger-editor-column .el-select__wrapper),
.ledger-table-surface :deep(.ledger-editor-column .el-textarea__inner) {
  height: var(--ledger-editor-height, 32px);
  min-height: var(--ledger-editor-height, 32px) !important;
  padding-right: var(--ledger-cell-padding-x, 5px);
  padding-left: var(--ledger-cell-padding-x, 5px);
  font-family: var(--ledger-font-family, inherit);
  font-size: var(--ledger-font-size, 14px);
  text-align: center;
}

.ledger-table-surface :deep(.cell-field-value) {
  height: var(--ledger-editor-height, 32px);
  min-height: 0;
  max-height: var(--ledger-editor-height, 32px);
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (prefers-reduced-motion: reduce) {
  .ledger-table-surface :deep(.el-table-v2__row-cell) { transition: none; }
}

.ledger-v2-selection-control {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
}

.ledger-table-surface :deep(.record-selection-dragging) {
  user-select: none;
}

.ledger-table-surface :deep(.record-selection-dragging .ledger-v2-selection-control),
.ledger-table-surface :deep(.record-selection-dragging .ledger-v2-selection-control .el-checkbox) {
  cursor: grabbing;
}

.ledger-table-surface :deep(.ledger-v2-selection-control .el-checkbox) {
  display: inline-flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  margin: 0;
}

.ledger-v2-lock-state {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
}

.ledger-table-surface :deep(.ledger-v2-selection-control .el-checkbox__inner) {
  width: 20px;
  height: 20px;
}

.ledger-table-surface :deep(.grid-fill-handle) {
  right: 0;
  bottom: 0;
}

@media (max-width: 1200px) {
  .ledger-bottom-bar {
    flex-wrap: wrap;
    flex-basis: auto;
  }

  .ledger-zoom-footer {
    flex: 1 0 100%;
    overflow-x: auto;
    justify-content: flex-start;
    padding: var(--app-space-1) var(--app-space-optical);
  }

  .ledger-zoom-footer > * {
    flex-shrink: 0;
  }
}

@media (max-width: 680px) {
  .two-column-dialog-form {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .project-tab,
  .highlight-color-swatch {
    transition: none;
  }
}
</style>

