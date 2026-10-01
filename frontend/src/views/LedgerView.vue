<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Brush,
  Trash2 as Delete,
  Download,
  Lock,
  Minus,
  Plus,
  Settings2 as Setting,
  LockOpen as Unlock,
  Undo2,
  Redo2,
  Check,
} from "@lucide/vue";
import {
  ElMessage,
  ElMessageBox,
  TableV2FixedDir,
  type Column,
  type TableV2Instance,
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
  getNativePreviewStatus,
  getPreviewCapabilities,
  type LedgerPreviewScope,
} from "@/api/preview";
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
  createRecord,
  deleteRecord,
  getRecordsByIds,
  commitCellBatch,
  commitReplace,
  previewCellBatch,
  previewReplace,
  FIND_REPLACE_RECORD_LIMIT,
  previewReorderByDate,
  applyReorderByDate,
  queryRecordIds,
  queryRecords,
  setRecordLock,
  setCellsHighlight,
  setRecordsHighlight,
  setRecordsReportGenerated,
  updateRecord,
  validateNewRecord,
} from "@/api/records";
import EditableChoiceInput from "@/components/EditableChoiceInput.vue";
import EditableDateInput from "@/components/EditableDateInput.vue";
import LedgerTemplateManager from "@/components/LedgerTemplateManager.vue";
import ProjectFieldManager from "@/components/ProjectFieldManager.vue";
import { updateField } from "@/api/projects";
import { useAppStore } from "@/stores/app";
import {
  cloneLedgerRecord,
  createLedgerCellHistoryEntry,
  createLedgerHistoryEntry,
  useLedgerHistory,
  type LedgerHistoryEntry,
} from "@/composables/useLedgerHistory";
import type {
  FieldDefinition,
  ProjectRecord,
  RecordStatus,
  RecordUpdateInput,
  NativePreviewTask,
  PreviewCapabilities,
  PrintEngine,
  RecordCellBatchCommitResult,
  RecordBatchNewRecord,
  RecordCellChange,
  RecordComplexQuery,
  RecordCreateInput,
  RecordFieldFilter,
  RecordReplacePreview,
  RecordReorderByDatePreview,
  RecordValidationIssue,
} from "@/types/api";
import type {
  QuickEntryChangedPayload,
  QuickEntryProjectChange,
} from "@/types/electron";
import {
  buildGridFillEntries,
  normalizeDate,
  type GridFillMode,
} from "@/utils/ledgerFill";
import {
  gridAutoScrollVector,
  nextGridScrollOffset,
  type GridAutoScrollDirection,
} from "@/utils/gridAutoScroll";
import {
  calculateLedgerBestFitWidth,
  LEDGER_COLUMN_MAX_WIDTH,
  LEDGER_COLUMN_MIN_WIDTH,
  ledgerCellHorizontalPadding,
} from "@/utils/ledgerColumnWidth";
import { shanghaiDateKey } from "@/utils/datetime";
import { desktopBridge } from "@/utils/desktop";
import { registerWindowCloseGuard } from "@/utils/windowCloseGuard";
import {
  LEDGER_GRID_CLIPBOARD_MIME,
  buildLedgerGridClipboardData,
  expandLedgerSingleCellPaste,
  parseLedgerGridClipboardPayload,
  type LedgerGridClipboardCell as GridClipboardCell,
  type LedgerGridClipboardPayload as GridClipboardPayload,
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
  resolveCreatedRecordRefreshPlan,
  resolveLedgerCellCompletionAction,
  resolveLedgerCellEditState,
  shouldApplyLedgerEditCompletion,
} from "@/utils/ledgerPersistence";
import {
  buildValidationPromptCopy,
  isValidationSnapshotCurrent,
} from "@/utils/validationPrompt";
import {
  applyLedgerTableView,
  reanchorInsertedDraftGroup,
  type LedgerDraftPlacement,
  type LedgerFieldFilter,
  type LedgerFilterMap,
  type LedgerInsertedGroupRegistry,
  type LedgerRow,
  type LedgerSortState,
} from "@/utils/ledgerTableView";
import { getRecordFieldValue as valueFor } from "@/utils/recordFieldValue";
import { summarizeLedgerSelection } from "@/utils/ledgerSelectionStats";
import {
  LedgerRecordCache,
  ledgerRecordQueryKey,
} from "@/utils/ledgerRecordCache";
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

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const ledgerHistory = useLedgerHistory();
const canUndoHistory = ledgerHistory.canUndo;
const canRedoHistory = ledgerHistory.canRedo;
const historyBusy = ledgerHistory.busy;

const activeProjectId = ref("");
const records = ref<ProjectRecord[]>([]);
const selectedRecords = ref<ProjectRecord[]>([]);
const ledgerDisplaySettings = ref<LedgerDisplaySettings>({
  ...DEFAULT_LEDGER_DISPLAY_SETTINGS,
});
const ledgerTableCardRef = ref<HTMLElement | null>(null);
const projectStripRef = ref<HTMLElement | null>(null);
const tableRef = ref<TableV2Instance | null>(null);
const ledgerHorizontalScrollbarRef = ref<HTMLElement | null>(null);
const LEDGER_HORIZONTAL_SCROLLBAR_HEIGHT = 10;
type AutosizeTextareaInstance = { resizeTextarea: () => void };
const autosizeTextareaRefs = new Map<string, AutosizeTextareaInstance>();
type GridCellPosition = { rowIndex: number; columnIndex: number };
type GridCellRange = { anchor: GridCellPosition; focus: GridCellPosition };
type NormalizedGridRange = {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
};
type GridCellEditSnapshot = { rowId: string; fieldId: string; value: string };
type GridClipboardSelection = { positions: GridCellPosition[]; active: GridCellPosition };
type GridCutSnapshot = {
  projectId: string;
  projectGeneration: number;
  cells: Array<GridCellEditSnapshot & { version: number }>;
};
type GridCellDragMode = "replace" | "shift" | "add";
type GridPasteEntry = GridClipboardCell;
type GridCellDragState = {
  pointerId: number;
  anchor: GridCellPosition;
  focus: GridCellPosition;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  mode: GridCellDragMode;
  initialSelectionKeys: Set<string>;
  tableElement: HTMLElement;
  lastAppliedFocus: GridCellPosition | null;
  horizontalScrollDirection: GridAutoScrollDirection;
  verticalScrollDirection: GridAutoScrollDirection;
};
type GridFillDragState = {
  pointerId: number;
  source: NormalizedGridRange;
  target: NormalizedGridRange;
  mode: GridFillMode;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  tableElement: HTMLElement;
  finishPromise: Promise<boolean>;
};
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
const activeGridCell = ref<GridCellPosition | null>(null);
const gridCellRange = ref<GridCellRange | null>(null);
const selectedGridCellKeys = ref<Set<string>>(new Set());
const gridSelectionAnchor = ref<GridCellPosition | null>(null);
const editingGridCell = ref<GridCellPosition | null>(null);
const editingGridSnapshot = ref<GridCellEditSnapshot | null>(null);
const gridSelectionDragging = ref(false);
let gridCellDragState: GridCellDragState | null = null;
let gridCellDragFrame: number | null = null;
let pendingGridCell: GridCellPosition | null = null;
let gridCellAutoScrollFrame: number | null = null;
let gridCellAutoScrollTimestamp: number | null = null;
let gridCellWheelUpdateTimer: number | null = null;
let gridCellEditFinishPromise: Promise<boolean> | null = null;
let gridCellEditSession = 0;
let lastGridClipboard: { plainText: string; payload: GridClipboardPayload } | null = null;
const gridCutInProgress = ref(false);
let suppressGridClick = false;
let gridFillDragState: GridFillDragState | null = null;
const gridFillPreviewRange = ref<NormalizedGridRange | null>(null);
const gridFillPreviewSource = ref<NormalizedGridRange | null>(null);
const gridFillPreviewValues = ref(new Map<string, string>());
const gridFillPreviewSummary = ref("");
const gridFillPreviewPointer = reactive({ left: 0, top: 0 });
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
const loading = ref(false);
const historyReplayLoading = ref(false);
const savingIds = ref(new Set<string>());
const closeSaving = ref(false);
const preparingClose = ref(false);
const quickEntryRefreshInProgress = ref(false);
type CellSaveStatus = "dirty" | "saving" | "saved" | "error";
type CellSaveState = { status: CellSaveStatus; message?: string };
type ValidationCellRollbackSnapshot = {
  key: string;
  recordId: string;
  fieldId: string;
  beforeValue: string;
  previousSaveState: CellSaveState | null;
  previousFieldError: string | null;
};
const cellSaveStatusLabels: Record<CellSaveStatus | "idle", string> = {
  dirty: "未保存",
  saving: "保存中",
  saved: "已保存",
  error: "失败",
  idle: "无改动",
};
const cellSaveStates = ref(new Map<string, CellSaveState>());
const cellSaveVersions = new Map<string, number>();
const cellSaveClearTimers = new Map<string, number>();
const cellSaveInFlightCounts = new Map<string, number>();
const recordSaveQueues = new Map<string, Promise<unknown>>();
const fieldErrors = ref<Record<string, string>>({});
const managerVisible = ref(false);
const templateManagerVisible = ref(false);
const ledgerLayoutSettings = ref<LedgerLayoutSettingsDocument>(
  normalizeLedgerLayoutSettings(null),
);
const columnWidthSaveQueues = new Map<string, LatestValuePersistence<number>>();
const findReplaceVisible = ref(false);
const findReplaceLoading = ref(false);
const findReplacePreview = ref<RecordReplacePreview | null>(null);
const findReplaceScopeCount = ref<number | null>(null);
const findReplaceScopeLabel = ref("");
const findReplaceForm = reactive({
  fieldId: "",
  find: "",
  replacement: "",
  matchMode: "substring" as "substring" | "whole",
  caseSensitive: false,
});
type ValidationPanelState = {
  token: string;
  projectId: string;
  title: string;
  label: string;
  outcomeText: string;
  cancelText: string;
  continueText: string;
  issues: RecordValidationIssue[];
  affectedCount: number;
  skippedLocked: number;
  cellKeys: string[];
  cellVersions: Record<string, number>;
  canContinue: boolean;
};
const validationPanel = ref<ValidationPanelState | null>(null);
const validationCommitLoading = ref(false);
let pendingValidationAction: (() => Promise<void>) | null = null;
let pendingValidationCancel: (() => void) | null = null;
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
const focusRecordId = ref("");
const highlightDialogVisible = ref(false);
const highlightLoading = ref(false);
const highlightColor = ref("#fff2cc");
const highlightTargetIds = ref<string[]>([]);
type HighlightMode = "record" | "cell";
type CellHighlightTarget = { recordId: string; fieldId: string };
const highlightMode = ref<HighlightMode>("record");
const highlightCellTargets = ref<CellHighlightTarget[]>([]);
type HighlightColorOption = { label: string; color: string };

const highlightThemeRows: HighlightColorOption[][] = [
  [
    { label: "白色", color: "#FFFFFF" },
    { label: "黑色", color: "#000000" },
    { label: "浅灰", color: "#E7E6E6" },
    { label: "深蓝灰", color: "#44546A" },
    { label: "蓝色", color: "#4472C4" },
    { label: "橙色", color: "#ED7D31" },
    { label: "灰色", color: "#A5A5A5" },
    { label: "黄色", color: "#FFC000" },
    { label: "浅蓝", color: "#5B9BD5" },
    { label: "绿色", color: "#70AD47" },
  ],
  [
    { label: "白色 80%", color: "#F2F2F2" },
    { label: "黑色 50%", color: "#7F7F7F" },
    { label: "浅灰蓝 80%", color: "#D9E1F2" },
    { label: "深蓝灰 80%", color: "#D6E4F0" },
    { label: "蓝色 80%", color: "#D9E2F3" },
    { label: "橙色 80%", color: "#FCE4D6" },
    { label: "灰色 80%", color: "#EDEDED" },
    { label: "黄色 80%", color: "#FFF2CC" },
    { label: "浅蓝 80%", color: "#DDEBF7" },
    { label: "绿色 80%", color: "#E2F0D9" },
  ],
  [
    { label: "白色 60%", color: "#E7E6E6" },
    { label: "黑色 35%", color: "#595959" },
    { label: "浅灰蓝 60%", color: "#B4C6E7" },
    { label: "深蓝灰 60%", color: "#B4C6E7" },
    { label: "蓝色 60%", color: "#B4C6E7" },
    { label: "橙色 60%", color: "#F8CBAD" },
    { label: "灰色 60%", color: "#D9D9D9" },
    { label: "黄色 60%", color: "#FFE699" },
    { label: "浅蓝 60%", color: "#BDD7EE" },
    { label: "绿色 60%", color: "#C6E0B4" },
  ],
  [
    { label: "白色 40%", color: "#D9D9D9" },
    { label: "黑色 25%", color: "#404040" },
    { label: "浅灰蓝 40%", color: "#8EA9DB" },
    { label: "深蓝灰 40%", color: "#8EA9DB" },
    { label: "蓝色 40%", color: "#8EA9DB" },
    { label: "橙色 40%", color: "#F4B183" },
    { label: "灰色 40%", color: "#A6A6A6" },
    { label: "黄色 40%", color: "#FFD966" },
    { label: "浅蓝 40%", color: "#9DC3E6" },
    { label: "绿色 40%", color: "#A9D18E" },
  ],
  [
    { label: "白色 20%", color: "#BFBFBF" },
    { label: "黑色 15%", color: "#262626" },
    { label: "浅灰蓝 20%", color: "#5B9BD5" },
    { label: "深蓝灰 20%", color: "#5B9BD5" },
    { label: "蓝色 20%", color: "#4472C4" },
    { label: "橙色 20%", color: "#C65911" },
    { label: "灰色 20%", color: "#7F7F7F" },
    { label: "黄色 20%", color: "#BF9000" },
    { label: "浅蓝 20%", color: "#2F75B5" },
    { label: "绿色 20%", color: "#548235" },
  ],
  [
    { label: "白色 0%", color: "#7F7F7F" },
    { label: "黑色", color: "#000000" },
    { label: "浅灰蓝", color: "#44546A" },
    { label: "深蓝灰", color: "#2F5597" },
    { label: "蓝色", color: "#2F5597" },
    { label: "橙色", color: "#843C0C" },
    { label: "灰色", color: "#595959" },
    { label: "黄色", color: "#806000" },
    { label: "浅蓝", color: "#1F4E79" },
    { label: "绿色", color: "#375623" },
  ],
];

const highlightStandardColors: HighlightColorOption[] = [
  { label: "深红", color: "#C00000" },
  { label: "红色", color: "#FF0000" },
  { label: "橙色", color: "#FFC000" },
  { label: "黄色", color: "#FFFF00" },
  { label: "浅绿", color: "#92D050" },
  { label: "绿色", color: "#00B050" },
  { label: "青色", color: "#00B0F0" },
  { label: "蓝色", color: "#0070C0" },
  { label: "深蓝", color: "#002060" },
  { label: "紫色", color: "#7030A0" },
];

const highlightPalette = [
  ...new Set(
    [...highlightThemeRows.flat(), ...highlightStandardColors].map(({ color }) => color),
  ),
];
const persistedValues = new Map<string, string>();
const insertedGroupRegistry: LedgerInsertedGroupRegistry = new Map();
const LEDGER_RECORD_CACHE_MAX_RECORDS = 10_000;
let draftSequence = 0;
let loadSequence = 0;
let recordsAbortController: AbortController | null = null;
const ledgerRecordCache = new LedgerRecordCache({ maxEntries: 2 });
const projectRecordCacheGenerations = new Map<string, number>();
let ledgerDisposed = false;
let removeQuickEntryChangedListener: (() => void) | undefined;
let quickEntryRefreshPromise: Promise<void> = Promise.resolve();
const loadBatchSize = computed(() => ledgerDisplaySettings.value.loadBatchSize);
const recordTotal = ref(0);
const loadedRecordCount = ref(0);
const selectedRecordIds = ref(new Set<string>());
const selectedRecordCache = new Map<string, ProjectRecord>();
const recordSelectionScope = ref<RecordSelectionScope>("all");
let ledgerInitialized = false;
let projectViewGeneration = 0;
let projectLoadPromise: Promise<void> | null = null;
let ledgerLayoutSaveQueue: Promise<void> = Promise.resolve();

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
    console.error("快速录入变更确认失败", error);
  }
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
  let currentProjectLoaded = true;
  if (currentChange) {
    currentProjectLoaded = await loadRecords(currentChange.projectId, {
      showLoading: false,
      preserveHistory: true,
      preserveSelection: true,
    });
  }
  if (ledgerDisposed) return;
  const acknowledged = [...latestByProject.values()].filter((change) => (
    change.projectId !== activeProjectId.value || currentProjectLoaded
  ));
  await acknowledgeQuickEntryChanges(acknowledged);
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
    console.error("快速录入变更刷新失败", error);
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
    console.error("读取快速录入待刷新项目失败", error);
  }
}

function handleLedgerWindowFocus(): void {
  if (preparingClose.value) return;
  void requestPendingQuickEntryChanges();
}

const currentProject = computed(() => appStore.projectById(activeProjectId.value));
// Keep the table schema on the previous project while the next project's
// records are loading.  This prevents Element Plus from laying out a new
// column set against the old rows and then laying it out again after the API
// response arrives.
const tableProjectId = ref("");
const tableProject = computed(() => appStore.projectById(tableProjectId.value));
const fields = computed(() =>
  (tableProject.value?.fields ?? [])
    .filter((field) => !field.hidden)
    .slice()
    .sort((left, right) => left.sort_order - right.sort_order),
);
type LedgerVirtualColumnKind = "selection" | "lock" | "field";
type LedgerVirtualColumn = Column<unknown> & {
  kind: LedgerVirtualColumnKind;
  fieldId?: string;
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
const baseTableRows = computed<LedgerRow[]>(() => [...records.value, ...draftRows.value]);
const tableRows = computed<LedgerRow[]>(() =>
  applyLedgerTableView(baseTableRows.value, fields.value, ledgerSort.value, ledgerFilters.value),
);
const tableRowIndexById = computed(
  () => new Map(tableRows.value.map((row, index) => [row.id, index] as const)),
);
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
  () => fields.value.find((field) => field.id === columnToolsOpenFieldId.value) ?? null,
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
const contextMenuStyle = computed<CSSProperties>(() => ({
  left: `${ledgerContextMenu.value?.x ?? 0}px`,
  top: `${ledgerContextMenu.value?.y ?? 0}px`,
}));
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
function isDraft(record: LedgerRow): boolean {
  return record._draft === true;
}

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

function closeLedgerOverlays(): void {
  closeColumnTools();
  closeLedgerContextMenu();
}

function captureGridIdentity(position: GridCellPosition | null): { rowId: string; fieldId: string } | null {
  if (!position) return null;
  const row = tableRows.value[position.rowIndex];
  const field = fields.value[position.columnIndex];
  return row && field ? { rowId: row.id, fieldId: field.id } : null;
}

function restoreGridIdentity(identity: { rowId: string; fieldId: string } | null): GridCellPosition | null {
  if (!identity) return null;
  const rowIndex = tableRowIndexById.value.get(identity.rowId) ?? -1;
  const columnIndex = fields.value.findIndex((field) => field.id === identity.fieldId);
  return rowIndex >= 0 && columnIndex >= 0 ? { rowIndex, columnIndex } : null;
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

function handleLedgerTableScroll(position: { scrollLeft?: number }): void {
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
  if (!draftRows.value.length) {
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

function clampGridCell(position: GridCellPosition): GridCellPosition {
  return {
    rowIndex: Math.max(0, Math.min(tableRows.value.length - 1, position.rowIndex)),
    columnIndex: Math.max(0, Math.min(fields.value.length - 1, position.columnIndex)),
  };
}

function moveGridCell(position: GridCellPosition, rowDelta: number, columnDelta: number): GridCellPosition {
  return clampGridCell({
    rowIndex: position.rowIndex + rowDelta,
    columnIndex: position.columnIndex + columnDelta,
  });
}

function moveGridCellByTab(position: GridCellPosition, backwards: boolean): GridCellPosition {
  const columnCount = fields.value.length;
  const rowCount = tableRows.value.length;
  if (!columnCount || !rowCount) return clampGridCell(position);
  const lastIndex = rowCount * columnCount - 1;
  const currentIndex = position.rowIndex * columnCount + position.columnIndex;
  const nextIndex = Math.max(0, Math.min(lastIndex, currentIndex + (backwards ? -1 : 1)));
  return {
    rowIndex: Math.floor(nextIndex / columnCount),
    columnIndex: nextIndex % columnCount,
  };
}

function normalizedGridRange(range: GridCellRange): NormalizedGridRange {
  return {
    rowStart: Math.min(range.anchor.rowIndex, range.focus.rowIndex),
    rowEnd: Math.max(range.anchor.rowIndex, range.focus.rowIndex),
    columnStart: Math.min(range.anchor.columnIndex, range.focus.columnIndex),
    columnEnd: Math.max(range.anchor.columnIndex, range.focus.columnIndex),
  };
}

const GRID_CELL_KEY_SEPARATOR = "\u0000";

function gridCellKey(position: GridCellPosition): string {
  const row = tableRows.value[position.rowIndex];
  const field = fields.value[position.columnIndex];
  return row && field ? `${row.id}${GRID_CELL_KEY_SEPARATOR}${field.id}` : "";
}

function gridCellPositionsForRange(range: GridCellRange): GridCellPosition[] {
  const normalized = normalizedGridRange(range);
  const positions: GridCellPosition[] = [];
  for (let rowIndex = normalized.rowStart; rowIndex <= normalized.rowEnd; rowIndex += 1) {
    for (
      let columnIndex = normalized.columnStart;
      columnIndex <= normalized.columnEnd;
      columnIndex += 1
    ) {
      if (gridCellKey({ rowIndex, columnIndex })) positions.push({ rowIndex, columnIndex });
    }
  }
  return positions;
}

function selectedGridCellPositions(): GridCellPosition[] {
  const selectedKeys = selectedGridCellKeys.value;
  if (!selectedKeys.size) return [];
  const positions: GridCellPosition[] = [];
  for (let rowIndex = 0; rowIndex < tableRows.value.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < fields.value.length; columnIndex += 1) {
      if (selectedKeys.has(gridCellKey({ rowIndex, columnIndex }))) {
        positions.push({ rowIndex, columnIndex });
      }
    }
  }
  return positions;
}

function isGridCellSelected(position: GridCellPosition): boolean {
  const range = gridCellRange.value;
  if (range) {
    const normalized = normalizedGridRange(range);
    return (
      position.rowIndex >= normalized.rowStart &&
      position.rowIndex <= normalized.rowEnd &&
      position.columnIndex >= normalized.columnStart &&
      position.columnIndex <= normalized.columnEnd
    );
  }
  const key = gridCellKey(position);
  return Boolean(key && selectedGridCellKeys.value.has(key));
}

function replaceGridCellSelection(
  positions: GridCellPosition[],
  active: GridCellPosition,
  anchor: GridCellPosition = active,
  range: GridCellRange | null = null,
): void {
  const keys = new Set(positions.map(gridCellKey).filter(Boolean));
  selectedGridCellKeys.value = keys;
  activeGridCell.value = clampGridCell(active);
  gridSelectionAnchor.value = clampGridCell(anchor);
  gridCellRange.value = range
    ? {
        anchor: { ...range.anchor },
        focus: { ...range.focus },
      }
    : null;
}

function toggleGridCell(position: GridCellPosition): void {
  const nextPosition = clampGridCell(position);
  const key = gridCellKey(nextPosition);
  if (!key) return;
  const keys = new Set(selectedGridCellKeys.value);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  selectedGridCellKeys.value = keys;
  activeGridCell.value = nextPosition;
  if (!gridSelectionAnchor.value) gridSelectionAnchor.value = nextPosition;
  gridCellRange.value = null;
}

function clearGridCellSelection(): void {
  selectedGridCellKeys.value = new Set();
  gridCellRange.value = null;
  gridSelectionAnchor.value = null;
}

function clearGridCellEdit(invalidateSession = true): void {
  editingGridCell.value = null;
  editingGridSnapshot.value = null;
  if (invalidateSession) gridCellEditSession += 1;
}

function sameGridCell(left: GridCellPosition | null, right: GridCellPosition | null): boolean {
  return Boolean(
    left &&
      right &&
      left.rowIndex === right.rowIndex &&
      left.columnIndex === right.columnIndex,
  );
}

function isGridCellEditing(position: GridCellPosition | null): boolean {
  return sameGridCell(editingGridCell.value, position);
}

function selectGridCell(position: GridCellPosition): void {
  const nextPosition = clampGridCell(position);
  replaceGridCellSelection(
    [nextPosition],
    nextPosition,
    nextPosition,
    { anchor: { ...nextPosition }, focus: { ...nextPosition } },
  );
}

function virtualColumnField(column: LedgerVirtualColumn): FieldDefinition | undefined {
  if (column.kind !== "field" || !column.fieldId) return undefined;
  return fields.value.find((field) => field.id === column.fieldId);
}

function gridColumnPositions(fieldIndex: number): GridCellPosition[] {
  if (fieldIndex < 0 || fieldIndex >= fields.value.length) return [];
  return tableRows.value.map((_, rowIndex) => ({ rowIndex, columnIndex: fieldIndex }));
}

const gridHeaderSelectionState = computed(() => {
  const states = new Map<string, "selected" | "partial">();
  const currentRows = tableRows.value;
  if (!currentRows.length) return states;

  for (const field of fields.value) {
    let selectedCount = 0;
    for (const row of currentRows) {
      if (selectedGridCellKeys.value.has(`${row.id}${GRID_CELL_KEY_SEPARATOR}${field.id}`)) {
        selectedCount += 1;
      }
    }
    if (selectedCount === currentRows.length) states.set(field.id, "selected");
    else if (selectedCount > 0) states.set(field.id, "partial");
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

function gridEditorRoot(position: GridCellPosition): HTMLElement | null {
  const root = ledgerTableCardRef.value;
  if (!root) return null;
  const rowId = tableRows.value[position.rowIndex]?.id;
  if (!rowId) return null;
  const fieldIndex = String(position.columnIndex);
  return (
    [...root.querySelectorAll<HTMLElement>("[data-row-id][data-field-index]")].find(
      (element) =>
        element.dataset.rowId === rowId && element.dataset.fieldIndex === fieldIndex,
    ) ?? null
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

async function focusGridCell(position: GridCellPosition): Promise<void> {
  if (!tableRows.value.length || !fields.value.length) return;
  const nextPosition = clampGridCell(position);
  activeGridCell.value = nextPosition;
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
    editor?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    const field = fields.value.find((item) => item.id === snapshot.fieldId);
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
  activeGridCell.value = cell;
  if (!suppressGridFocusReset && !isGridCellEditing(cell)) {
    if (!isGridCellSelected(cell)) selectGridCell(cell);
    if (event.target === gridEditorRoot(cell)) void focusGridCell(cell);
  }
}

function stopGridCellDrag(resetClickSuppression = true): void {
  clearGridCellAutoScroll();
  clearGridCellDragFrame();
  clearGridCellWheelUpdate();
  document.removeEventListener("pointermove", handleGridPointerMove);
  document.removeEventListener("pointerup", handleGridPointerUp, true);
  document.removeEventListener("pointercancel", handleGridPointerCancel, true);
  document.removeEventListener("wheel", handleGridWheelDuringDrag);
  gridCellDragState = null;
  gridSelectionDragging.value = false;
  if (resetClickSuppression) {
    window.setTimeout(() => {
      suppressGridClick = false;
    }, 0);
  }
}

function clearGridCellDragFrame(): void {
  if (gridCellDragFrame !== null) window.cancelAnimationFrame(gridCellDragFrame);
  gridCellDragFrame = null;
  pendingGridCell = null;
}

function flushGridCellDragFrame(): void {
  if (gridCellDragFrame !== null) window.cancelAnimationFrame(gridCellDragFrame);
  gridCellDragFrame = null;
  const cell = pendingGridCell;
  pendingGridCell = null;
  if (cell) updateGridCellDrag(cell);
}

function materializeGridCellRangeSelection(): void {
  const range = gridCellRange.value;
  if (!range) return;
  selectedGridCellKeys.value = new Set(
    gridCellPositionsForRange(range).map(gridCellKey).filter(Boolean),
  );
}

function scheduleGridCellDragUpdate(cell: GridCellPosition): void {
  pendingGridCell = cell;
  if (gridCellDragFrame !== null) return;
  gridCellDragFrame = window.requestAnimationFrame(() => {
    gridCellDragFrame = null;
    const nextCell = pendingGridCell;
    pendingGridCell = null;
    if (nextCell) updateGridCellDrag(nextCell);
  });
}

function gridCellAtPoint(x: number, y: number): GridCellPosition | null {
  const element = document.elementFromPoint?.(x, y) ?? null;
  return gridCellFromElement(element);
}

function gridTableBodyScrollElement(tableElement: HTMLElement): HTMLElement | null {
  return tableElement.querySelector<HTMLElement>(
    ".el-table-v2__main .el-table-v2__body",
  );
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

function clearGridCellAutoScroll(): void {
  if (gridCellAutoScrollFrame !== null) {
    window.cancelAnimationFrame(gridCellAutoScrollFrame);
  }
  gridCellAutoScrollFrame = null;
  gridCellAutoScrollTimestamp = null;
}

function clearGridCellWheelUpdate(): void {
  if (gridCellWheelUpdateTimer === null) return;
  window.clearTimeout(gridCellWheelUpdateTimer);
  gridCellWheelUpdateTimer = null;
}

function gridCellAtDragPoint(state: GridCellDragState): GridCellPosition | null {
  const body = gridTableBodyScrollElement(state.tableElement);
  const rect = body?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return gridCellAtPoint(state.lastX, state.lastY);
  }
  const x = Math.max(rect.left + 1, Math.min(rect.right - 1, state.lastX));
  const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, state.lastY));
  return gridCellAtPoint(x, y);
}

function updateGridCellAutoScroll(event: PointerEvent): void {
  const state = gridCellDragState;
  if (!state || !state.dragging) return;
  const body = gridTableBodyScrollElement(state.tableElement);
  const rect = body?.getBoundingClientRect() ?? state.tableElement.getBoundingClientRect();
  const edgeSize = 42;
  const direction = gridAutoScrollVector(event.clientX, event.clientY, rect, edgeSize);
  if (
    state.horizontalScrollDirection === direction.horizontal &&
    state.verticalScrollDirection === direction.vertical
  ) return;

  state.horizontalScrollDirection = direction.horizontal;
  state.verticalScrollDirection = direction.vertical;
  clearGridCellAutoScroll();
  if (direction.horizontal === 0 && direction.vertical === 0) return;

  const scrollFrame = (timestamp: number): void => {
    gridCellAutoScrollFrame = null;
    const currentState = gridCellDragState;
    if (!currentState) {
      clearGridCellAutoScroll();
      return;
    }
    const horizontalDirection = currentState.horizontalScrollDirection;
    const verticalDirection = currentState.verticalScrollDirection;
    if (horizontalDirection === 0 && verticalDirection === 0) {
      clearGridCellAutoScroll();
      return;
    }
    const elapsed = gridCellAutoScrollTimestamp === null
      ? 1000 / 60
      : Math.min(50, timestamp - gridCellAutoScrollTimestamp);
    gridCellAutoScrollTimestamp = timestamp;
    const step = 480 * elapsed / 1000;
    const currentBody = gridTableBodyScrollElement(currentState.tableElement);
    const currentLeft = currentBody?.scrollLeft ?? 0;
    const currentTop = currentBody?.scrollTop ?? 0;
    const maxLeft = currentBody
      ? Math.max(0, currentBody.scrollWidth - currentBody.clientWidth)
      : 0;
    const maxTop = currentBody
      ? Math.max(0, currentBody.scrollHeight - currentBody.clientHeight)
      : 0;
    const nextLeft = nextGridScrollOffset(currentLeft, maxLeft, horizontalDirection, step);
    const nextTop = nextGridScrollOffset(currentTop, maxTop, verticalDirection, step);
    if (nextLeft === currentLeft && nextTop === currentTop) {
      currentState.horizontalScrollDirection = 0;
      currentState.verticalScrollDirection = 0;
      clearGridCellAutoScroll();
      return;
    }
    if (nextLeft !== currentLeft) {
      if (tableRef.value) tableRef.value.scrollToLeft(nextLeft);
      else if (currentBody) currentBody.scrollLeft = nextLeft;
    }
    if (nextTop !== currentTop) {
      if (tableRef.value) tableRef.value.scrollToTop(nextTop);
      else if (currentBody) currentBody.scrollTop = nextTop;
    }
    const cell = gridCellAtDragPoint(currentState);
    if (cell) updateGridCellDrag(cell);
    gridCellAutoScrollFrame = window.requestAnimationFrame(scrollFrame);
  };
  gridCellAutoScrollFrame = window.requestAnimationFrame(scrollFrame);
}

function handleGridWheelDuringDrag(event: WheelEvent): void {
  const state = gridCellDragState;
  if (!state?.dragging) return;
  if (event.clientX || event.clientY) {
    state.lastX = event.clientX;
    state.lastY = event.clientY;
  }
  if (gridCellWheelUpdateTimer !== null) return;
  gridCellWheelUpdateTimer = window.setTimeout(() => {
    gridCellWheelUpdateTimer = null;
    const currentState = gridCellDragState;
    if (!currentState?.dragging) return;
    const cell = gridCellAtDragPoint(currentState);
    if (cell) updateGridCellDrag(cell);
  }, 0);
}

function updateGridCellDrag(cell: GridCellPosition): void {
  const state = gridCellDragState;
  if (!state) return;
  const focus = clampGridCell(cell);
  if (sameGridCell(state.lastAppliedFocus, focus)) return;
  state.lastAppliedFocus = focus;
  state.focus = focus;
  activeGridCell.value = state.focus;
  const range = {
    anchor: { ...state.anchor },
    focus: { ...state.focus },
  };
  if (state.mode === "add") {
    const keys = new Set(state.initialSelectionKeys);
    gridCellPositionsForRange(range).forEach((position) => keys.add(gridCellKey(position)));
    selectedGridCellKeys.value = keys;
    gridCellRange.value = null;
  } else {
    activeGridCell.value = state.focus;
    gridSelectionAnchor.value = state.anchor;
    gridCellRange.value = range;
  }
}

function handleGridPointerMove(event: PointerEvent): void {
  const state = gridCellDragState;
  if (!state || state.pointerId !== event.pointerId) return;
  if ((event.buttons & 1) !== 1) {
    stopGridCellDrag();
    return;
  }
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  if (!state.dragging) {
    const movedX = event.clientX - state.startX;
    const movedY = event.clientY - state.startY;
    if (Math.hypot(movedX, movedY) < pointerDragThreshold) return;
    state.dragging = true;
    gridSelectionDragging.value = true;
    suppressGridClick = true;
    event.preventDefault();
  } else {
    event.preventDefault();
  }
  const cell = gridCellAtPoint(event.clientX, event.clientY);
  if (cell) scheduleGridCellDragUpdate(cell);
  updateGridCellAutoScroll(event);
}

function handleGridPointerUp(event: PointerEvent): void {
  if (!gridCellDragState || gridCellDragState.pointerId !== event.pointerId) return;
  if (gridCellDragState.dragging) {
    event.preventDefault();
    flushGridCellDragFrame();
    if (gridCellDragState.mode !== "add") materializeGridCellRangeSelection();
  }
  stopGridCellDrag();
}

function handleGridPointerCancel(event: PointerEvent): void {
  if (!gridCellDragState || gridCellDragState.pointerId !== event.pointerId) return;
  stopGridCellDrag();
}

function gridFillTargetForCell(
  source: NormalizedGridRange,
  cell: GridCellPosition,
): NormalizedGridRange {
  return {
    rowStart: Math.min(source.rowStart, cell.rowIndex),
    rowEnd: Math.max(source.rowEnd, cell.rowIndex),
    columnStart: Math.min(source.columnStart, cell.columnIndex),
    columnEnd: Math.max(source.columnEnd, cell.columnIndex),
  };
}

function updateGridFillPreview(
  target: NormalizedGridRange,
  source: NormalizedGridRange,
  mode: GridFillMode,
  pointer?: { x: number; y: number },
  currentCell?: GridCellPosition,
): void {
  gridFillPreviewSource.value = { ...source };
  gridFillPreviewRange.value = { ...target };
  const entries = buildGridFillEntries(
    source,
    target,
    fields.value,
    tableRows.value,
    valueFor,
    mode,
  );
  const values = new Map<string, string>();
  entries.forEach((entry) => {
    values.set(
      `${source.rowStart + entry.rowOffset}:${source.columnStart + entry.columnOffset}`,
      entry.value,
    );
  });
  gridFillPreviewValues.value = values;
  const currentKey = currentCell ? `${currentCell.rowIndex}:${currentCell.columnIndex}` : "";
  const currentValue = currentKey ? values.get(currentKey) : undefined;
  gridFillPreviewSummary.value = currentValue === undefined ? "" : currentValue || "（空）";
  if (pointer) {
    gridFillPreviewPointer.left = Math.max(8, Math.min(window.innerWidth - 360, pointer.x + 14));
    gridFillPreviewPointer.top = Math.max(8, Math.min(window.innerHeight - 96, pointer.y + 14));
  }
}

function clearGridFillPreview(): void {
  gridFillPreviewRange.value = null;
  gridFillPreviewSource.value = null;
  gridFillPreviewValues.value = new Map();
  gridFillPreviewSummary.value = "";
}

function stopGridFillDrag(): void {
  document.removeEventListener("pointermove", handleGridFillPointerMove);
  document.removeEventListener("pointerup", handleGridFillPointerUp, true);
  document.removeEventListener("pointercancel", handleGridFillPointerCancel, true);
  gridFillDragState = null;
  clearGridFillPreview();
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

function handleGridFillPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || event.isPrimary === false) return;
  const range = gridCellRange.value;
  if (!range) return;
  const source = normalizedGridRange(range);
  const cell = gridCellFromElement(event.target);
  if (!cell || cell.rowIndex !== source.rowEnd || cell.columnIndex !== source.columnEnd) return;
  const tableElement =
    event.target instanceof Element ? event.target.closest<HTMLElement>(".el-table-v2") : null;
  if (!tableElement) return;
  const finishPromise = editingGridCell.value
    ? finishGridCellEdit(true, false)
    : Promise.resolve(true);
  stopGridFillDrag();
  gridFillDragState = {
    pointerId: event.pointerId,
    source,
    target: { ...source },
    mode: event.ctrlKey ? "copy" : "series",
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    dragging: false,
    tableElement,
    finishPromise,
  };
  document.addEventListener("pointermove", handleGridFillPointerMove, { passive: false });
  document.addEventListener("pointerup", handleGridFillPointerUp, true);
  document.addEventListener("pointercancel", handleGridFillPointerCancel, true);
  event.preventDefault();
  event.stopPropagation();
}

function handleGridFillPointerMove(event: PointerEvent): void {
  const state = gridFillDragState;
  if (!state || state.pointerId !== event.pointerId) return;
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  if (!state.dragging) {
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < pointerDragThreshold) {
      return;
    }
    state.dragging = true;
    suppressGridClick = true;
  }
  const cell = gridCellAtPoint(event.clientX, event.clientY);
  if (cell) {
    state.mode = event.ctrlKey ? "copy" : "series";
    state.target = gridFillTargetForCell(state.source, cell);
    updateGridFillPreview(
      state.target,
      state.source,
      state.mode,
      { x: event.clientX, y: event.clientY },
      cell,
    );
  }
  event.preventDefault();
}

async function handleGridFillPointerUp(event: PointerEvent): Promise<void> {
  const state = gridFillDragState;
  if (!state || state.pointerId !== event.pointerId) return;
  const shouldFill = state.dragging;
  const source = state.source;
  const target = state.target;
  const mode: GridFillMode = event.ctrlKey ? "copy" : "series";
  const finishPromise = state.finishPromise;
  if (shouldFill) {
    event.preventDefault();
    suppressGridClick = true;
  }
  stopGridFillDrag();
  if (shouldFill && (await finishPromise)) await applyGridFill(source, target, mode);
}

function handleGridFillPointerCancel(event: PointerEvent): void {
  if (!gridFillDragState || gridFillDragState.pointerId !== event.pointerId) return;
  stopGridFillDrag();
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

function handleGridPointerDown(event: PointerEvent): void {
  if (event.target instanceof Element && event.target.closest(".grid-fill-handle")) return;
  if (event.button !== 0 || event.isPrimary === false) return;
  const cell = gridCellFromElement(event.target);
  if (!cell) return;
  if (isGridCellEditing(cell)) return;
  const tableElement =
    event.target instanceof Element ? event.target.closest<HTMLElement>(".el-table-v2") : null;
  if (!tableElement) return;
  if (editingGridCell.value) void finishGridCellEdit(true, false);

  stopGridCellDrag(false);
  const modifierAdd = event.ctrlKey || event.metaKey;
  const modifierShift = event.shiftKey;
  const mode: GridCellDragMode = modifierAdd ? "add" : modifierShift ? "shift" : "replace";
  const anchor = modifierShift
    ? gridSelectionAnchor.value ?? activeGridCell.value ?? cell
    : cell;
  if (mode === "replace") selectGridCell(cell);
  else activeGridCell.value = cell;
  void focusGridCell(cell);
  gridCellDragState = {
    pointerId: event.pointerId,
    anchor: { ...cell },
    focus: { ...cell },
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    dragging: false,
    mode,
    initialSelectionKeys: new Set(selectedGridCellKeys.value),
    tableElement,
    lastAppliedFocus: null,
    horizontalScrollDirection: 0,
    verticalScrollDirection: 0,
  };
  if (mode === "shift") gridCellDragState.anchor = clampGridCell(anchor);
  document.addEventListener("pointermove", handleGridPointerMove, { passive: false });
  document.addEventListener("pointerup", handleGridPointerUp, true);
  document.addEventListener("pointercancel", handleGridPointerCancel, true);
  document.addEventListener("wheel", handleGridWheelDuringDrag, { passive: true });
}

function handleGridClick(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest(".grid-fill-handle")) {
    suppressGridClick = false;
    return;
  }
  const cell = gridCellFromElement(event.target);
  if (!cell) return;
  if (suppressGridClick) {
    event.preventDefault();
    event.stopPropagation();
    suppressGridClick = false;
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
  const cell = gridCellFromElement(event.target);
  if (!cell) return;
  activeGridCell.value = cell;

  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLowerCase();
    const shortcutMode =
      event.key === "Enter"
        ? "same"
        : key === "d"
          ? "down"
          : key === "r"
            ? "right"
            : event.key === ";"
              ? "today"
              : null;
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

function gridClipboardSelection(eventCell: GridCellPosition | null): GridClipboardSelection | null {
  let positions = selectedGridCellPositions();
  if (!positions.length && eventCell) positions = [clampGridCell(eventCell)];
  if (!positions.length) return null;
  const firstPosition = positions[0];
  if (!firstPosition) return null;
  const activeCandidate = activeGridCell.value;
  const active =
    (activeCandidate && positions.some((position) => sameGridCell(position, activeCandidate))
      ? activeCandidate
      : firstPosition);
  return { positions, active: clampGridCell(active) };
}

function buildGridClipboardData(selection: GridClipboardSelection): { plainText: string; payload: GridClipboardPayload } {
  return buildLedgerGridClipboardData(selection.positions, (position) => {
      const row = tableRows.value[position.rowIndex];
      const field = fields.value[position.columnIndex];
      return row && field ? valueFor(row, field) : "";
    });
}

function nativeGridClipboardTarget(target: EventTarget | null): boolean {
  if (
    target instanceof Element
    && target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")
  ) return true;
  const cell = gridCellFromElement(target);
  return Boolean(cell && isGridCellEditing(cell));
}

function writeGridClipboardEvent(event: ClipboardEvent, selection: GridClipboardSelection): boolean {
  const { plainText, payload } = buildGridClipboardData(selection);
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  try {
    clipboard.setData("text/plain", plainText);
  } catch {
    return false;
  }
  try {
    clipboard.setData(LEDGER_GRID_CLIPBOARD_MIME, JSON.stringify(payload));
  } catch {
    // Browsers may reject custom clipboard MIME types; text/plain remains usable.
  }
  lastGridClipboard = { plainText, payload };
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function copyGridSelectionWithNativeCommand(selection: GridClipboardSelection): boolean {
  if (typeof document.execCommand !== "function") return false;
  const previousClipboard = lastGridClipboard;
  let handled = false;
  let succeeded = false;
  const writeClipboard = (event: ClipboardEvent) => {
    handled = writeGridClipboardEvent(event, selection);
  };
  document.addEventListener("copy", writeClipboard, true);
  try {
    // Trigger the browser's native copy during the keyboard user gesture.
    // This also works when the async clipboard API is unavailable or denied.
    succeeded = document.execCommand("copy") && handled;
  } catch {
    // Fall back to the async clipboard API when the native command is unavailable.
  } finally {
    document.removeEventListener("copy", writeClipboard, true);
    if (!succeeded) lastGridClipboard = previousClipboard;
  }
  return succeeded;
}

function handleGridCopy(event: ClipboardEvent): void {
  // Editing keeps the browser's native text-copy behavior. Cell/range copy
  // is only active while the grid itself owns the selection.
  if (nativeGridClipboardTarget(event.target)) {
    lastGridClipboard = null;
    return;
  }
  const selection = gridClipboardSelection(gridCellFromElement(event.target) ?? activeGridCell.value);
  if (selection && !writeGridClipboardEvent(event, selection)) {
    event.preventDefault();
    event.stopPropagation();
    void copyGridSelectionToClipboard(selection, false, "复制失败，请检查剪贴板权限后重试");
  }
}

function handleGridCut(event: ClipboardEvent): void {
  if (nativeGridClipboardTarget(event.target)) {
    lastGridClipboard = null;
    return;
  }
  const selection = gridClipboardSelection(gridCellFromElement(event.target) ?? activeGridCell.value);
  if (!selection) return;
  event.preventDefault();
  event.stopPropagation();
  void cutGridSelectionToClipboard(selection, event);
}

function captureGridCutSnapshot(selection: GridClipboardSelection): GridCutSnapshot | null {
  const cells: GridCutSnapshot["cells"] = [];
  for (const position of selection.positions) {
    const data = gridCellData(position);
    if (!data) return null;
    cells.push({
      rowId: data.record.id,
      fieldId: data.field.id,
      value: valueFor(data.record, data.field),
      version: cellSaveVersions.get(persistedKey(data.record.id, data.field.id)) ?? 0,
    });
  }
  return { projectId: activeProjectId.value, projectGeneration: projectViewGeneration, cells };
}

function resolveGridCutPositions(snapshot: GridCutSnapshot): GridCellPosition[] | null {
  if (ledgerDisposed) return null;
  if (snapshot.projectId !== activeProjectId.value || snapshot.projectGeneration !== projectViewGeneration) {
    ElMessage.info("台账已切换，剪切已取消，原内容已保留");
    return null;
  }
  const fieldIndexes = new Map(fields.value.map((field, index) => [field.id, index]));
  const positions: GridCellPosition[] = [];
  for (const cell of snapshot.cells) {
    const rowIndex = tableRowIndexById.value.get(cell.rowId);
    const columnIndex = fieldIndexes.get(cell.fieldId);
    const data = rowIndex !== undefined && columnIndex !== undefined
      ? gridCellData({ rowIndex, columnIndex }) : null;
    if (
      !data || valueFor(data.record, data.field) !== cell.value
      || (cellSaveVersions.get(persistedKey(cell.rowId, cell.fieldId)) ?? 0) !== cell.version
    ) {
      ElMessage.warning("剪切范围的内容已变化，原内容已保留，请重新剪切");
      return null;
    }
    positions.push({ rowIndex: rowIndex!, columnIndex: columnIndex! });
  }
  return positions;
}

async function cutGridSelectionToClipboard(
  selection: GridClipboardSelection,
  event?: ClipboardEvent,
): Promise<void> {
  if (gridCutInProgress.value || loading.value || ledgerDisposed) return;
  const snapshot = captureGridCutSnapshot(selection);
  if (!snapshot) return;
  gridCutInProgress.value = true;
  const writeFailureMessage = "剪贴板写入失败，原内容已保留，请检查剪贴板权限后重试";
  try {
    const copied = event
      ? writeGridClipboardEvent(event, selection)
      : await copyGridSelectionToClipboard(selection, false, writeFailureMessage);
    if (!copied) {
      if (event) ElMessage.warning(writeFailureMessage);
      return;
    }
    const positions = resolveGridCutPositions(snapshot);
    if (positions) await clearGridCellRange("剪切", { positions, preserveSelection: true });
  } catch (error) {
    if (!ledgerDisposed) ElMessage.error(error instanceof Error ? error.message : "剪切失败");
  } finally {
    gridCutInProgress.value = false;
  }
}

async function copyGridSelectionToClipboard(
  selectionOverride?: GridClipboardSelection,
  showSuccess = true,
  failureMessage = "浏览器未授予剪贴板权限，请使用 Ctrl/Cmd+C 复制",
): Promise<boolean> {
  const selection = selectionOverride ?? gridClipboardSelection(null);
  if (!selection) {
    ElMessage.warning("请先选择要复制的单元格");
    return false;
  }
  const { plainText, payload } = buildGridClipboardData(selection);
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) throw new Error("clipboard-unavailable");
    let written = false;
    if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
      try {
        const item = new ClipboardItem({
          "text/plain": new Blob([plainText], { type: "text/plain" }),
          [LEDGER_GRID_CLIPBOARD_MIME]: new Blob([JSON.stringify(payload)], {
            type: LEDGER_GRID_CLIPBOARD_MIME,
          }),
        });
        await clipboard.write([item]);
        written = true;
      } catch {
        // Some browsers expose ClipboardItem but reject custom MIME types.
      }
    }
    if (!written) {
      await clipboard.writeText(plainText);
    }
    if (!ledgerDisposed) lastGridClipboard = { plainText, payload };
    if (showSuccess) ElMessage.success("已复制选中单元格");
    return true;
  } catch {
    if (!ledgerDisposed) ElMessage.warning(failureMessage);
    return false;
  }
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
    (lastGridClipboard?.plainText === text ? lastGridClipboard.payload : null);
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
  const groupId = `insert-${draftSequence + 1}`;
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

function makeDraftRow(
  insertion?: {
    anchorId: string;
    placement: LedgerDraftPlacement;
    groupId: string;
    order: number;
  },
): LedgerRow {
  const now = new Date().toISOString();
  draftSequence += 1;
  return {
    id: `draft-${draftSequence}`,
    _draft: true,
    _insertAnchorId: insertion?.anchorId,
    _insertPlacement: insertion?.placement,
    _insertGroupId: insertion?.groupId,
    _insertGroupOrder: insertion?.order,
    _insertOriginAnchorId: insertion?.anchorId,
    _insertOriginPlacement: insertion?.placement,
    project_id: activeProjectId.value,
    project_name: currentProject.value?.name ?? "",
    position: 0,
    pathology_number: "",
    block_number: null,
    status: "待实验",
    experiment_date: null,
    experiment_number: null,
    report_generated: false,
    locked: false,
    highlight_color: null,
    cell_highlight_colors: {},
    values: Object.fromEntries(
      fields.value
        .filter((field) => !field.is_core && field.default_value != null)
        .map((field) => [field.id, field.default_value ?? ""]),
    ),
    created_at: now,
    updated_at: now,
  };
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

function appendDraftRow(scrollToBottom = true): void {
  if (!currentProject.value || loading.value) return;
  draftRows.value.push(makeDraftRow());
  if (scrollToBottom) scrollTableToBottom();
}

function fieldOptions(field: FieldDefinition): string[] {
  return field.options
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((option) => option.value);
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

function setValue(
  record: ProjectRecord,
  field: FieldDefinition,
  value: string,
  options: { markDirty?: boolean } = {},
): void {
  if (field.system_key === "pathology_number") {
    record.pathology_number = value;
  } else if (field.system_key === "block_number") {
    record.block_number = value || null;
  } else if (field.system_key === "experiment_date") {
    record.experiment_date = value || null;
  } else if (field.system_key === "experiment_number") {
    record.experiment_number = value || null;
  } else if (field.system_key === "status") {
    record.status = value as RecordStatus;
  } else {
    record.values[field.id] = value;
  }
  clearFieldError(record, field);
  if (options.markDirty ?? true) {
    const key = persistedKey(record.id, field.id);
    cellSaveVersions.set(key, (cellSaveVersions.get(key) ?? 0) + 1);
    if (validationPanel.value?.cellKeys.includes(key)) dismissValidationPanel();
    if (isDraft(record) && pendingValidationAction && validationPanel.value?.label === "新增台账记录") {
      dismissValidationPanel();
    }
  }
  if ((options.markDirty ?? true) && !isDraft(record)) {
    const key = persistedKey(record.id, field.id);
    const editState = resolveLedgerCellEditState(
      valueFor(record, field),
      persistedValues.get(key) ?? "",
      cellSaveInFlightCounts.get(key) ?? 0,
    );
    if (editState === "clear") {
      clearCellSaveState(key);
    } else {
      setCellSaveState(record.id, field.id, { status: "dirty" });
    }
  }
}

function persistedKey(recordId: string, fieldId: string): string {
  return `${recordId}:${fieldId}`;
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
    }, 1500);
    cellSaveClearTimers.set(key, timer);
  }
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

function clearAllCellSaveStates(): void {
  cellSaveClearTimers.forEach((timer) => window.clearTimeout(timer));
  cellSaveClearTimers.clear();
  cellSaveStates.value = new Map();
  cellSaveVersions.clear();
}

function captureValidationCellRollback(
  record: LedgerRow,
  field: FieldDefinition,
): ValidationCellRollbackSnapshot {
  const key = persistedKey(record.id, field.id);
  const previousSaveState = cellSaveStates.value.get(key);
  return {
    key,
    recordId: record.id,
    fieldId: field.id,
    beforeValue: valueFor(record, field),
    previousSaveState: previousSaveState ? { ...previousSaveState } : null,
    previousFieldError: fieldErrors.value[key] ?? null,
  };
}

function rollbackValidationCells(
  snapshots: ValidationCellRollbackSnapshot[],
  versions: Record<string, number>,
): void {
  snapshots.forEach((snapshot) => {
    const snapshotVersion = versions[snapshot.key];
    if (
      snapshotVersion === undefined
      || !isValidationSnapshotCurrent(snapshotVersion, cellSaveVersions.get(snapshot.key))
    ) return;
    const record = tableRows.value.find((item) => item.id === snapshot.recordId);
    const field = fields.value.find((item) => item.id === snapshot.fieldId);
    if (!record || !field) return;
    setValue(record, field, snapshot.beforeValue, { markDirty: false });
    cellSaveVersions.set(snapshot.key, snapshotVersion + 1);
    if (snapshot.previousFieldError) {
      setFieldError(record, field, snapshot.previousFieldError);
    } else {
      clearFieldError(record, field);
    }
    if (snapshot.previousSaveState) {
      setCellSaveState(record.id, field.id, snapshot.previousSaveState);
    } else {
      clearCellSaveState(snapshot.key);
    }
  });
}

function removeDraftRows(recordIds: Set<string>): void {
  if (!recordIds.size) return;
  fields.value.forEach((field) => {
    recordIds.forEach((recordId) => {
      const key = persistedKey(recordId, field.id);
      clearCellSaveState(key);
      cellSaveVersions.delete(key);
      cellSaveInFlightCounts.delete(key);
      const nextErrors = { ...fieldErrors.value };
      delete nextErrors[key];
      fieldErrors.value = nextErrors;
    });
  });
  draftRows.value = draftRows.value.filter((record) => !recordIds.has(record.id));
  cleanupInsertedGroupRegistry();
  if (editingGridSnapshot.value && recordIds.has(editingGridSnapshot.value.rowId)) {
    clearGridCellEdit();
  }
  activeGridCell.value = null;
  clearGridCellSelection();
  recordIds.forEach((recordId) => setSaving(recordId, false));
}

function beginCellSave(key: string): void {
  cellSaveInFlightCounts.set(key, (cellSaveInFlightCounts.get(key) ?? 0) + 1);
}

function endCellSave(key: string): void {
  const remaining = (cellSaveInFlightCounts.get(key) ?? 1) - 1;
  if (remaining > 0) cellSaveInFlightCounts.set(key, remaining);
  else cellSaveInFlightCounts.delete(key);
}

function cellSaveStateFor(record: LedgerRow, field: FieldDefinition): CellSaveState | null {
  return cellSaveStates.value.get(persistedKey(record.id, field.id)) ?? null;
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

function fieldErrorFor(record: LedgerRow, field: FieldDefinition): string {
  return fieldErrors.value[persistedKey(record.id, field.id)] ?? "";
}

function setFieldError(record: LedgerRow, field: FieldDefinition, message: string): void {
  fieldErrors.value = {
    ...fieldErrors.value,
    [persistedKey(record.id, field.id)]: message,
  };
}

function clearFieldError(record: LedgerRow, field: FieldDefinition): void {
  const key = persistedKey(record.id, field.id);
  if (!(key in fieldErrors.value)) return;
  const next = { ...fieldErrors.value };
  delete next[key];
  fieldErrors.value = next;
}

function rememberRecord(record: ProjectRecord): void {
  fields.value.forEach((field) => {
    persistedValues.set(persistedKey(record.id, field.id), valueFor(record, field));
  });
}

function rememberAll(): void {
  persistedValues.clear();
  records.value.forEach(rememberRecord);
}

function payloadForField(
  record: ProjectRecord,
  field: FieldDefinition,
  rawValue: string,
): RecordUpdateInput {
  const value = rawValue.trim();
  if (field.system_key === "pathology_number") {
    if (!value) throw new Error("病理号不能为空");
    return { pathology_number: value };
  }
  if (field.system_key === "block_number") {
    return { block_number: value || null };
  }
  if (field.system_key === "experiment_date") {
    const normalized = normalizeDate(value);
    record.experiment_date = normalized || null;
    return { experiment_date: normalized || null };
  }
  if (field.system_key === "experiment_number") {
    return { experiment_number: value || null };
  }
  if (field.system_key === "status") {
    if (value !== "待实验" && value !== "已完成") {
      throw new Error("状态只能是“待实验”或“已完成”");
    }
    return { status: value };
  }
  return { values: { [field.id]: value } };
}

function setSaving(recordId: string, saving: boolean): void {
  const next = new Set(savingIds.value);
  if (saving) next.add(recordId);
  else next.delete(recordId);
  savingIds.value = next;
}

function replaceRecord(updated: ProjectRecord): void {
  invalidateProjectRecordCache(updated.project_id);
  const index = records.value.findIndex((record) => record.id === updated.id);
  if (index >= 0) records.value.splice(index, 1, updated);
  const selectedIndex = selectedRecords.value.findIndex((record) => record.id === updated.id);
  if (selectedIndex >= 0) selectedRecords.value.splice(selectedIndex, 1, updated);
  rememberRecord(updated);
  if (selectedRecordIds.value.has(updated.id)) selectedRecordCache.set(updated.id, updated);
}

function replaceRecordPreservingPending(
  updated: ProjectRecord,
  completedKeys: string | Set<string>,
): void {
  const completed =
    typeof completedKeys === "string" ? new Set([completedKeys]) : completedKeys;
  const current = records.value.find((record) => record.id === updated.id);
  rememberRecord(updated);
  if (!current) {
    replaceRecord(updated);
    return;
  }
  const merged = cloneLedgerRecord(updated);
  fields.value.forEach((field) => {
    const key = persistedKey(updated.id, field.id);
    if (completed.has(key)) return;
    const status = cellSaveStates.value.get(key)?.status;
    if (status === "dirty" || status === "saving" || status === "error") {
      setValue(merged, field, valueFor(current, field), { markDirty: false });
    }
  });
  const index = records.value.findIndex((record) => record.id === updated.id);
  if (index >= 0) records.value.splice(index, 1, merged);
  const selectedIndex = selectedRecords.value.findIndex((record) => record.id === updated.id);
  if (selectedIndex >= 0) selectedRecords.value.splice(selectedIndex, 1, merged);
  if (selectedRecordIds.value.has(updated.id)) selectedRecordCache.set(updated.id, merged);
  invalidateProjectRecordCache(updated.project_id);
}

function dirtyLedgerChanges(): RecordCellChange[] {
  return records.value.flatMap((record) => fields.value.flatMap((field) => {
    const key = persistedKey(record.id, field.id);
    const before = persistedValues.get(key);
    const value = valueFor(record, field);
    return before !== undefined && value !== before
      ? [{ record_id: record.id, field_id: field.id, value, expected_value: before }]
      : [];
  }));
}

function dirtyLedgerDrafts(): LedgerRow[] {
  return draftRows.value.filter((record) =>
    Boolean(record.pathology_number.trim() || record.block_number || record.experiment_date || record.experiment_number) ||
    record.status !== "待实验" || fields.value.some((field) =>
      !field.is_core && (record.values[field.id] ?? "") !== (field.default_value ?? "")));
}

function ledgerCloseState(): { dirty: boolean; busy: boolean } {
  return {
    dirty: Boolean(dirtyLedgerChanges().length || dirtyLedgerDrafts().length),
    busy: Boolean(closeSaving.value || savingIds.value.size || cellSaveInFlightCounts.size ||
      gridCellEditFinishPromise || gridCutInProgress.value || historyReplayLoading.value ||
      validationCommitLoading.value || findReplaceLoading.value || reorderLoading.value ||
      highlightLoading.value || loading.value || quickEntryRefreshInProgress.value || projectLoadPromise),
  };
}

async function saveLedgerBeforeClose(): Promise<boolean> {
  const projectId = activeProjectId.value;
  const changes = dirtyLedgerChanges();
  const drafts = dirtyLedgerDrafts().map((record) => ({
    record,
    rowNumber: (tableRowIndexById.value.get(record.id) ?? 0) + 2,
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
      experiment_date: record.experiment_date ? normalizeDate(record.experiment_date) : null,
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

function reconcileCellAfterCompletedSave(
  recordId: string,
  fieldId: string,
  completedVersion: number,
  recordHistory: boolean,
): void {
  const key = persistedKey(recordId, fieldId);
  const currentRecord = records.value.find((item) => item.id === recordId);
  const currentField = fields.value.find((item) => item.id === fieldId);
  if (!currentRecord || !currentField || currentRecord.locked) return;
  const currentValue = valueFor(currentRecord, currentField);
  const action = resolveLedgerCellCompletionAction({
    completedVersion,
    currentVersion: cellSaveVersions.get(key),
    currentValue,
    persistedValue: persistedValues.get(key) ?? "",
    inFlightCount: cellSaveInFlightCounts.get(key) ?? 0,
  });
  if (action === "none") return;
  if (action === "pending") return;
  if (action === "clear") {
    clearFieldError(currentRecord, currentField);
    clearCellSaveState(key);
    return;
  }
  setCellSaveState(recordId, fieldId, { status: "dirty" });
  void saveField(currentRecord, currentField, { recordHistory });
}

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

function snapshotRecord(record: ProjectRecord): ProjectRecord {
  return cloneLedgerRecord(record);
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

function pushCellHistory(
  label: string,
  changes: RecordCellBatchCommitResult["changes"],
  projectId = activeProjectId.value,
): void {
  if (!projectId || !changes.length) return;
  ledgerHistory.push(
    createLedgerCellHistoryEntry(
      projectId,
      label,
      changes.map((change) => ({
        recordId: change.record_id,
        fieldId: change.field_id,
        before: change.before,
        after: change.after,
      })),
    ),
  );
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

function reanchorPendingInsertedDrafts(record: LedgerRow, created: ProjectRecord): void {
  reanchorInsertedDraftGroup(draftRows.value, record, created.id, insertedGroupRegistry);
}

function cleanupInsertedGroupRegistry(): void {
  const activeGroupIds = new Set(
    draftRows.value.flatMap((draft) => draft._insertGroupId ? [draft._insertGroupId] : []),
  );
  insertedGroupRegistry.forEach((_, groupId) => {
    if (!activeGroupIds.has(groupId)) insertedGroupRegistry.delete(groupId);
  });
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
  entries: Array<{ record: LedgerRow; rowNumber: number; snapshot: ProjectRecord }>,
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

async function persistDraft(record: LedgerRow, notify = true): Promise<boolean> {
  if (!isDraft(record) || !currentProject.value) return false;
  const pathologyNumber = record.pathology_number.trim();
  if (!pathologyNumber || savingIds.value.has(record.id)) return false;
  const projectId = currentProject.value.id;
  const dateField = fields.value.find((field) => field.system_key === "experiment_date");
  let experimentDate = "";

  try {
    experimentDate = normalizeDate(record.experiment_date ?? "");
  } catch (error) {
    if (dateField) {
      setFieldError(
        record,
        dateField,
        error instanceof Error ? error.message : "日期格式无效",
      );
    }
    return false;
  }
  if (dateField) clearFieldError(record, dateField);

  setSaving(record.id, true);
  try {
    const values: Record<string, string> = {};
    fields.value.forEach((field) => {
      if (!field.is_core) values[field.id] = (record.values[field.id] ?? "").trim();
    });
    const payload: RecordCreateInput = {
      project_id: projectId,
      pathology_number: pathologyNumber,
      block_number: record.block_number?.trim() || null,
      status: record.status,
      experiment_date: experimentDate || null,
      experiment_number: record.experiment_number?.trim() || null,
      values,
      ...(record._insertAnchorId && record._insertPlacement === "before"
        ? { insert_before_record_id: record._insertAnchorId }
        : {}),
      ...(record._insertAnchorId && record._insertPlacement === "after"
        ? { insert_after_record_id: record._insertAnchorId }
        : {}),
    };
    const validation = await validateNewRecord(payload);
    const errors = validation.issues.filter((issue) => issue.severity === "error");
    const warnings = validation.issues.filter((issue) => issue.severity === "warning");
    if (errors.length || warnings.length) {
      const prompt = errors.length
        ? {
            title: "无法保存",
            outcomeText: "当前内容尚未保存，请按提示修改后重试。",
            cancelText: "返回修改",
            continueText: "",
          }
        : buildValidationPromptCopy(warnings, {
            context: "create",
            cancelBehavior: "discard",
          });
      pendingValidationAction = errors.length
        ? null
        : async () => {
            const created = await createRecord(payload);
            await finishPersistedDraft(record, created, projectId, notify);
          };
      pendingValidationCancel = errors.length
        ? null
        : () => {
            removeDraftRows(new Set([record.id]));
            ElMessage.info("已放弃本次新增，未写入台账");
          };
      validationPanel.value = {
        token: "",
        projectId,
        ...prompt,
        label: "新增台账记录",
        issues: validation.issues,
        affectedCount: 1,
        skippedLocked: 0,
        cellKeys: [],
        cellVersions: {},
        canContinue: !errors.length,
      };
      return false;
    }
    const created = await createRecord(payload);
    await finishPersistedDraft(record, created, projectId, notify);
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录自动保存失败");
    return false;
  } finally {
    setSaving(record.id, false);
  }
}

type PersistedRecordLocation = "focused" | "filtered-out" | "skipped" | "failed";

function currentRecordViewHasMembershipFilters(): boolean {
  return Object.values(ledgerFilters.value).some(Boolean);
}

async function locatePersistedRecord(
  recordId: string,
  projectId: string,
): Promise<PersistedRecordLocation> {
  if (activeProjectId.value !== projectId) {
    return "skipped";
  }
  if (!currentRecordViewHasMembershipFilters()) {
    loadedRecordCount.value = records.value.length;
    focusRecordId.value = recordId;
    await scrollToFocusedRecord(
      () => activeProjectId.value === projectId,
    );
    return "focused";
  }
  try {
    const result = await queryRecordIds(buildRecordQuery(projectId));
    if (activeProjectId.value !== projectId) {
      return "skipped";
    }
    recordTotal.value = result.total;
    const refreshPlan = resolveCreatedRecordRefreshPlan({
      localRecordIds: records.value.map((record) => record.id),
      queriedRecordIds: result.record_ids,
      createdRecordId: recordId,
    });
    if (refreshPlan === "local-filtered-out") {
      records.value = records.value.filter((record) => record.id !== recordId);
      loadedRecordCount.value = records.value.length;
      focusRecordId.value = "";
      return "filtered-out";
    }
    if (refreshPlan === "local-visible") {
      loadedRecordCount.value = records.value.length;
      focusRecordId.value = recordId;
      await scrollToFocusedRecord(
        () => activeProjectId.value === projectId,
      );
      return "focused";
    }
    const recordIsVisible = result.record_ids.includes(recordId);
    if (!recordIsVisible) focusRecordId.value = "";
    else focusRecordId.value = recordId;
    const loaded = await loadRecords(projectId, {
      preserveHistory: true,
      preserveSelection: true,
    });
    if (!recordIsVisible) return "filtered-out";
    if (!loaded) {
      focusRecordId.value = "";
      return "failed";
    }
    return "focused";
  } catch {
    focusRecordId.value = "";
    return "failed";
  }
}

async function finishPersistedDraft(
  record: LedgerRow,
  created: ProjectRecord,
  projectId: string,
  notify: boolean,
): Promise<void> {
  invalidateProjectRecordCache(projectId);
  if (editingGridSnapshot.value?.rowId === record.id) {
    // The enclosing finish operation still owns this session. It will decide
    // whether focus/selection may be applied after the async save completes.
    clearGridCellEdit(false);
  }
  const draftIndex = draftRows.value.findIndex((item) => item.id === record.id);
  reanchorPendingInsertedDrafts(record, created);
  if (draftIndex >= 0) draftRows.value.splice(draftIndex, 1);
  cleanupInsertedGroupRegistry();
  if (activeProjectId.value === projectId) {
    if (record._insertAnchorId) {
      records.value = records.value.map((item) =>
        item.position >= created.position
          ? { ...item, position: item.position + 1 }
          : item,
      );
    }
    records.value.push(created);
    records.value.sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
    recordTotal.value += 1;
    rememberRecord(created);
  }
  pushHistory("新增台账记录", [], [created], projectId);
  const location = await locatePersistedRecord(created.id, projectId);
  if (notify) {
    if (location === "filtered-out") {
      ElMessage.success("病理号已保存，但该记录不符合当前筛选条件；可使用撤销删除本次新增");
    } else if (location === "failed") {
      ElMessage.warning("病理号已保存，但自动定位失败；刷新或搜索后可查看该记录");
    } else {
      ElMessage.success(
        location === "focused"
          ? "病理号已保存并定位；可使用撤销删除本次新增"
          : "病理号已保存并创建台账记录；可使用撤销删除本次新增",
      );
    }
  }
}

async function saveField(
  record: LedgerRow,
  field: FieldDefinition,
  options: { recordHistory?: boolean } = {},
): Promise<boolean> {
  const recordHistory = options.recordHistory ?? true;
  if (isDraft(record)) {
    if (field.system_key === "experiment_date") {
      try {
        const normalized = normalizeDate(record.experiment_date ?? "");
        record.experiment_date = normalized || null;
        clearFieldError(record, field);
      } catch (error) {
        setFieldError(
          record,
          field,
          error instanceof Error ? error.message : "日期格式无效",
        );
      }
      return false;
    }
    if (field.system_key === "pathology_number") {
      return persistDraft(record);
    }
    return false;
  }
  if (record.locked) return false;
  const key = persistedKey(record.id, field.id);
  if (validationPanel.value?.cellKeys.includes(key)) {
    dismissValidationPanel();
  }
  const initialBefore = persistedValues.get(key) ?? "";
  const current = valueFor(record, field);
  if (current === initialBefore) {
    clearFieldError(record, field);
    if ((cellSaveInFlightCounts.get(key) ?? 0) > 0) {
      setCellSaveState(record.id, field.id, { status: "dirty" });
    } else {
      clearCellSaveState(key);
    }
    return false;
  }
  try {
    payloadForField(record, field, current);
    clearFieldError(record, field);
  } catch (error) {
    if (field.system_key === "experiment_date") {
      setFieldError(
        record,
        field,
        error instanceof Error ? error.message : "日期格式无效",
      );
    } else {
        setValue(record, field, initialBefore, { markDirty: false });
      setCellSaveState(record.id, field.id, {
        status: "error",
        message: error instanceof Error ? error.message : "单元格保存失败",
      });
      ElMessage.error(error instanceof Error ? error.message : "单元格保存失败");
    }
    return false;
  }

  const version = (cellSaveVersions.get(key) ?? 0) + 1;
  cellSaveVersions.set(key, version);
  beginCellSave(key);
  setCellSaveState(record.id, field.id, { status: "saving" });
  setSaving(record.id, true);
  try {
    const result = await enqueueRecordSave(record.id, async () => {
      const expectedValue = persistedValues.get(key) ?? initialBefore;
      const preview = await previewCellBatch(record.project_id, [
        {
          record_id: record.id,
          field_id: field.id,
          value: current,
          expected_value: expectedValue,
        },
      ]);
      const errors = preview.issues.filter((issue) => issue.severity === "error");
      const warnings = preview.issues.filter((issue) => issue.severity === "warning");
      if (errors.length || warnings.length) {
        const prompt = errors.length
          ? {
              title: "无法保存",
              outcomeText: "当前修改尚未保存，请按提示调整后重试。",
              cancelText: "返回修改",
              continueText: "",
            }
          : buildValidationPromptCopy(warnings, {
              context: "edit",
              cancelBehavior: "discard",
              originalValue: initialBefore,
            });
        pendingValidationAction = null;
        pendingValidationCancel = errors.length
          ? null
          : () => {
              rollbackValidationCells([
                {
                  key,
                  recordId: record.id,
                  fieldId: field.id,
                  beforeValue: initialBefore,
                  previousSaveState: null,
                  previousFieldError: null,
                },
              ], { [key]: version });
              ElMessage.info("已取消修改并恢复原值");
            };
        validationPanel.value = {
          token: preview.token,
          projectId: record.project_id,
          ...prompt,
          label: `编辑 ${field.label}`,
          issues: preview.issues,
          affectedCount: preview.affected_count,
          skippedLocked: preview.skipped_locked,
          cellKeys: [key],
          cellVersions: { [key]: version },
          canContinue: !errors.length,
        };
        throw new Error(errors[0]?.message ?? "存在警告，请在验证面板中确认后继续");
      }
      if (preview.issues.length) {
        pendingValidationAction = null;
        pendingValidationCancel = null;
        validationPanel.value = {
          token: "",
          projectId: record.project_id,
          title: "操作提示",
          label: `编辑 ${field.label}`,
          outcomeText: "修改已经通过校验并将继续保存。",
          cancelText: "我知道了",
          continueText: "",
          issues: preview.issues,
          affectedCount: preview.affected_count,
          skippedLocked: preview.skipped_locked,
          cellKeys: [key],
          cellVersions: { [key]: version },
          canContinue: false,
        };
      }
      const committed = await commitCellBatch(preview.token);
      const currentVersion = cellSaveVersions.get(key) === version;
      committed.records.forEach((updated) =>
        replaceRecordPreservingPending(updated, currentVersion ? key : new Set<string>()),
      );
      return committed;
    });
    if (cellSaveVersions.get(key) === version) {
      setCellSaveState(record.id, field.id, { status: "saved" });
      if (recordHistory) {
        pushCellHistory(`编辑 ${field.label}`, result.changes, record.project_id);
      }
    }
    return true;
  } catch (error) {
    if (cellSaveVersions.get(key) === version) {
      setCellSaveState(record.id, field.id, {
        status: "error",
        message: error instanceof Error ? error.message : "单元格保存失败",
      });
    }
    if (!validationPanel.value?.token) {
      ElMessage.error(error instanceof Error ? error.message : "单元格保存失败");
    }
    return false;
  } finally {
    setSaving(record.id, false);
    endCellSave(key);
    reconcileCellAfterCompletedSave(record.id, field.id, version, recordHistory);
  }
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

async function continueValidationCommit(): Promise<void> {
  const panel = validationPanel.value;
  if (!panel?.canContinue) return;
  if (panel.projectId !== activeProjectId.value) {
    dismissValidationPanel();
    ElMessage.warning("项目已切换，请重新执行该操作");
    return;
  }
  const staleCell = Object.entries(panel.cellVersions).some(
    ([key, version]) => (cellSaveVersions.get(key) ?? 0) !== version,
  );
  if (staleCell) {
    dismissValidationPanel();
    ElMessage.warning("单元格内容已变化，请重新执行并预检查");
    return;
  }
  validationCommitLoading.value = true;
  try {
    if (pendingValidationAction) {
      const action = pendingValidationAction;
      await action();
      if (validationPanel.value === panel) dismissValidationPanel();
      return;
    }
    if (!panel.token) return;
    const result = await commitCellBatch(panel.token, true);
    const completedKeys = new Set(panel.cellKeys);
    result.records.forEach((record) => replaceRecordPreservingPending(record, completedKeys));
    panel.cellKeys.forEach((key) => {
      const [recordId = "", fieldId = ""] = key.split(":");
      if (recordId && fieldId) setCellSaveState(recordId, fieldId, { status: "saved" });
    });
    pushCellHistory(panel.label, result.changes, panel.projectId);
    if (validationPanel.value === panel) dismissValidationPanel();
    ElMessage.success(`已保存 ${new Set(result.changes.map((change) => change.record_id)).size} 条记录`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "批量保存失败");
  } finally {
    validationCommitLoading.value = false;
  }
}

function dismissValidationPanel(): void {
  pendingValidationAction = null;
  pendingValidationCancel = null;
  validationPanel.value = null;
}

function cancelValidationPanel(): void {
  const cancel = pendingValidationCancel;
  dismissValidationPanel();
  cancel?.();
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
  try {
    previewCapabilities.value = await getPreviewCapabilities();
  } catch {
    previewCapabilities.value = null;
  }
}

function nativeEngineAvailable(engine: PrintEngine): boolean {
  const capabilities = previewCapabilities.value;
  if (!capabilities) return true;
  if (engine === "auto") return capabilities.native_preview;
  if (engine === "word") return capabilities.microsoft_spreadsheet;
  return capabilities.wps_spreadsheet;
}

function nativeEngineLabel(): string {
  if (previewEngine.value === "word") return "Excel";
  if (previewEngine.value === "wps") return "WPS";
  return "Excel/WPS";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function monitorNativeLedgerJob(task: NativePreviewTask): Promise<void> {
  let current = task;
  let openedNotified = false;
  for (let attempt = 0; attempt < 28_800; attempt += 1) {
    if (current.status === "failed") {
      ElMessage.error(current.error || "Excel/WPS 原生窗口打开失败");
      return;
    }
    if (current.status === "open" && !openedNotified) {
      openedNotified = true;
      ElMessage.success(`${nativeEngineLabel()} 原生窗口已打开`);
    }
    if (current.status === "completed") {
      ElMessage.info(`${nativeEngineLabel()} 原生窗口已关闭`);
      return;
    }
    await sleep(500);
    current = await getNativePreviewStatus(task.job_id);
  }
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

async function queryAllRecordBatches(
  query: RecordComplexQuery,
  signal?: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Awaited<ReturnType<typeof queryRecords>>> {
  const items: ProjectRecord[] = [];
  let total = 0;
  let offset = 0;
  while (true) {
    const batch = await queryRecords({ ...query, offset }, signal);
    total = batch.total;
    items.push(...batch.items);
    offset += batch.items.length;
    onProgress?.(items.length, total);
    if (!batch.items.length || offset >= total) break;
  }
  return { items, total, limit: query.limit, offset: 0 };
}

async function loadRecords(
  projectId = activeProjectId.value,
  options: {
    showLoading?: boolean;
    preserveHistory?: boolean;
    preserveSelection?: boolean;
    stabilizeTable?: boolean;
    preferCache?: boolean;
  } = {},
): Promise<boolean> {
  if (!options.preserveHistory) ledgerHistory.clear();
  if (!projectId) {
    records.value = [];
    recordTotal.value = 0;
    loadedRecordCount.value = 0;
    return true;
  }
  const showLoading = options.showLoading ?? true;
  const requestSequence = ++loadSequence;
  recordsAbortController?.abort();
  const controller = new AbortController();
  recordsAbortController = controller;
  const currentQuery = buildRecordQuery(projectId);
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
        controller.signal,
        (loadedCount, nextTotal) => {
          if (requestSequence !== loadSequence || projectId !== activeProjectId.value) return;
          loadedRecordCount.value = loadedCount;
          recordTotal.value = nextTotal;
        },
      );
      if (projectRecordCacheGeneration(projectId) !== queryCacheGeneration) return false;
      total = page.total;
      loaded = page.items;
      if (loaded.length <= LEDGER_RECORD_CACHE_MAX_RECORDS) {
        ledgerRecordCache.set(currentQueryKey, projectId, { records: loaded, total });
      } else {
        ledgerRecordCache.invalidateProject(projectId);
      }
    }
    if (requestSequence !== loadSequence || projectId !== activeProjectId.value) return false;
    const preserveGridSelection = options.preserveSelection && tableProjectId.value === projectId;
    const activeIdentity = preserveGridSelection ? captureGridIdentity(activeGridCell.value) : null;
    const anchorIdentity = preserveGridSelection ? captureGridIdentity(gridSelectionAnchor.value) : null;
    const rangeIdentities = preserveGridSelection && gridCellRange.value
      ? { anchor: captureGridIdentity(gridCellRange.value.anchor), focus: captureGridIdentity(gridCellRange.value.focus) }
      : null;
    records.value = loaded;
    recordTotal.value = total;
    loadedRecordCount.value = loaded.length;
    tableProjectId.value = projectId;
    if (preserveGridSelection) {
      const positions = selectedGridCellPositions();
      const active = restoreGridIdentity(activeIdentity) ?? positions[0] ?? null;
      const anchor = restoreGridIdentity(anchorIdentity) ?? active;
      const rangeAnchor = restoreGridIdentity(rangeIdentities?.anchor ?? null);
      const rangeFocus = restoreGridIdentity(rangeIdentities?.focus ?? null);
      let range: GridCellRange | null = null;
      if (rangeAnchor && rangeFocus) {
        const candidate = { anchor: rangeAnchor, focus: rangeFocus };
        const rectangle = gridCellPositionsForRange(candidate);
        if (
          rectangle.length === positions.length
          && rectangle.every((position) => selectedGridCellKeys.value.has(gridCellKey(position)))
        ) range = candidate;
      }
      if (active) replaceGridCellSelection(positions, active, anchor ?? active, range);
      else {
        activeGridCell.value = null;
        clearGridCellSelection();
      }
    } else {
      activeGridCell.value = null;
      clearGridCellSelection();
    }
    fieldErrors.value = {};
    clearAllCellSaveStates();
    selectedRecords.value = [];
    if (!options.preserveSelection) clearRecordSelection();
    rememberAll();
    const requestIsCurrent = () => (
      requestSequence === loadSequence
      && projectId === activeProjectId.value
      && !controller.signal.aborted
    );
    if (options.stabilizeTable) await refreshTableLayout(requestIsCurrent);
    else await nextTick();
    if (!requestIsCurrent()) return false;
    if (options.preserveSelection && selectedRecordIds.value.size) {
      records.value.forEach((record) => {
        if (selectedRecordIds.value.has(record.id)) {
          selectedRecordCache.set(record.id, record);
        }
      });
      selectedRecords.value = records.value.filter((record) => selectedRecordIds.value.has(record.id));
    }
    const scrolledToFocus = await scrollToFocusedRecord(requestIsCurrent);
    if (options.stabilizeTable && !scrolledToFocus) {
      await scrollTableToBottomOnce(requestIsCurrent);
    }
    return true;
  } catch (error) {
    if (requestSequence !== loadSequence || controller.signal.aborted) return false;
    ElMessage.error(error instanceof Error ? error.message : "台账读取失败");
    return false;
  } finally {
    if (requestSequence === loadSequence) {
      loading.value = false;
      if (recordsAbortController === controller) recordsAbortController = null;
    }
  }
}

function buildRecordQuery(
  projectId = activeProjectId.value,
  view: {
    filters?: LedgerFilterMap;
    sort?: LedgerSortState;
  } = {},
): RecordComplexQuery {
  const filters = view.filters ?? ledgerFilters.value;
  const sort = view.sort === undefined ? ledgerSort.value : view.sort;
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
    include_locked: showLockedRecords.value,
    field_filters: fieldFilters,
    sort: sort
      ? {
          field_id: sort.fieldId,
          direction: sort.order === "descending" ? "desc" : "asc",
        }
      : null,
    limit: loadBatchSize.value,
    offset: 0,
  };
}

async function ensureProjectLoaded(projectId: string): Promise<void> {
  if (activeProjectId.value !== projectId) {
    activeProjectId.value = projectId;
    await nextTick();
  }
  if (projectLoadPromise) await projectLoadPromise;
}

async function handleLockedVisibilityChange(): Promise<void> {
  clearSelectionsAfterLedgerViewChange();
  await loadRecords(activeProjectId.value, { preserveHistory: true });
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
  if (cellColor) {
    return { "--cell-highlight-color": cellColor } as CSSProperties;
  }
  return row.highlight_color ? { backgroundColor: row.highlight_color } : {};
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

function rowStyle({ row }: { row: LedgerRow }): CSSProperties {
  return row.highlight_color
    ? ({ "--record-highlight-color": row.highlight_color } as CSSProperties)
    : {};
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

function selectHighlightColor(color: string): void {
  highlightColor.value = color;
}

function isHighlightColorSelected(color: string): boolean {
  return highlightColor.value.toLowerCase() === color.toLowerCase();
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
      .catch((error) => console.error("快速录入表头刷新通知失败", error));
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

function virtualCellProps({
  rowData,
  rowIndex,
  column,
}: {
  rowData: LedgerRow;
  rowIndex: number;
  column: LedgerVirtualColumn;
}): Record<string, unknown> {
  const baseStyle = rowStyle({ row: rowData });
  if (column.kind === "selection") {
    return { class: "ledger-selection-column", style: baseStyle };
  }
  if (column.kind === "lock") {
    return { class: "ledger-lock-column", style: baseStyle };
  }
  const fieldIndex = column.fieldIndex ?? -1;
  const fieldId = column.fieldId;
  return {
    class: ["ledger-editor-column", gridCellClassName(rowData, rowIndex, fieldIndex)],
    style: { ...baseStyle, ...rowCellStyle(rowData, fieldId) },
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
  const pinnedFieldIds = project.fields
    .filter((field) => field.system_key === "experiment_date" || field.system_key === "status")
    .map((field) => field.id);
  const context = {
    projectId: project.id,
    selectedFieldIds,
    pinnedFieldIds,
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
      pinned: context.pinnedFieldIds.join(","),
    },
  }).href;
  window.open(
    target,
    "gene-ledger-quick-entry",
    "popup=yes,width=820,height=680,resizable=yes,scrollbars=no",
  );
}

function selectedRecordIdsForReplace(): string[] {
  const selectedCells = selectedGridCellPositions();
  if (selectedCells.length) {
    return [
      ...new Set(
        selectedCells
          .filter(
            (position) => fields.value[position.columnIndex]?.id === findReplaceForm.fieldId,
          )
          .map((position) => tableRows.value[position.rowIndex])
          .filter((row): row is LedgerRow => Boolean(row && !isDraft(row)))
          .map((row) => row.id),
      ),
    ];
  }
  return records.value.map((record) => record.id);
}

function openFindReplace(): void {
  if (editingGridCell.value) {
    void finishGridCellEdit(true, false).then((saved) => {
      if (saved) openFindReplace();
    });
    return;
  }
  const activeField = activeGridCell.value
    ? fields.value[activeGridCell.value.columnIndex]
    : fields.value[0];
  findReplaceForm.fieldId = activeField?.id ?? "";
  findReplaceForm.find = "";
  findReplaceForm.replacement = "";
  findReplaceForm.matchMode = "substring";
  findReplaceForm.caseSensitive = false;
  findReplacePreview.value = null;
  findReplaceScopeCount.value = null;
  findReplaceScopeLabel.value = selectedGridCellPositions().length ? "选中单元格所在记录" : "当前筛选范围全部记录";
  findReplaceVisible.value = true;
}

async function runFindReplacePreview(): Promise<void> {
  if (findReplaceLoading.value) return;
  if (!findReplaceForm.fieldId) {
    ElMessage.warning("请选择要处理的表头");
    return;
  }
  findReplaceLoading.value = true;
  findReplacePreview.value = null;
  findReplaceScopeCount.value = null;
  try {
    let recordIds = selectedRecordIdsForReplace();
    const selected = Boolean(selectedGridCellPositions().length);
    findReplaceScopeLabel.value = selected ? "选中单元格所在记录" : "当前筛选范围全部记录";
    if (!selected) recordIds = (await queryRecordIds(buildRecordQuery())).record_ids;
    recordIds = [...new Set(recordIds)];
    findReplaceScopeCount.value = recordIds.length;
    if (!recordIds.length) {
      ElMessage.warning("当前范围没有记录");
      return;
    }
    findReplacePreview.value = await previewReplace({
      project_id: activeProjectId.value,
      field_id: findReplaceForm.fieldId,
      record_ids: recordIds,
      find: findReplaceForm.find,
      replacement: findReplaceForm.replacement,
      match_mode: findReplaceForm.matchMode,
      case_sensitive: findReplaceForm.caseSensitive,
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "查找替换预览失败");
  } finally {
    findReplaceLoading.value = false;
  }
}

async function commitFindReplace(): Promise<void> {
  const preview = findReplacePreview.value;
  if (!preview?.token) return;
  findReplaceLoading.value = true;
  try {
    const hasErrors = preview.issues.some((issue) => issue.severity === "error");
    if (hasErrors) {
      ElMessage.error("存在严格验证错误，不能提交");
      return;
    }
    const result = await commitReplace(
      preview.token,
      preview.issues.some((issue) => issue.severity === "warning"),
    );
    result.records.forEach(replaceRecord);
    pushCellHistory("查找替换", result.changes, activeProjectId.value);
    findReplaceVisible.value = false;
    ElMessage.success(`已替换 ${result.changes.length} 个单元格，可一次撤销`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "查找替换提交失败");
  } finally {
    findReplaceLoading.value = false;
  }
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

watch(findReplaceForm, () => { findReplacePreview.value = null; }, { flush: "sync" });

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

function handleReadOnlyCellWheel(event: WheelEvent, cell: GridCellPosition): void {
  if (isGridCellEditing(cell)) return;
  const tableRoot = ledgerTableCardRef.value;
  if (!tableRoot) return;
  const body = gridTableBodyScrollElement(tableRoot);
  if (!body) return;
  event.preventDefault();
  body.scrollTop += event.deltaY;
  body.scrollLeft += event.deltaX;
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
  const lines = exactCells ? [] : text.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const matrix = lines.map((line) => line.split("\t"));
  const entries: GridPasteEntry[] =
    exactCells ??
    matrix.flatMap((rowValues, rowOffset) =>
      rowValues.map((value, columnOffset) => ({ rowOffset, columnOffset, value })),
    );
  if (!entries.length) return [];
  const changedDraftRows = new Map<string, { record: LedgerRow; rowNumber: number }>();
  const rollbackSnapshots = new Map<string, ValidationCellRollbackSnapshot>();
  const draftIdsBeforePaste = new Set(draftRows.value.map((record) => record.id));
  let appendedDraftIds = new Set<string>();
  const existingChanges: RecordCellChange[] = [];
  const changedPositions: GridCellPosition[] = [];
  const changedPositionKeys = new Set<string>();
  let skippedLocked = 0;
  let changedCells = 0;

  try {
    const maxRowOffset = Math.max(...entries.map((entry) => entry.rowOffset), 0);
    const missingRows = startRowIndex + maxRowOffset + 1 - tableRows.value.length;
    for (let index = 0; index < missingRows; index += 1) appendDraftRow(false);
    appendedDraftIds = new Set(
      draftRows.value
        .filter((record) => !draftIdsBeforePaste.has(record.id))
        .map((record) => record.id),
    );
    const rows = tableRows.value;

    entries.forEach((entry) => {
      const targetRowIndex = startRowIndex + entry.rowOffset;
      const targetColumnIndex = startColumnIndex + entry.columnOffset;
      const record = rows[targetRowIndex];
      if (!record) return;
      const field = fields.value[targetColumnIndex];
      if (!field || targetColumnIndex < 0 || targetRowIndex < 0) return;
      const position = { rowIndex: targetRowIndex, columnIndex: targetColumnIndex };
      const positionKey = `${targetRowIndex}:${targetColumnIndex}`;
      if (!changedPositionKeys.has(positionKey)) {
        changedPositionKeys.add(positionKey);
        changedPositions.push(position);
      }
      if (record.locked) {
        skippedLocked += 1;
        return;
      }
      const value = exactCells ? entry.value : entry.value.trim();
      const expectedValue = valueFor(record, field);
      const key = persistedKey(record.id, field.id);
      if (!rollbackSnapshots.has(key)) {
        rollbackSnapshots.set(key, captureValidationCellRollback(record, field));
      }
      if (!isDraft(record)) {
        existingChanges.push({
          record_id: record.id,
          field_id: field.id,
          value,
          expected_value: expectedValue,
        });
        setCellSaveState(record.id, field.id, { status: "saving" });
      }
      setValue(record, field, value);
      if (isDraft(record)) {
        changedDraftRows.set(record.id, {
          record,
          rowNumber: targetRowIndex + 2,
        });
      }
      changedCells += 1;
    });

    const committableDrafts = [...changedDraftRows.values()].filter(
      ({ record }) => record.pathology_number.trim() && !savingIds.value.has(record.id),
    ).map((entry) => ({ ...entry, snapshot: snapshotRecord(entry.record) }));
    const batchNewRecords: RecordBatchNewRecord[] = committableDrafts.map(({ record }) => ({
      client_id: record.id,
      pathology_number: record.pathology_number.trim(),
      block_number: record.block_number?.trim() || null,
      status: record.status,
      experiment_date: record.experiment_date ? normalizeDate(record.experiment_date) : null,
      experiment_number: record.experiment_number?.trim() || null,
      values: Object.fromEntries(
        (currentProject.value?.fields ?? [])
          .filter((field) => !field.is_core)
          .map((field) => [field.id, (record.values[field.id] ?? "").trim()]),
      ),
      ...(record._insertAnchorId && record._insertPlacement === "before"
        ? { insert_before_record_id: record._insertAnchorId }
        : {}),
      ...(record._insertAnchorId && record._insertPlacement === "after"
        ? { insert_after_record_id: record._insertAnchorId }
        : {}),
    }));
    const cellKeys = [...rollbackSnapshots.keys()];
    const cellVersions = Object.fromEntries(
      cellKeys.map((key) => [key, cellSaveVersions.get(key) ?? 0]),
    );
    let batchPreview: Awaited<ReturnType<typeof previewCellBatch>> | null = null;
    committableDrafts.forEach(({ snapshot }) => setSaving(snapshot.id, true));
    try {
      if (existingChanges.length || batchNewRecords.length) {
        batchPreview = await previewCellBatch(projectId, existingChanges, batchNewRecords);
      }
    } finally {
      committableDrafts.forEach(({ snapshot }) => setSaving(snapshot.id, false));
    }
    const allIssues = batchPreview?.issues ?? [];
    const errors = allIssues.filter((issue) => issue.severity === "error");
    const warnings = allIssues.filter((issue) => issue.severity === "warning");

    const commitPasteChanges = async (acceptWarnings: boolean): Promise<void> => {
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
          .filter((key) => (cellSaveVersions.get(key) ?? 0) === cellVersions[key]),
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
        ElMessage.success(`已${operationLabel} ${changedCells} 个单元格`);
      } else if (changedCells) {
        ElMessage.success(`已${operationLabel} ${changedCells} 个单元格，填写病理号后将自动保存`);
      }
      if (skippedLocked) ElMessage.info(`已跳过 ${skippedLocked} 个锁定单元格`);
    };

    if (errors.length || warnings.length) {
      if (!viewIsCurrent()) return [];
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
      pendingValidationAction = errors.length ? null : () => commitPasteChanges(true);
      pendingValidationCancel = errors.length
        ? null
        : () => {
            if (!viewIsCurrent()) return;
            rollbackValidationCells([...rollbackSnapshots.values()], cellVersions);
            removeDraftRows(appendedDraftIds);
            ElMessage.info(`已取消${operationLabel}，并恢复操作前的内容`);
          };
      validationPanel.value = {
        token: "",
        projectId,
        ...prompt,
        label: `${operationLabel}台账数据`,
        issues: allIssues,
        affectedCount: batchPreview?.affected_count ?? 0,
        skippedLocked: (batchPreview?.skipped_locked ?? 0) + skippedLocked,
        cellKeys,
        cellVersions,
        canContinue: !errors.length,
      };
      existingChanges.forEach((change) => {
        setCellSaveState(change.record_id, change.field_id, {
          status: errors.length ? "error" : "dirty",
          message: errors[0]?.message ?? "等待警告确认",
        });
      });
      return changedPositions;
    }

    await commitPasteChanges(false);
    if (!viewIsCurrent()) return [];
    if (allIssues.length) {
      pendingValidationAction = null;
      pendingValidationCancel = null;
      validationPanel.value = {
        token: "",
        projectId,
        title: "操作提示",
        label: `${operationLabel}台账数据`,
        outcomeText: `本次${operationLabel}已经完成。`,
        cancelText: "我知道了",
        continueText: "",
        issues: allIssues,
        affectedCount: batchPreview?.affected_count ?? 0,
        skippedLocked: (batchPreview?.skipped_locked ?? 0) + skippedLocked,
        cellKeys,
        cellVersions,
        canContinue: false,
      };
    }
    return changedPositions;
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
    const start = normalizeDate(exportFilter.start);
    const end = normalizeDate(exportFilter.end);
    if (start && end && start > end) throw new Error("导出开始日期不能晚于结束日期");
    exportFilter.start = start;
    exportFilter.end = end;
    const items: ProjectRecord[] = [];
    let offset = 0;
    while (true) {
      const page = await queryRecords({
        ...buildRecordQuery(),
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
  () => appStore.projects,
  (projects) => {
    if (!ledgerInitialized || !projects.length) return;
    if (!projects.some((project) => project.id === activeProjectId.value)) {
      activeProjectId.value = projects[0]?.id ?? "";
    }
  },
  { deep: true },
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
    insertedGroupRegistry.clear();
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
  if (event.key !== "Escape") return;
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
  recordsAbortController?.abort();
  recordsAbortController = null;
  ledgerRecordCache.clear();
  projectRecordCacheGenerations.clear();
  clearGridCellEdit();
  activeGridCell.value = null;
  clearGridCellSelection();
  lastGridClipboard = null;
  bottomScrollTimers.forEach((timer) => window.clearTimeout(timer));
  bottomScrollTimers = [];
  autosizeTextareaRefs.clear();
  columnWidthSaveQueues.clear();
  cellSaveInFlightCounts.clear();
  clearAllCellSaveStates();
});
</script>

<template>
  <div class="page-stack ledger-page">
    <section class="page-card ledger-command-card">
      <header class="ledger-workspace-heading" aria-label="台账工具栏">
        <div class="ledger-workspace-actions" role="toolbar" aria-label="台账常用操作">
          <el-button
            class="ledger-history-button"
            size="small"
            :icon="Undo2"
            text
            :disabled="!canUndoHistory"
            :loading="historyBusy"
            title="撤销"
            @click="undoLedger"
          >撤销</el-button>
          <el-button
            class="ledger-history-button"
            size="small"
            :icon="Redo2"
            text
            :disabled="!canRedoHistory"
            :loading="historyBusy"
            title="恢复"
            @click="redoLedger"
          >恢复</el-button>
          <span class="ledger-toolbar-divider" aria-hidden="true" />
          <el-button size="small" :icon="Plus" type="primary" plain @click="appendDraftRow">
            新增记录
          </el-button>
          <el-button size="small" :icon="Plus" @click="openQuickEntry">快速录入</el-button>
        </div>
        <div
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
        <el-checkbox
          v-model="showLockedRecords"
          class="ledger-locked-visibility"
          @change="handleLockedVisibilityChange"
        >显示锁定记录</el-checkbox>
        <div class="ledger-workspace-actions" role="toolbar" aria-label="台账导出与更多操作">
          <el-button size="small" :icon="Download" @click="exportVisible = !exportVisible">
            导出 Excel
          </el-button>
          <el-popover
            v-model:visible="moreActionsVisible"
            placement="bottom-end"
            :width="380"
            trigger="click"
            popper-class="ledger-toolbar-popover"
          >
            <template #reference>
              <el-button size="small" :icon="Setting" data-toolbar-action="more">更多</el-button>
            </template>
            <div class="ledger-popover-section">
              <strong class="ledger-popover-title">数据与视图</strong>
              <div class="ledger-popover-action-grid">
                <el-button @click="moreActionsVisible = false; openReorderDialog()">按日期重排</el-button>
                <el-button @click="moreActionsVisible = false; openFindReplace()">查找替换</el-button>
                <el-button
                  :icon="Setting"
                  :type="columnToolsVisible ? 'primary' : undefined"
                  @click="moreActionsVisible = false; toggleColumnTools()"
                >排序/筛选</el-button>
                <el-button @click="moreActionsVisible = false; bestFitAllColumns($event)">最佳列宽</el-button>
                <el-button
                  :icon="Setting"
                  class="ledger-manage-project-action"
                  @click="moreActionsVisible = false; managerVisible = true"
                >管理项目与表头</el-button>
              </div>
            </div>
            <div class="ledger-popover-section ledger-native-open-section">
              <strong class="ledger-popover-title">使用 Excel/WPS 打开</strong>
              <div class="ledger-native-open-options">
                <label>
                  <span>打开方式</span>
                  <el-select
                    v-model="previewEngine"
                    class="ledger-preview-engine"
                    aria-label="打开方式"
                    @change="savePreviewEngineSetting"
                  >
                    <el-option label="自动选择" value="auto" />
                    <el-option label="Microsoft Excel" value="word" :disabled="!nativeEngineAvailable('word')" />
                    <el-option label="WPS" value="wps" :disabled="!nativeEngineAvailable('wps')" />
                  </el-select>
                </label>
                <label>
                  <span>打开范围</span>
                  <el-select v-model="previewScope" class="ledger-preview-scope" aria-label="打开范围">
                    <el-option label="当前选区" value="selection" :disabled="!hasGridCellSelection" />
                    <el-option label="当前台账" value="project" />
                    <el-option label="整本台账" value="all" />
                  </el-select>
                </label>
              </div>
              <el-button
                class="ledger-native-open-button"
                type="primary"
                plain
                :loading="nativePreviewLoading"
                :disabled="!nativeEngineAvailable(previewEngine)"
                @click="moreActionsVisible = false; openLedgerNative()"
              >使用 {{ nativeEngineLabel() }} 打开</el-button>
            </div>
          </el-popover>
        </div>
      </header>
    </section>

    <section v-if="exportVisible" class="page-card export-panel">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">导出当前项目台账</h2>
          <p class="page-description">
            导出当前项目台账；可按实验日期指定导出范围。
          </p>
        </div>
        <el-button text @click="exportVisible = false">收起</el-button>
      </div>
      <div class="page-card-body toolbar">
        <span class="field-label">开始日期</span>
        <EditableDateInput v-model="exportFilter.start" class="export-date" />
        <span class="field-label">结束日期</span>
        <EditableDateInput v-model="exportFilter.end" class="export-date" />
        <el-tag effect="plain">.xlsx</el-tag>
        <el-button type="primary" :icon="Download" @click="exportCurrentProject">
          确认导出
        </el-button>
      </div>
    </section>

    <section
      class="selection-bar"
      role="toolbar"
      aria-label="批量操作"
    >
      <el-select
        v-model="recordSelectionScope"
        class="record-selection-scope"
        aria-label="记录选择范围"
        size="small"
      >
        <el-option label="全部记录" value="all" />
        <el-option label="非锁定记录" value="unlocked" />
      </el-select>
      <div class="selection-quick-actions" aria-label="快速选择">
        <el-button size="small" @click="selectVisibleRecords">全选</el-button>
        <el-button size="small" @click="invertVisibleSelection">反选</el-button>
      </div>
      <span class="selection-divider" aria-hidden="true" />
      <el-dropdown
        trigger="click"
        :disabled="gridCellInternalEditing || (!selectedCount && !hasGridCellSelection)"
        @command="handleBatchHighlightCommand"
      >
        <el-button
          size="small"
          :icon="Brush"
          :loading="highlightLoading"
          :disabled="gridCellInternalEditing || (!selectedCount && !hasGridCellSelection)"
        >
          底色<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="set">设置底色</el-dropdown-item>
            <el-dropdown-item command="clear">清除底色</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        trigger="click"
        :disabled="!selectedCount"
        @command="handleBatchStatusCommand"
      >
        <el-button size="small" :disabled="!selectedCount">
          状态<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="已完成">已完成</el-dropdown-item>
            <el-dropdown-item command="待实验">待实验</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        trigger="click"
        :disabled="!selectedCount"
        @command="handleBatchReportCommand"
      >
        <el-button size="small" :disabled="!selectedCount">
          报告状态<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="generated">已生成报告</el-dropdown-item>
            <el-dropdown-item command="pending">待生成报告</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        trigger="click"
        :disabled="!selectedCount"
        @command="handleBatchLockCommand"
      >
        <el-button size="small" :disabled="!selectedCount">
          锁定<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="lock" :icon="Lock">锁定</el-dropdown-item>
            <el-dropdown-item command="unlock" :icon="Unlock">解锁</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button
        size="small"
        type="danger"
        plain
        :icon="Delete"
        :disabled="!selectedCount"
        @click="deleteSelectedRecords"
      >删除所选</el-button>
      <el-button
        class="selection-clear-button"
        size="small"
        text
        :disabled="!batchSelectionActive"
        @click="clearBatchSelection"
      >
        取消选择
      </el-button>
    </section>

    <section
      ref="ledgerTableCardRef"
      class="page-card ledger-table-card"
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
          ? `正在读取全部记录… ${loadedRecordCount}/${recordTotal}`
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
              :cache="8"
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
                  v-else-if="virtualColumnField(column)"
                  class="ledger-header-label"
                  @click="handleLedgerHeaderClick(column.fieldIndex ?? -1, $event)"
                >
                  <span>{{ virtualColumnField(column)?.label }}</span>
                  <button
                    v-if="columnToolsVisible"
                    type="button"
                    class="ledger-column-tools-trigger"
                    :class="{
                      active: columnToolsOpenFieldId === column.fieldId,
                      sorted: ledgerSort?.fieldId === column.fieldId,
                      filtered: Boolean(ledgerFilters[column.fieldId]),
                    }"
                    :aria-label="`打开${virtualColumnField(column)?.label ?? ''}排序和筛选`"
                    @pointerdown.stop
                    @click.stop="openColumnTools(virtualColumnField(column)!, $event)"
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
                <div
                  v-else-if="virtualColumnField(column)"
                  class="cell-field"
                  :class="{
                    'cell-field-invalid': fieldErrorFor(row, virtualColumnField(column)!),
                    'cell-field-editing': isGridCellEditing({
                      rowIndex,
                      columnIndex: column.fieldIndex ?? -1,
                    }),
                  }"
                  :data-row-id="row.id"
                  :data-field-index="column.fieldIndex"
                  :tabindex="isGridCellEditing({
                    rowIndex,
                    columnIndex: column.fieldIndex ?? -1,
                  }) ? -1 : 0"
                  @wheel="handleReadOnlyCellWheel($event, {
                    rowIndex,
                    columnIndex: column.fieldIndex ?? -1,
                  })"
                >
                  <template v-if="isGridCellEditing({
                    rowIndex,
                    columnIndex: column.fieldIndex ?? -1,
                  })">
                    <EditableDateInput
                      v-if="virtualColumnField(column)?.data_type === 'date'
                        || virtualColumnField(column)?.system_key === 'experiment_date'"
                      :model-value="valueFor(row, virtualColumnField(column)!)"
                      :readonly="row.locked"
                      @update:model-value="setValue(row, virtualColumnField(column)!, $event)"
                      @change="saveField(row, virtualColumnField(column)!)"
                    />
                    <EditableChoiceInput
                      v-else-if="virtualColumnField(column)!.options.length
                        || virtualColumnField(column)?.data_type === 'select'"
                      :model-value="valueFor(row, virtualColumnField(column)!)"
                      :options="fieldOptions(virtualColumnField(column)!)"
                      :readonly="row.locked"
                      @update:model-value="setValue(row, virtualColumnField(column)!, $event)"
                      @change="saveField(row, virtualColumnField(column)!)"
                    />
                    <el-input
                      v-else-if="!virtualColumnField(column)?.is_core"
                      :ref="(instance: unknown) => setAutosizeTextareaRef(
                        instance,
                        row.id,
                        virtualColumnField(column)!.id,
                      )"
                      type="textarea"
                      :autosize="{ minRows: 1, maxRows: 1 }"
                      resize="none"
                      :model-value="valueFor(row, virtualColumnField(column)!)"
                      :readonly="row.locked"
                      :inputmode="virtualColumnField(column)?.data_type === 'number' ? 'decimal' : undefined"
                      @update:model-value="setValue(row, virtualColumnField(column)!, String($event))"
                      @change="saveField(row, virtualColumnField(column)!)"
                    />
                    <el-input
                      v-else
                      :model-value="valueFor(row, virtualColumnField(column)!)"
                      :readonly="row.locked"
                      :inputmode="virtualColumnField(column)?.data_type === 'number' ? 'decimal' : undefined"
                      @update:model-value="setValue(row, virtualColumnField(column)!, String($event))"
                      @change="saveField(row, virtualColumnField(column)!)"
                    />
                  </template>
                  <span
                    v-else
                    class="cell-field-value"
                    :title="valueFor(row, virtualColumnField(column)!)"
                  >
                    {{ valueFor(row, virtualColumnField(column)!) }}
                  </span>
                  <span
                    v-if="gridFillPreviewValue(rowIndex, column.fieldIndex ?? -1) !== null"
                    class="grid-fill-preview-value"
                  >
                    {{ gridFillPreviewValue(rowIndex, column.fieldIndex ?? -1) || "（空）" }}
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
                    v-if="fieldErrorFor(row, virtualColumnField(column)!)"
                    class="cell-field-error"
                  >
                    {{ fieldErrorFor(row, virtualColumnField(column)!) }}
                  </span>
                  <span
                    v-if="isDraft(row)
                      && virtualColumnField(column)?.system_key === 'pathology_number'
                      && valueFor(row, virtualColumnField(column)!).trim()"
                    class="cell-save-state is-dirty"
                    title="这条记录尚未写入台账"
                  >
                    未保存
                  </span>
                  <span
                    v-else-if="cellSaveStateFor(row, virtualColumnField(column)!)"
                    class="cell-save-state"
                    :class="`is-${cellSaveStateFor(row, virtualColumnField(column)!)?.status}`"
                    :title="cellSaveStateFor(row, virtualColumnField(column)!)?.message ?? ''"
                  >
                    {{
                      cellSaveStateFor(row, virtualColumnField(column)!)?.status === 'saving'
                        ? '保存中'
                        : cellSaveStateFor(row, virtualColumnField(column)!)?.status === 'saved'
                          ? '已保存'
                          : cellSaveStateFor(row, virtualColumnField(column)!)?.status === 'error'
                            ? '失败'
                            : '未保存'
                    }}
                  </span>
                </div>
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
        <div
          v-if="ledgerContextMenu"
          class="ledger-context-menu"
          :style="contextMenuStyle"
          role="menu"
          @pointerdown.stop
          @click.stop
          @contextmenu.prevent
        >
          <button
            type="button"
            role="menuitem"
            :disabled="ledgerContextMenu.target.kind !== 'cell' || !hasGridCellSelection || loading || gridCutInProgress"
            class="ledger-context-menu-shortcut-item"
            title="剪切选中单元格（Ctrl+X / Cmd+X）"
            aria-keyshortcuts="Control+X Meta+X"
            @click="contextCut"
          >
            <span>剪切</span><kbd>Ctrl+X</kbd>
          </button>
          <button type="button" role="menuitem" class="ledger-context-menu-shortcut-item" @click="contextCopy">
            <span>复制</span><kbd>Ctrl+C</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="ledgerContextMenu.target.kind !== 'cell' || !hasGridCellSelection"
            @click="contextDelete"
          >
            删除
          </button>
          <div class="ledger-context-menu-submenu">
            <button
              type="button"
              class="ledger-context-menu-submenu-trigger"
              role="menuitem"
              aria-haspopup="menu"
            >
              <span>插入行</span>
              <ArrowRight :size="14" aria-hidden="true" />
            </button>
            <div
              class="ledger-context-menu-submenu-panel"
              :class="{ 'opens-left': ledgerContextMenu.submenuLeft }"
              role="group"
              aria-label="插入行设置"
            >
              <label class="ledger-context-menu-insert-count">
                <span>插入行数</span>
                <input
                  v-model.number="contextInsertRowCount"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  inputmode="numeric"
                  aria-label="插入行数，范围 1 到 100"
                  @click.stop
                  @keydown.enter.stop.prevent="contextInsertRows('before')"
                />
              </label>
              <button type="button" role="menuitem" @click="contextInsertRows('before')">
                在上方插入
              </button>
              <button type="button" role="menuitem" @click="contextInsertRows('after')">
                在下方插入
              </button>
            </div>
          </div>
          <div class="ledger-context-menu-separator" role="separator"></div>
          <button
            type="button"
            class="ledger-context-menu-danger"
            role="menuitem"
            :disabled="loading"
            :title="contextDeleteRecordCount > 1
              ? `永久删除选中的 ${contextDeleteRecordCount} 条记录`
              : contextMenuRow?.locked
                ? '当前记录已锁定，请先解锁后再删除'
                : '永久删除当前记录'"
            @click="contextDeleteRecord"
          >
            {{ contextDeleteRecordCount > 1
              ? '删除所选记录'
              : '删除记录' }}
          </button>
        </div>
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
          <span class="ledger-record-total">共 {{ recordTotal }} 条</span>
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

  <el-dialog
    class="ledger-dialog"
    v-model="reorderDialogVisible"
    title="按实验日期重排台账"
    width="680px"
  >
    <p class="dialog-note">
      仅重排当前项目中所选日期的记录，并按“病理号-蜡块号”的实验编排规则排序；其他日期记录的位置保持不变。
    </p>
    <el-form label-position="top">
      <el-form-item label="实验日期">
        <el-date-picker
          v-model="reorderDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="选择日期"
          @change="reorderPreview = null"
        />
      </el-form-item>
    </el-form>
    <div v-if="reorderPreview" class="reorder-preview-panel">
      <strong>
        当前项目共 {{ reorderPreview.affected_records }} 条记录，
        将调整 {{ reorderPreview.changed_records }} 条
      </strong>
      <el-alert
        v-if="reorderPreview.locked_records.length"
        type="error"
        :closable="false"
        :title="`有 ${reorderPreview.locked_records.length} 条锁定记录，请先解锁`"
      />
      <div v-for="project in reorderPreview.projects" :key="project.project_id" class="reorder-project-preview">
        <b>{{ project.project_name }}（调整 {{ project.changed_count }} 条）</b>
        <span>调整前：{{ project.before.join('、') || '无' }}</span>
        <span>调整后：{{ project.after.join('、') || '无' }}</span>
      </div>
    </div>
    <template #footer>
      <el-button @click="reorderDialogVisible = false">取消</el-button>
      <el-button :loading="reorderLoading" @click="loadReorderPreview">预览</el-button>
      <el-button
        type="primary"
        :loading="reorderLoading"
        :disabled="!reorderPreview || Boolean(reorderPreview.locked_records.length) || !reorderPreview.changed_records"
        @click="confirmReorderByDate"
      >
        确认重排
      </el-button>
    </template>
  </el-dialog>

  <el-dialog class="ledger-dialog" v-model="findReplaceVisible" title="查找替换" width="660px" :close-on-click-modal="!findReplaceLoading" :close-on-press-escape="!findReplaceLoading" :show-close="!findReplaceLoading">
    <p class="muted">{{ findReplaceScopeLabel }}；单次最多 {{ FIND_REPLACE_RECORD_LIMIT.toLocaleString('zh-CN') }} 条记录。</p>
    <el-form label-position="top" :disabled="findReplaceLoading">
      <el-form-item label="指定表头">
        <el-select v-model="findReplaceForm.fieldId" filterable>
          <el-option v-for="field in fields" :key="field.id" :label="field.label" :value="field.id" />
        </el-select>
      </el-form-item>
      <div class="two-column-dialog-form">
        <el-form-item label="查找内容">
          <el-input v-model="findReplaceForm.find" />
        </el-form-item>
        <el-form-item label="替换为">
          <el-input v-model="findReplaceForm.replacement" />
        </el-form-item>
      </div>
      <div class="two-column-dialog-form">
        <el-form-item label="匹配方式">
          <el-radio-group v-model="findReplaceForm.matchMode">
            <el-radio-button value="substring">子串</el-radio-button>
            <el-radio-button value="whole">完整单元格</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="大小写">
          <el-checkbox v-model="findReplaceForm.caseSensitive">区分大小写</el-checkbox>
        </el-form-item>
      </div>
    </el-form>
    <div v-if="findReplaceScopeCount !== null" class="replace-preview-panel" aria-live="polite">
      <strong>范围 {{ findReplaceScopeCount.toLocaleString('zh-CN') }} 条记录</strong>
      <template v-if="findReplacePreview">
        <span>，可替换 {{ findReplacePreview.matched_count }} 个单元格</span>
        <span>，锁定跳过 {{ findReplacePreview.skipped_locked }} 个单元格</span>
      </template>
      <p v-if="findReplaceScopeCount > FIND_REPLACE_RECORD_LIMIT" role="alert">范围超过单次上限，请缩小筛选或选中范围后重试；本次未执行替换。</p>
      <ul v-if="findReplacePreview?.issues.length">
        <li v-for="(issue, index) in findReplacePreview.issues.slice(0, 20)" :key="index">
          {{ issue.message }}
        </li>
      </ul>
    </div>
    <template #footer>
      <el-button :disabled="findReplaceLoading" @click="findReplaceVisible = false">取消</el-button>
      <el-button :loading="findReplaceLoading" @click="runFindReplacePreview">预览</el-button>
      <el-button
        type="primary"
        :loading="findReplaceLoading"
        :disabled="!findReplacePreview?.matched_count || findReplacePreview.issues.some((issue) => issue.severity === 'error')"
        @click="commitFindReplace"
      >
        确认替换
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-if="validationPanel"
    :model-value="true"
    class="ledger-dialog ledger-validation-dialog"
    :title="validationPanel.title"
    width="620px"
    align-center
    append-to-body
    destroy-on-close
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    role="alertdialog"
    aria-modal="true"
    aria-describedby="ledger-validation-description"
  >
    <div id="ledger-validation-description" class="validation-dialog-content">
      <div class="validation-dialog-summary">
        <strong>{{ validationPanel.label }}</strong>
        <span>影响 {{ validationPanel.affectedCount }} 个单元格</span>
        <span v-if="validationPanel.skippedLocked">，跳过锁定 {{ validationPanel.skippedLocked }} 个</span>
      </div>
      <ul class="validation-dialog-issues">
        <li
          v-for="(issue, index) in validationPanel.issues.slice(0, 20)"
          :key="index"
          :class="`is-${issue.severity}`"
        >
          {{ issue.message }}
        </li>
      </ul>
      <p v-if="validationPanel.outcomeText" class="validation-dialog-outcome">
        {{ validationPanel.outcomeText }}
      </p>
    </div>
    <template #footer>
      <el-button :disabled="validationCommitLoading" @click="cancelValidationPanel">
        {{ validationPanel.cancelText }}
      </el-button>
      <el-button
        v-if="validationPanel.canContinue"
        type="primary"
        :loading="validationCommitLoading"
        @click="continueValidationCommit"
      >
        {{ validationPanel.continueText }}
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    class="ledger-dialog"
    v-model="highlightDialogVisible"
    :title="
      highlightMode === 'cell'
        ? `设置单元格底色（${highlightCellTargets.length} 个）`
        : `设置记录底色（${highlightTargetIds.length} 条）`
    "
    width="430px"
    destroy-on-close
  >
    <div class="highlight-dialog-body">
      <p class="dialog-note">
        <template v-if="highlightMode === 'cell'">
          选择一种底色后，会应用到当前选中的单元格；矩形选区中的草稿行不会写入台账。
        </template>
        <template v-else>
          选择一种底色后，会应用到当前选中的记录；锁定记录也可以设置或清除底色标记。
        </template>
      </p>
      <div class="highlight-palette-section">
        <div class="highlight-palette-title">主题颜色</div>
        <div class="highlight-palette-grid">
          <template v-for="(row, rowIndex) in highlightThemeRows" :key="`theme-${rowIndex}`">
            <button
              v-for="item in row"
              :key="item.color"
              type="button"
              class="highlight-color-swatch"
              :class="{ 'is-selected': isHighlightColorSelected(item.color) }"
              :style="{ backgroundColor: item.color }"
              :aria-label="item.label"
              :aria-pressed="isHighlightColorSelected(item.color)"
              :title="item.label"
              @click="selectHighlightColor(item.color)"
            >
              <span v-if="isHighlightColorSelected(item.color)" class="highlight-swatch-mark">
                <Check :size="16" :stroke-width="2" aria-hidden="true" />
              </span>
            </button>
          </template>
        </div>
      </div>
      <div class="highlight-palette-section">
        <div class="highlight-palette-title">标准色</div>
        <div class="highlight-palette-grid">
          <button
            v-for="item in highlightStandardColors"
            :key="item.color"
            type="button"
            class="highlight-color-swatch"
            :class="{ 'is-selected': isHighlightColorSelected(item.color) }"
            :style="{ backgroundColor: item.color }"
            :aria-label="item.label"
            :aria-pressed="isHighlightColorSelected(item.color)"
            :title="item.label"
            @click="selectHighlightColor(item.color)"
          >
            <span v-if="isHighlightColorSelected(item.color)" class="highlight-swatch-mark">
              <Check :size="16" :stroke-width="2" aria-hidden="true" />
            </span>
          </button>
        </div>
      </div>
      <div class="highlight-picker-row">
        <span class="field-label">更多颜色</span>
        <el-color-picker
          v-model="highlightColor"
          :predefine="highlightPalette"
        />
        <span
          class="highlight-preview"
          :style="{ backgroundColor: highlightColor }"
          aria-label="底色预览"
        />
        <code>{{ highlightColor }}</code>
      </div>
    </div>
    <template #footer>
      <el-button :disabled="highlightLoading" @click="highlightDialogVisible = false">
        取消
      </el-button>
      <el-button :loading="highlightLoading" @click="clearHighlight">清除底色</el-button>
      <el-button
        type="primary"
        :loading="highlightLoading"
        @click="submitHighlight(highlightColor)"
      >
        应用底色
      </el-button>
    </template>
  </el-dialog>


</template>

<style scoped>
.ledger-workspace-heading {
  box-sizing: border-box;
  display: flex;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  gap: var(--app-space-2);
  overflow-x: auto;
  padding: var(--app-space-2) var(--app-space-2);
  scrollbar-width: thin;
}

.ledger-workspace-heading::-webkit-scrollbar {
  height: 4px;
}

.ledger-workspace-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--app-space-1);
  white-space: nowrap;
}

.ledger-workspace-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.ledger-workspace-actions :deep(.el-button) {
  min-height: 32px;
  flex: 0 0 auto;
  font-size: 14px;
}

.ledger-toolbar-divider,
.selection-divider {
  width: 1px;
  height: 20px;
  flex: 0 0 1px;
  background: var(--app-border);
}

.ledger-page > .page-card {
  min-width: 0;
  border-color: var(--app-border);
  border-radius: var(--app-radius-card);
  box-shadow: 0 3px 14px rgb(45 42 38 / 3%);
}

.selection-bar :deep(.el-button + .el-button) {
  margin-left: 0;
}

.selection-bar > * {
  flex-shrink: 0;
}

.ledger-table-card :deep(.ledger-loading-mask) {
  transition-duration: 60ms;
}

.ledger-context-menu button:focus-visible,
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

.highlight-dialog-body {
  padding: var(--app-space-optical) 0 var(--app-space-2);
}

.highlight-palette-section {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-2);
}

.highlight-palette-section + .highlight-palette-section {
  margin-top: var(--app-space-3);
}

.highlight-palette-title {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 700;
}

.highlight-palette-grid {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: var(--app-space-1);
}

.highlight-color-swatch {
  position: relative;
  min-width: 0;
  height: 27px;
  border: 1px solid var(--app-border-strong);
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease;
}

.highlight-color-swatch:hover {
  z-index: 1;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgb(16 24 40 / 20%);
}

.highlight-color-swatch.is-selected {
  z-index: 2;
  outline: 2px solid var(--app-primary);
  outline-offset: 1px;
}

.highlight-swatch-mark {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  color: var(--app-bg);
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
  text-shadow: 0 1px 2px rgb(0 0 0 / 75%);
}

.highlight-picker-row {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  margin-top: var(--app-space-3);
}

.highlight-picker-row .field-label {
  min-width: 62px;
}

.highlight-preview {
  width: 44px;
  height: 28px;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-control);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 60%);
}

.highlight-picker-row code {
  color: var(--app-muted);
  font-size: 12px;
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

.ledger-context-menu {
  width: 160px;
  overflow: visible;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-card);
  background: var(--app-bg);
  box-shadow: 0 8px 26px rgb(45 42 38 / 10%);
  padding: var(--app-space-1);
}

.ledger-context-menu button {
  display: block;
  width: 100%;
  border: 0;
  border-radius: var(--app-radius-control);
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
  font: inherit;
  padding: var(--app-space-2) var(--app-space-2);
  text-align: left;
}

.ledger-context-menu button:hover:not(:disabled) {
  background: var(--app-primary-soft);
  color: var(--app-primary-text);
}

.ledger-context-menu button:disabled {
  color: var(--app-disabled);
  cursor: not-allowed;
}

.ledger-context-menu .ledger-context-menu-shortcut-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ledger-context-menu-shortcut-item kbd {
  color: var(--app-muted);
  font-family: inherit;
  font-size: 11px;
}

.ledger-context-menu-separator {
  height: 1px;
  margin: var(--app-space-1) var(--app-space-1);
  background: var(--app-border);
}

.ledger-context-menu button.ledger-context-menu-danger:not(:disabled) {
  color: var(--el-color-danger);
}

.ledger-context-menu button.ledger-context-menu-danger:hover:not(:disabled) {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.ledger-context-menu-submenu {
  position: relative;
}

.ledger-context-menu .ledger-context-menu-submenu-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ledger-context-menu-submenu-panel {
  position: absolute;
  z-index: 1;
  bottom: -5px;
  left: calc(100% - 4px);
  display: none;
  width: 200px;
  box-sizing: border-box;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-card);
  background: var(--app-bg);
  box-shadow: 0 8px 26px rgb(45 42 38 / 10%);
  padding: var(--app-space-1);
  transform-origin: top left;
  animation: ledger-overlay-pop-in 0.16s ease;
}

.ledger-context-menu-submenu-panel.opens-left {
  right: calc(100% - 4px);
  left: auto;
  transform-origin: top right;
}

@keyframes ledger-overlay-pop-in {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
}

.ledger-context-menu-insert-count {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--app-space-2);
  color: var(--app-muted);
  font-size: 13px;
  padding: var(--app-space-1) var(--app-space-2) var(--app-space-2);
  white-space: nowrap;
}

.ledger-context-menu-insert-count input {
  box-sizing: border-box;
  width: 72px;
  height: 28px;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-control);
  outline: 0;
  background: var(--app-bg);
  color: var(--app-text);
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0 var(--app-space-1);
  text-align: center;
}

.ledger-context-menu-insert-count input:focus {
  border-color: var(--app-primary);
  box-shadow: 0 0 0 2px var(--app-primary-soft);
}

.ledger-context-menu-submenu:hover > .ledger-context-menu-submenu-panel,
.ledger-context-menu-submenu:focus-within > .ledger-context-menu-submenu-panel {
  display: block;
}

.export-date {
  width: 190px;
}

.ledger-locked-visibility {
  flex: 0 0 auto;
  margin-right: 0;
  white-space: nowrap;
}

.ledger-locked-visibility :deep(.el-checkbox__label) {
  padding-left: var(--app-space-1);
  font-size: 14px;
}

.ledger-history-button {
  width: auto;
  min-width: 58px;
}

:deep(.search-focus-row > td) {
  background: var(--app-primary-soft) !important;
  transition: background-color 300ms ease;
}

.export-panel {
  border-color: var(--app-primary-border);
}

.field-label {
  color: var(--app-muted);
  font-size: 12px;
}

.selection-bar {
  display: flex;
  min-height: 46px;
  align-items: center;
  flex-wrap: nowrap;
  gap: var(--app-space-2);
  overflow-x: auto;
  border: 1px solid var(--app-primary-border);
  border-radius: var(--app-radius-card);
  background: var(--app-hover);
  padding: var(--app-space-1) var(--app-space-2);
  scrollbar-width: none;
}

.selection-bar::-webkit-scrollbar {
  display: none;
}

.record-selection-scope {
  width: 120px;
  flex: 0 0 120px;
}

.record-selection-scope :deep(.el-select__wrapper) {
  min-height: 32px;
  font-size: 14px;
}

.selection-quick-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--app-space-1);
}

.selection-quick-actions > :deep(.el-button + .el-button) {
  margin-left: 0;
}

.selection-bar :deep(.el-button) {
  min-height: 32px;
  font-size: 14px;
}

.selection-bar > :deep(.el-dropdown),
.selection-clear-button {
  flex: 0 0 auto;
}

.selection-bar :deep(.el-button > svg) {
  margin-left: var(--app-space-1);
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

.replace-preview-panel {
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-control);
  padding: var(--app-space-3);
  background: var(--app-surface-soft);
}

.reorder-preview-panel {
  display: grid;
  gap: var(--app-space-2);
}

.reorder-project-preview {
  display: grid;
  gap: var(--app-space-1);
  border: 1px solid var(--app-border-light);
  border-radius: var(--app-radius-control);
  padding: var(--app-space-2) var(--app-space-3);
  font-size: 12px;
}

.reorder-project-preview span {
  overflow-wrap: anywhere;
}

.replace-preview-panel ul {
  max-height: 150px;
  overflow: auto;
  margin: var(--app-space-2) 0 0;
  padding-left: var(--app-space-6);
}

:deep(.ledger-validation-dialog) {
  max-width: calc(100vw - 32px);
}

.validation-dialog-content {
  display: grid;
  gap: var(--app-space-3);
}

.validation-dialog-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--app-space-2) var(--app-space-3);
  align-items: baseline;
}

.validation-dialog-summary strong {
  color: var(--app-text);
  font-size: 15px;
}

.validation-dialog-summary span {
  color: var(--app-muted);
  font-size: 13px;
}

.validation-dialog-issues {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  border: 1px solid var(--app-warning);
  border-radius: var(--app-radius-control);
  padding: var(--app-space-3) var(--app-space-3) var(--app-space-3) var(--app-space-8);
  background: var(--app-warning-soft);
}

.validation-dialog-issues li.is-error {
  color: var(--app-danger-text);
}

.validation-dialog-issues li.is-warning {
  color: var(--app-warning-text);
  font-weight: 600;
}

.validation-dialog-issues li.is-suggestion {
  color: var(--app-primary-text);
}

.validation-dialog-outcome {
  margin: 0;
  border-left: 3px solid var(--app-warning);
  padding: var(--app-space-2) var(--app-space-2);
  background: var(--app-warning-soft);
  color: var(--app-text);
  line-height: 1.6;
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
  animation: ledger-cell-appear 180ms ease-out;
}

@keyframes ledger-cell-appear {
  from { opacity: 0.35; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .ledger-table-surface :deep(.cell-field-value) { animation: none; }
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

<!-- 台账浮层统一缩放淡入淡出：列工具面板 / 右键菜单 / 填充预览在组件内，
     单元格 tooltip 的 popper 挂在 body 下，因此这些类需要全局生效 -->
<style>
.ledger-overlay-pop-enter-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
  transform-origin: top left;
}

.ledger-overlay-pop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
  transform-origin: top left;
  pointer-events: none;
}

.ledger-overlay-pop-enter-from,
.ledger-overlay-pop-leave-to {
  opacity: 0;
  transform: scale(0.94);
}

@media (prefers-reduced-motion: reduce) {
  .ledger-overlay-pop-enter-active,
  .ledger-overlay-pop-leave-active {
    transition: none;
  }
}
</style>
