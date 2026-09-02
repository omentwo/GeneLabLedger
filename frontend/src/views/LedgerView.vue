<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Brush,
  CopyDocument,
  Delete,
  Document,
  Download,
  Lock,
  Minus,
  Plus,
  Refresh,
  Search,
  Setting,
  Unlock,
  Upload,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox, type TableColumnCtx } from "element-plus";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type CSSProperties,
} from "vue";
import { useRoute, useRouter } from "vue-router";

import { commitWorkbookImport, previewWorkbookImport } from "@/api/imports";
import {
  createLedgerNativePreview,
  getNativePreviewStatus,
  getPreviewCapabilities,
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
  assignRecordProject,
  applyRecordOperation,
  createRecord,
  deleteRecord,
  executeBulkDelete,
  getRecord,
  getRecordsByIds,
  previewBulkDelete,
  commitCellBatch,
  commitReplace,
  listRecords,
  previewCellBatch,
  previewReplace,
  queryRecordIds,
  queryRecords,
  setRecordLock,
  setCellsHighlight,
  setRecordsHighlight,
  setRecordsReportGenerated,
  updateRecord,
  validateNewRecord,
} from "@/api/records";
import type { RecordSearchScope } from "@/api/records";
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
  BulkDeleteFilter,
  BulkDeletePreview,
  WorkbookImportPreview,
  ProjectRecord,
  RecordStatus,
  RecordUpdateInput,
  NativePreviewAction,
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
  RecordValidationIssue,
} from "@/types/api";
import { formatShanghaiDateTime } from "@/utils/datetime";
import { desktopBridge } from "@/utils/desktop";
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
  resolveLedgerCellCompletionAction,
  resolveLedgerCellEditState,
} from "@/utils/ledgerPersistence";
import {
  applyLedgerTableView,
  getLedgerFieldValue,
  reanchorInsertedDraftGroup,
  type LedgerDraftPlacement,
  type LedgerFieldFilter,
  type LedgerFilterMap,
  type LedgerInsertedGroupRegistry,
  type LedgerRow,
  type LedgerSortState,
} from "@/utils/ledgerTableView";
import { summarizeLedgerSelection } from "@/utils/ledgerSelectionStats";
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
const selectionStartDate = ref("");
const selectionEndDate = ref("");
const ledgerTableCardRef = ref<HTMLElement | null>(null);
const projectStripRef = ref<HTMLElement | null>(null);
const tableRef = ref<{
  clearSelection: () => void;
  doLayout: () => void;
  setScrollTop?: (top: number) => void;
  toggleAllSelection: () => void;
  toggleRowSelection: (row: LedgerRow, selected?: boolean) => void;
} | null>(null);
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
  scrollDirection: -1 | 0 | 1;
};
type GridFillDragState = {
  pointerId: number;
  source: NormalizedGridRange;
  target: NormalizedGridRange;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  tableElement: HTMLElement;
  finishPromise: Promise<boolean>;
};
const activeGridCell = ref<GridCellPosition | null>(null);
const gridCellRange = ref<GridCellRange | null>(null);
const selectedGridCellKeys = ref<Set<string>>(new Set());
const gridSelectionAnchor = ref<GridCellPosition | null>(null);
const editingGridCell = ref<GridCellPosition | null>(null);
const editingGridSnapshot = ref<GridCellEditSnapshot | null>(null);
const gridSelectionDragging = ref(false);
let gridCellDragState: GridCellDragState | null = null;
let gridCellAutoScrollTimer: number | null = null;
let gridCellWheelUpdateTimer: number | null = null;
let gridCellEditFinishPromise: Promise<boolean> | null = null;
let lastGridClipboard: { plainText: string; payload: GridClipboardPayload } | null = null;
let suppressGridClick = false;
let gridFillDragState: GridFillDragState | null = null;
const gridFillPreviewRange = ref<NormalizedGridRange | null>(null);
const gridFillPreviewSource = ref<NormalizedGridRange | null>(null);
const gridFillPreviewValues = ref(new Map<string, string>());
const gridFillPreviewSummary = ref("");
const gridFillPreviewPointer = reactive({ left: 0, top: 0 });
let suppressGridFocusReset = false;
type SelectionRowInfo = {
  row: LedgerRow;
  index: number;
  element: HTMLTableRowElement;
};
type SelectionDragRange = { start: number; end: number };
type SelectionDragState = {
  pointerId: number;
  anchorIndex: number;
  currentIndex: number;
  lastRange: SelectionDragRange | null;
  dragging: boolean;
  mode: boolean;
  initialSelectionIds: Set<string>;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  tableElement: HTMLElement;
  scrollDirection: -1 | 0 | 1;
};
const selectionDragging = ref(false);
let selectionDragState: SelectionDragState | null = null;
let selectionAutoScrollTimer: number | null = null;
let suppressSelectionClick = false;
const selectionDragThreshold = 10;
let bottomScrollTimers: number[] = [];
const loading = ref(false);
const historyReplayLoading = ref(false);
const savingIds = ref(new Set<string>());
type CellSaveStatus = "dirty" | "saving" | "saved" | "error";
type CellSaveState = { status: CellSaveStatus; message?: string };
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
const frozenUntilFieldId = ref<string | null>(null);
const findReplaceVisible = ref(false);
const findReplaceLoading = ref(false);
const findReplacePreview = ref<RecordReplacePreview | null>(null);
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
  label: string;
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
const previewScope = ref<"selection" | "project" | "all">("all");
const previewEngine = ref<PrintEngine>("auto");
const previewCapabilities = ref<PreviewCapabilities | null>(null);
const nativePreviewLoading = ref(false);
const columnToolsVisible = ref(false);
const columnToolsOpenFieldId = ref("");
const columnToolsPosition = reactive({ left: 0, top: 0 });
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
  target: LedgerContextMenuTarget;
} | null>(null);
const exportVisible = ref(false);
const assignDialogVisible = ref(false);
const operationRecord = ref<ProjectRecord | null>(null);
const assignProjectId = ref("");
const searchText = ref("");
const searchStatus = ref("");
const searchDate = ref("");
const searchScope = ref<RecordSearchScope>("all");
const searchProjectIds = ref<string[]>([]);
const appliedSearch = reactive({
  text: "",
  status: "",
  date: "",
  // The scope control defaults to all projects, but the initial ledger load
  // remains a normal current-project data load until the user clicks Query.
  scope: "current" as RecordSearchScope,
  projectIds: [] as string[],
});
const exportFilter = reactive({
  start: "",
  end: "",
});
const draftRows = ref<LedgerRow[]>([]);
const globalSearchResults = ref<ProjectRecord[]>([]);
const globalSearchTotal = ref(0);
const focusRecordId = ref("");
const importFileInput = ref<HTMLInputElement | null>(null);
const importFile = ref<File | null>(null);
const importSheetName = ref("");
const importPreview = ref<WorkbookImportPreview | null>(null);
const importDialogVisible = ref(false);
const importLoading = ref(false);
const bulkDeleteDialogVisible = ref(false);
const bulkDeleteLoading = ref(false);
const bulkDeletePreview = ref<BulkDeletePreview | null>(null);
const highlightDialogVisible = ref(false);
const highlightLoading = ref(false);
const highlightColor = ref("#fff2cc");
const highlightTargetIds = ref<string[]>([]);
type HighlightMode = "record" | "cell";
type CellHighlightTarget = { recordId: string; fieldId: string };
const highlightMode = ref<HighlightMode>("record");
const highlightCellTargets = ref<CellHighlightTarget[]>([]);
const bulkDeleteFilter = reactive<BulkDeleteFilter>({
  project_id: "",
  date_field: "experiment_date",
  start_date: "",
  end_date: "",
});
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
let draftSequence = 0;
let loadSequence = 0;
let recordsAbortController: AbortController | null = null;
let removeQuickEntryChangedListener: (() => void) | undefined;
const currentPage = ref(1);
const pageSize = 200;
const recordTotal = ref(0);
const selectedRecordIds = ref(new Set<string>());
const selectedRecordCache = new Map<string, ProjectRecord>();
let ledgerInitialized = false;
let projectLoadPromise: Promise<void> | null = null;
let ledgerLayoutSaveQueue: Promise<void> = Promise.resolve();

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
const frozenFieldIds = computed(() => {
  const fieldId = frozenUntilFieldId.value;
  if (!fieldId) return new Set<string>();
  const end = fields.value.findIndex((field) => field.id === fieldId);
  return new Set(fields.value.slice(0, end + 1).map((field) => field.id));
});
const selectedCount = computed(() => selectedRecordIds.value.size);
const baseTableRows = computed<LedgerRow[]>(() => [...records.value, ...draftRows.value]);
const tableRows = computed<LedgerRow[]>(() =>
  applyLedgerTableView(baseTableRows.value, fields.value, ledgerSort.value, ledgerFilters.value),
);
const gridCellSelectionCount = computed(() => selectedGridCellKeys.value.size);
const hasGridCellSelection = computed(() => gridCellSelectionCount.value > 0);
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
  const rowIndex = tableRows.value.findIndex((row) => row.id === target.rowId);
  const columnIndex = fields.value.findIndex((field) => field.id === target.fieldId);
  return rowIndex >= 0 && columnIndex >= 0 ? { rowIndex, columnIndex } : null;
});
const contextMenuStyle = computed<CSSProperties>(() => ({
  left: `${ledgerContextMenu.value?.x ?? 0}px`,
  top: `${ledgerContextMenu.value?.y ?? 0}px`,
}));
const ledgerFontOption = computed(
  () =>
    LEDGER_FONT_FAMILY_OPTIONS.find(
      (option) => option.value === ledgerDisplaySettings.value.fontFamily,
    ) ?? LEDGER_FONT_FAMILY_OPTIONS[0],
);
const globalSearchActive = computed(() => appliedSearch.scope !== "current");
const ledgerTableStyle = computed<CSSProperties>(
  () =>
    ({
      "--ledger-row-gap": `${ledgerDisplaySettings.value.rowPaddingY}px`,
      "--ledger-editor-width": `${ledgerDisplaySettings.value.editorWidthPercent}%`,
      "--ledger-editor-height": `${Math.round((Math.max(32, ledgerDisplaySettings.value.fontSizePx + 18) * ledgerDisplaySettings.value.editorHeightPercent) / 100)}px`,
      "--ledger-selection-min-height": `${Math.max(32, ledgerDisplaySettings.value.fontSizePx + 18)}px`,
      "--ledger-font-family": ledgerFontOption.value?.css ?? "system-ui, sans-serif",
      "--ledger-font-size": `${ledgerDisplaySettings.value.fontSizePx}px`,
      "--ledger-zoom": String(ledgerDisplaySettings.value.zoomPercent / 100),
    }) as CSSProperties,
);
const importHasErrors = computed(
  () =>
    Boolean(importPreview.value?.errors.length) ||
    Boolean(importPreview.value?.rows.some((row) => row.errors.length)),
);
const importWarningCount = computed(
  () => importPreview.value?.rows.reduce((total, row) => total + row.warnings.length, 0) ?? 0,
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
  baseTableRows.value.forEach((row) => values.add(getLedgerFieldValue(row, field)));
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
  const rowIndex = tableRows.value.findIndex((row) => row.id === identity.rowId);
  const columnIndex = fields.value.findIndex((field) => field.id === identity.fieldId);
  return rowIndex >= 0 && columnIndex >= 0 ? { rowIndex, columnIndex } : null;
}

function clearSelectionsAfterLedgerViewChange(): void {
  activeGridCell.value = null;
  clearGridCellSelection();
  selectedRecords.value = [];
  selectedRecordIds.value = new Set();
  selectedRecordCache.clear();
  tableRef.value?.clearSelection();
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

function captureLedgerTableScroll(): LedgerTableScrollPosition | null {
  const tableRoot = ledgerTableCardRef.value;
  if (!tableRoot) return null;
  const body = gridTableBodyScrollElement(tableRoot);
  return body ? { top: body.scrollTop, left: body.scrollLeft } : null;
}

function restoreLedgerTableScroll(position: LedgerTableScrollPosition | null): void {
  if (!position) return;
  const tableRoot = ledgerTableCardRef.value;
  if (!tableRoot) return;
  const body = gridTableBodyScrollElement(tableRoot);
  if (!body) return;
  body.scrollTop = position.top;
  body.scrollLeft = position.left;
}

function setLedgerSort(field: FieldDefinition, order: "ascending" | "descending" | null): void {
  clearBottomScrollTimers();
  const activeIdentity = captureGridIdentity(activeGridCell.value);
  const anchorIdentity = captureGridIdentity(gridSelectionAnchor.value);
  const scrollPosition = captureLedgerTableScroll();
  ledgerSort.value = order ? { fieldId: field.id, order } : null;
  void persistLedgerProjectLayout();
  closeColumnTools();
  currentPage.value = 1;
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
  currentPage.value = 1;
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
  currentPage.value = 1;
  void loadRecords(activeProjectId.value, { preserveHistory: true });
}

function gridCellFromElement(element: EventTarget | null): GridCellPosition | null {
  if (!(element instanceof Element)) return null;
  const editor = element.closest<HTMLElement>("[data-row-id][data-field-index]");
  const cell = element.closest("td.ledger-editor-column");
  if (!editor || !cell) return null;
  const rowId = editor.dataset.rowId;
  const columnIndex = Number(editor.dataset.fieldIndex);
  if (!rowId || !Number.isInteger(columnIndex) || columnIndex < 0) return null;
  const rowIndex = tableRows.value.findIndex((row) => row.id === rowId);
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

function fieldIndexForTableColumn(column: TableColumnCtx<LedgerRow>): number {
  if (!column.columnKey || column.type === "selection") return -1;
  return fields.value.findIndex((field) => field.id === column.columnKey);
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

function gridHeaderCellClassName({
  column,
}: {
  row: LedgerRow;
  rowIndex: number;
  column: TableColumnCtx<LedgerRow>;
  columnIndex: number;
}): string {
  const state = column.columnKey
    ? gridHeaderSelectionState.value.get(column.columnKey)
    : undefined;
  if (state === "selected") return "grid-header-selected";
  if (state === "partial") return "grid-header-partial";
  return "";
}

async function handleLedgerHeaderClick(
  column: TableColumnCtx<LedgerRow>,
  event: PointerEvent,
): Promise<void> {
  const header = event.target instanceof Element ? event.target.closest("th") : null;
  // Element Plus marks a header with `noclick` while its resize handle is being
  // dragged. Do not turn a column-width adjustment into a grid selection.
  if (header?.classList.contains("noclick")) return;

  const fieldIndex = fieldIndexForTableColumn(column);
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

const gridCellClassName = computed(() => {
  const currentRows = tableRows.value;
  const currentFields = fields.value;
  const active = activeGridCell.value;
  const editing = editingGridCell.value;
  const selectedKeys = selectedGridCellKeys.value;
  const fillPreview = gridFillPreviewRange.value;
  const fillSource = gridFillPreviewSource.value;
  return ({ row, columnIndex }: { row: LedgerRow; columnIndex: number }): string => {
    const fieldIndex = columnIndex - 2;
    if (fieldIndex < 0 || fieldIndex >= currentFields.length) return "";
    const rowIndex = currentRows.findIndex((candidate) => candidate.id === row.id);
    if (rowIndex < 0) return "";
    const classes: string[] = [];
    const field = currentFields[fieldIndex];
    if (field && row.cell_highlight_colors?.[field.id]) {
      classes.push("cell-highlighted");
    }
    if (field && selectedKeys.has(`${row.id}${GRID_CELL_KEY_SEPARATOR}${field.id}`)) {
      classes.push("grid-cell-selected");
    }
    if (active?.rowIndex === rowIndex && active.columnIndex === fieldIndex) {
      classes.push("grid-cell-active");
    }
    if (editing?.rowIndex === rowIndex && editing.columnIndex === fieldIndex) {
      classes.push("grid-cell-editing");
    }
    if (
      fillPreview &&
      rowIndex >= fillPreview.rowStart &&
      rowIndex <= fillPreview.rowEnd &&
      fieldIndex >= fillPreview.columnStart &&
      fieldIndex <= fillPreview.columnEnd &&
      (!fillSource ||
        rowIndex < fillSource.rowStart ||
        rowIndex > fillSource.rowEnd ||
        fieldIndex < fillSource.columnStart ||
        fieldIndex > fillSource.columnEnd)
    ) {
      classes.push("grid-cell-fill-preview");
    }
    return classes.join(" ");
  };
});

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

async function finishGridCellEdit(commit = true, focusAfter = true): Promise<boolean> {
  if (gridCellEditFinishPromise) return gridCellEditFinishPromise;
  const editing = editingGridCell.value;
  const snapshot = editingGridSnapshot.value;
  if (!editing || !snapshot) return true;
  const finish = (async (): Promise<boolean> => {
    const data = gridCellData(editing);
    if (!data) {
      editingGridCell.value = null;
      editingGridSnapshot.value = null;
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

    editingGridCell.value = null;
    editingGridSnapshot.value = null;
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

function enterGridCellEdit(position: GridCellPosition, replaceValue?: string): void {
  const nextPosition = clampGridCell(position);
  const data = gridCellData(nextPosition);
  if (!data || data.record.locked) return;
  if (isGridCellEditing(nextPosition)) {
    void focusGridCell(nextPosition);
    return;
  }
  if (editingGridCell.value) {
    void finishGridCellEdit(true, false).then((saved) => {
      if (saved && !editingGridCell.value) enterGridCellEdit(nextPosition, replaceValue);
    });
    return;
  }
  activeGridCell.value = nextPosition;
  // Keep the single-cell selection visible so its fill handle remains available
  // while the input is being edited, matching spreadsheet-style workflows.
  selectGridCell(nextPosition);
  editingGridCell.value = nextPosition;
  editingGridSnapshot.value = {
    rowId: data.record.id,
    fieldId: data.field.id,
    value: valueFor(data.record, data.field),
  };
  if (replaceValue !== undefined) setValue(data.record, data.field, replaceValue);
  void focusGridCell(nextPosition);
}

function handleGridFocusOut(event: FocusEvent): void {
  const editing = editingGridCell.value;
  if (!editing) return;
  const relatedCell = gridCellFromElement(event.relatedTarget);
  if (sameGridCell(relatedCell, editing)) return;
  window.setTimeout(() => {
    if (!isGridCellEditing(editing)) return;
    const activeElement = document.activeElement;
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

function gridCellAtPoint(x: number, y: number): GridCellPosition | null {
  const element = document.elementFromPoint?.(x, y) ?? null;
  return gridCellFromElement(element);
}

function gridTableBodyScrollElement(tableElement: HTMLElement): HTMLElement | null {
  return (
    tableElement.querySelector<HTMLElement>(
      ".el-table__body-wrapper .el-scrollbar__wrap",
    ) ?? tableElement.querySelector<HTMLElement>(".el-table__body-wrapper")
  );
}

function clearGridCellAutoScroll(): void {
  if (gridCellAutoScrollTimer === null) return;
  window.clearInterval(gridCellAutoScrollTimer);
  gridCellAutoScrollTimer = null;
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
  let direction: -1 | 0 | 1 = 0;
  if (event.clientX >= rect.left && event.clientX <= rect.right) {
    if (event.clientY < rect.top + edgeSize) direction = -1;
    else if (event.clientY > rect.bottom - edgeSize) direction = 1;
  }
  if (state.scrollDirection === direction) return;

  state.scrollDirection = direction;
  clearGridCellAutoScroll();
  if (direction === 0) return;

  gridCellAutoScrollTimer = window.setInterval(() => {
    const currentState = gridCellDragState;
    if (!currentState) {
      clearGridCellAutoScroll();
      return;
    }
    const currentBody = gridTableBodyScrollElement(currentState.tableElement);
    const currentTop = currentBody?.scrollTop ?? 0;
    const maxTop = currentBody
      ? Math.max(0, currentBody.scrollHeight - currentBody.clientHeight)
      : 0;
    const nextTop = Math.max(0, Math.min(maxTop, currentTop + direction * 24));
    if (nextTop === currentTop) {
      currentState.scrollDirection = 0;
      clearGridCellAutoScroll();
      return;
    }
    if (tableRef.value?.setScrollTop) tableRef.value.setScrollTop(nextTop);
    else if (currentBody) currentBody.scrollTop = nextTop;
    const cell = gridCellAtDragPoint(currentState);
    if (cell) updateGridCellDrag(cell);
  }, 50);
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
  state.focus = clampGridCell(cell);
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
    replaceGridCellSelection(
      gridCellPositionsForRange(range),
      state.focus,
      state.anchor,
      range,
    );
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
    if (Math.hypot(movedX, movedY) < selectionDragThreshold) return;
    state.dragging = true;
    gridSelectionDragging.value = true;
    suppressGridClick = true;
    event.preventDefault();
  } else {
    event.preventDefault();
  }
  const cell = gridCellAtPoint(event.clientX, event.clientY);
  if (cell) updateGridCellDrag(cell);
  updateGridCellAutoScroll(event);
}

function handleGridPointerUp(event: PointerEvent): void {
  if (!gridCellDragState || gridCellDragState.pointerId !== event.pointerId) return;
  if (gridCellDragState.dragging) event.preventDefault();
  stopGridCellDrag();
}

function handleGridPointerCancel(event: PointerEvent): void {
  if (!gridCellDragState || gridCellDragState.pointerId !== event.pointerId) return;
  stopGridCellDrag();
}

function formatFilledDate(value: string, dayOffset: number): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  date.setDate(date.getDate() + dayOffset);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join(
    "-",
  );
}

function filledSeriesValue(
  sourceValues: string[],
  offset: number,
  field: FieldDefinition,
): string {
  if (!sourceValues.length) return "";
  const values = sourceValues.map((value) => value.trim());
  const dateField = field.data_type === "date" || field.system_key === "experiment_date";
  if (dateField && values.every((value) => Boolean(value))) {
    try {
      const dates = values.map(normalizeDate);
      const step = dates.length > 1
        ? Math.round(
            (new Date(`${dates.at(-1)}T00:00:00`).getTime() -
              new Date(`${dates.at(-2)}T00:00:00`).getTime()) /
              86_400_000,
          )
        : 1;
      return formatFilledDate(dates.at(-1) ?? dates[0] ?? "", step * (offset + 1));
    } catch {
      // Fall back to text cycling when the selected values are not valid dates.
    }
  }

  const numericPattern = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;
  if (values.every((value) => numericPattern.test(value))) {
    const numbers = values.map(Number);
    const step = numbers.length > 1 ? numbers.at(-1)! - numbers.at(-2)! : 1;
    const next = numbers.at(-1)! + step * (offset + 1);
    return Number.isInteger(next) ? String(next) : String(Number(next.toFixed(10)));
  }

  return values[offset % values.length] ?? "";
}

function buildGridFillEntries(
  source: NormalizedGridRange,
  target: NormalizedGridRange,
): GridPasteEntry[] {
  const extendsDown = target.rowEnd > source.rowEnd;
  const extendsRight = target.columnEnd > source.columnEnd;
  if (!extendsDown && !extendsRight) return [];

  const sourceHeight = source.rowEnd - source.rowStart + 1;
  const sourceWidth = source.columnEnd - source.columnStart + 1;
  const entries: GridPasteEntry[] = [];
  for (let rowIndex = source.rowStart; rowIndex <= target.rowEnd; rowIndex += 1) {
    for (let columnIndex = source.columnStart; columnIndex <= target.columnEnd; columnIndex += 1) {
      const isSourceCell = rowIndex <= source.rowEnd && columnIndex <= source.columnEnd;
      if (isSourceCell) continue;
      const field = fields.value[columnIndex];
      const record = tableRows.value[rowIndex];
      if (!field || !record) continue;

      const sourceColumnIndex =
        source.columnStart + ((columnIndex - source.columnStart) % sourceWidth);
      const sourceRowIndex = source.rowStart + ((rowIndex - source.rowStart) % sourceHeight);
      const sourceValues = extendsDown
        ? Array.from({ length: sourceHeight }, (_, index) =>
            valueFor(tableRows.value[source.rowStart + index]!, fields.value[sourceColumnIndex]!),
          )
        : Array.from({ length: sourceWidth }, (_, index) =>
            valueFor(tableRows.value[sourceRowIndex]!, fields.value[source.columnStart + index]!),
          );
      const offset = extendsDown
        ? rowIndex - source.rowEnd - 1
        : columnIndex - source.columnEnd - 1;
      entries.push({
        rowOffset: rowIndex - source.rowStart,
        columnOffset: columnIndex - source.columnStart,
        value: filledSeriesValue(sourceValues, offset, field),
      });
    }
  }
  return entries;
}

function gridFillTargetForCell(
  source: NormalizedGridRange,
  cell: GridCellPosition,
): NormalizedGridRange {
  return {
    rowStart: source.rowStart,
    rowEnd: Math.max(source.rowEnd, cell.rowIndex),
    columnStart: source.columnStart,
    columnEnd: Math.max(source.columnEnd, cell.columnIndex),
  };
}

function updateGridFillPreview(
  target: NormalizedGridRange,
  source: NormalizedGridRange,
  pointer?: { x: number; y: number },
  currentCell?: GridCellPosition,
): void {
  gridFillPreviewSource.value = { ...source };
  gridFillPreviewRange.value = { ...target };
  const entries = buildGridFillEntries(source, target);
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
): Promise<void> {
  const entries = buildGridFillEntries(source, target);
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
      anchor: { rowIndex: source.rowStart, columnIndex: source.columnStart },
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
    event.target instanceof Element ? event.target.closest<HTMLElement>(".el-table") : null;
  if (!tableElement) return;
  const finishPromise = editingGridCell.value
    ? finishGridCellEdit(true, false)
    : Promise.resolve(true);
  stopGridFillDrag();
  gridFillDragState = {
    pointerId: event.pointerId,
    source,
    target: { ...source },
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
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < selectionDragThreshold) {
      return;
    }
    state.dragging = true;
    suppressGridClick = true;
  }
  const cell = gridCellAtPoint(event.clientX, event.clientY);
  if (cell) {
    state.target = gridFillTargetForCell(state.source, cell);
    updateGridFillPreview(
      state.target,
      state.source,
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
  const finishPromise = state.finishPromise;
  if (shouldFill) {
    event.preventDefault();
    suppressGridClick = true;
  }
  stopGridFillDrag();
  if (shouldFill && (await finishPromise)) await applyGridFill(source, target);
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
    event.target instanceof Element ? event.target.closest<HTMLElement>(".el-table") : null;
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
    scrollDirection: 0,
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
        const now = new Date();
        value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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

function gridClipboardSelection(eventCell: GridCellPosition | null): {
  positions: GridCellPosition[];
  active: GridCellPosition;
} | null {
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

function buildGridClipboardData(selection: {
  positions: GridCellPosition[];
  active: GridCellPosition;
}): { plainText: string; payload: GridClipboardPayload } {
  return buildLedgerGridClipboardData(selection.positions, (position) => {
      const row = tableRows.value[position.rowIndex];
      const field = fields.value[position.columnIndex];
      return row && field ? valueFor(row, field) : "";
    });
}

function handleGridCopy(event: ClipboardEvent): void {
  const eventCell = gridCellFromElement(event.target);
  // Editing keeps the browser's native text-copy behavior. Cell/range copy
  // is only active while the grid itself owns the selection.
  if (eventCell && isGridCellEditing(eventCell)) {
    lastGridClipboard = null;
    return;
  }
  const selection = gridClipboardSelection(eventCell);
  if (!selection) return;
  const { plainText, payload } = buildGridClipboardData(selection);
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  lastGridClipboard = { plainText, payload };
  try {
    clipboard.setData(LEDGER_GRID_CLIPBOARD_MIME, JSON.stringify(payload));
  } catch {
    // Browsers may reject custom clipboard MIME types; text/plain remains usable.
  }
  clipboard.setData("text/plain", plainText);
  event.preventDefault();
  event.stopPropagation();
}

async function copyGridSelectionToClipboard(
  selectionOverride?: { positions: GridCellPosition[]; active: GridCellPosition },
): Promise<void> {
  const selection = selectionOverride ?? gridClipboardSelection(null);
  if (!selection) {
    ElMessage.warning("请先选择要复制的单元格");
    return;
  }
  const { plainText, payload } = buildGridClipboardData(selection);
  lastGridClipboard = { plainText, payload };
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
    ElMessage.success("已复制选中单元格");
  } catch {
    ElMessage.warning("浏览器未授予剪贴板权限，请使用 Ctrl/Cmd+C 复制");
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
  const rowIndex = tableRows.value.findIndex((candidate) => candidate.id === row.id);
  if (rowIndex < 0 || !fields.value.length) return null;
  const positions = fields.value.map((_, columnIndex) => ({ rowIndex, columnIndex }));
  return { positions, active: positions[0]! };
}

function positionLedgerContextMenu(event: MouseEvent): void {
  const width = 230;
  const height = 440;
  ledgerContextMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    target: ledgerContextMenu.value!.target,
  };
}

function handleLedgerContextMenu(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".ledger-column-tools-popover, .ledger-column-tools-trigger")) return;
  const cell = gridCellFromElement(event.target);
  if (cell && isGridCellEditing(cell)) return;
  const rowInfo = selectionRowFromElement(target);
  const row = cell ? tableRows.value[cell.rowIndex] : rowInfo?.row;
  if (!row || isDraft(row)) return;

  event.preventDefault();
  event.stopPropagation();
  closeColumnTools();
  if (cell && !isGridCellSelected(cell)) selectGridCell(cell);
  ledgerContextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    target: {
      kind: cell ? "cell" : "row",
      rowId: row.id,
      fieldId: cell ? fields.value[cell.columnIndex]?.id : undefined,
    },
  };
  positionLedgerContextMenu(event);
}

function finishContextMenuAction(): void {
  closeLedgerContextMenu();
}

async function contextCopy(): Promise<void> {
  const row = contextMenuRow.value;
  const cell = contextMenuCell.value;
  const selection =
    ledgerContextMenu.value?.target.kind === "row" && row
      ? (hasGridCellSelection ? gridClipboardSelection(null) : contextRowCopySelection(row))
      : cell
        ? gridClipboardSelection(cell)
        : null;
  await copyGridSelectionToClipboard(selection ?? undefined);
  finishContextMenuAction();
}

async function contextPaste(): Promise<void> {
  const cell = contextMenuCell.value;
  if (!cell) {
    ElMessage.warning("请右键一个单元格作为粘贴起点");
    finishContextMenuAction();
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    const customPayload = lastGridClipboard?.plainText === text ? lastGridClipboard.payload : null;
    if (!customPayload && !text) return;
    const start = clampGridCell(cell);
    const positions = await pasteGrid(
      null,
      start.rowIndex,
      start.columnIndex,
      customPayload?.cells,
      customPayload ? undefined : text,
    );
    replaceGridCellSelection(positions.length ? positions : [start], start, start, null);
    void focusGridCell(start);
  } catch {
    ElMessage.warning("浏览器未授予剪贴板权限，请使用 Ctrl/Cmd+V 粘贴");
  } finally {
    finishContextMenuAction();
  }
}

async function contextClear(): Promise<void> {
  if (!contextMenuCell.value) {
    ElMessage.warning("请先选择单元格");
    finishContextMenuAction();
    return;
  }
  await clearGridCellRange();
  finishContextMenuAction();
}

function contextSetHighlight(): void {
  const target = ledgerContextMenu.value?.target;
  const row = contextMenuRow.value;
  if (!target || !row) return finishContextMenuAction();
  if (target.kind === "row") openHighlightDialog([row]);
  else openCurrentHighlightDialog();
  finishContextMenuAction();
}

async function contextClearHighlight(): Promise<void> {
  const target = ledgerContextMenu.value?.target;
  const row = contextMenuRow.value;
  if (!target || !row) return finishContextMenuAction();
  if (target.kind === "row") {
    highlightMode.value = "record";
    highlightTargetIds.value = [row.id];
    await submitHighlight(null);
  } else {
    await clearSelectedHighlight();
  }
  finishContextMenuAction();
}

function contextEdit(): void {
  const cell = contextMenuCell.value;
  if (cell && selectedGridCellKeys.value.size === 1) enterGridCellEdit(cell);
  finishContextMenuAction();
}

async function contextToggleLock(): Promise<void> {
  const row = contextMenuRow.value;
  if (row && !isDraft(row)) await toggleRecordLock(row);
  finishContextMenuAction();
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
    const rowIndex = tableRows.value.findIndex((row) => row.id === inserted[0]?.id);
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

function contextInsertSingleRow(placement: LedgerDraftPlacement): void {
  const row = contextMenuRow.value;
  if (!row || isDraft(row)) return finishContextMenuAction();
  const anchorId = row.id;
  finishContextMenuAction();
  if (insertDraftRowsAt(anchorId, placement, 1)) notifyInsertedRows(1);
}

async function contextInsertMultipleRows(placement: LedgerDraftPlacement): Promise<void> {
  const row = contextMenuRow.value;
  if (!row || isDraft(row)) return finishContextMenuAction();
  const anchorId = row.id;
  finishContextMenuAction();
  try {
    const { value } = await ElMessageBox.prompt(
      "请输入要插入的行数（1–100）。可先填写任意字段，每行填写病理号后自动保存。",
      placement === "before" ? "在当前记录上方插入" : "在当前记录下方插入",
      {
        inputValue: "1",
        inputPlaceholder: "行数",
        confirmButtonText: "插入",
        cancelButtonText: "取消",
        inputValidator: (input) => {
          const count = Number(input.trim());
          return Number.isInteger(count) && count >= 1 && count <= 100
            ? true
            : "请输入 1 到 100 之间的整数";
        },
      },
    );
    const count = Number(value.trim());
    if (insertDraftRowsAt(anchorId, placement, count)) notifyInsertedRows(count);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "插入行失败");
  }
}

async function clearGridCellRange(): Promise<void> {
  const positions = selectedGridCellPositions();
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
      "清空",
    );
  }
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
  if (skippedLocked) ElMessage.info(`已跳过 ${skippedLocked} 个锁定单元格`);
  if (skippedRequired) ElMessage.info(`已跳过 ${skippedRequired} 个必填状态单元格`);
}

function selectionRowFromElement(element: Element | null): SelectionRowInfo | null {
  const candidate = element?.closest("tr.el-table__row");
  if (!candidate || candidate.tagName !== "TR") return null;
  const rowElement = candidate as HTMLTableRowElement;
  const body = rowElement.parentElement;
  if (!body || body.tagName !== "TBODY") return null;

  const rows = Array.from(body.children).filter(
    (child): child is HTMLTableRowElement =>
      child.tagName === "TR" && child.classList.contains("el-table__row"),
  );
  const index = rows.indexOf(rowElement);
  const row = index >= 0 ? tableRows.value[index] : undefined;
  if (!row) return null;
  return { row, index, element: rowElement };
}

function selectionRowAtPoint(x: number, y: number): SelectionRowInfo | null {
  const element = document.elementFromPoint?.(x, y) ?? null;
  return selectionRowFromElement(element);
}

function selectionRange(start: number, end: number): SelectionDragRange {
  return start <= end ? { start, end } : { start: end, end: start };
}

function applySelectionDragRange(state: SelectionDragState, index: number): void {
  const nextRange = selectionRange(state.anchorIndex, index);
  const previousRange = state.lastRange;
  if (
    previousRange &&
    previousRange.start === nextRange.start &&
    previousRange.end === nextRange.end
  ) {
    return;
  }

  const affectedIndexes = new Set<number>();
  if (previousRange) {
    for (let current = previousRange.start; current <= previousRange.end; current += 1) {
      affectedIndexes.add(current);
    }
  }
  for (let current = nextRange.start; current <= nextRange.end; current += 1) {
    affectedIndexes.add(current);
  }

  affectedIndexes.forEach((rowIndex) => {
    const row = tableRows.value[rowIndex];
    if (!row || isDraft(row)) return;
    const shouldSelect =
      rowIndex >= nextRange.start && rowIndex <= nextRange.end
        ? state.mode
        : state.initialSelectionIds.has(row.id);
    tableRef.value?.toggleRowSelection(row, shouldSelect);
  });
  state.lastRange = nextRange;
}

function clearSelectionAutoScroll(): void {
  if (selectionAutoScrollTimer === null) return;
  window.clearInterval(selectionAutoScrollTimer);
  selectionAutoScrollTimer = null;
}

function updateSelectionAutoScroll(event: PointerEvent): void {
  const state = selectionDragState;
  if (!state) return;
  const rect = state.tableElement.getBoundingClientRect();
  const edgeSize = 42;
  let direction: -1 | 0 | 1 = 0;
  if (event.clientX >= rect.left && event.clientX <= rect.right) {
    if (event.clientY < rect.top + edgeSize) direction = -1;
    else if (event.clientY > rect.bottom - edgeSize) direction = 1;
  }
  if (state.scrollDirection === direction) return;

  state.scrollDirection = direction;
  clearSelectionAutoScroll();
  if (direction === 0) return;

  selectionAutoScrollTimer = window.setInterval(() => {
    const currentState = selectionDragState;
    if (!currentState) {
      clearSelectionAutoScroll();
      return;
    }
    const body =
      currentState.tableElement.querySelector<HTMLElement>(
        ".el-table__body-wrapper .el-scrollbar__wrap",
      ) ??
      currentState.tableElement.querySelector<HTMLElement>(".el-table__body-wrapper");
    const currentTop = body?.scrollTop ?? 0;
    const maxTop = body ? Math.max(0, body.scrollHeight - body.clientHeight) : 0;
    const nextTop = Math.max(0, Math.min(maxTop, currentTop + direction * 24));
    if (nextTop === currentTop) {
      currentState.scrollDirection = 0;
      clearSelectionAutoScroll();
      return;
    }
    tableRef.value?.setScrollTop?.(nextTop);
    const rowInfo = selectionRowAtPoint(currentState.lastX, currentState.lastY);
    if (rowInfo) {
      currentState.currentIndex = rowInfo.index;
      applySelectionDragRange(currentState, rowInfo.index);
    }
  }, 50);
}

function stopSelectionDrag(resetClickSuppression = true): void {
  clearSelectionAutoScroll();
  document.removeEventListener("pointermove", handleSelectionPointerMove);
  document.removeEventListener("pointerup", handleSelectionPointerUp, true);
  document.removeEventListener("pointercancel", handleSelectionPointerCancel, true);
  selectionDragState = null;
  selectionDragging.value = false;
  if (resetClickSuppression) {
    window.setTimeout(() => {
      suppressSelectionClick = false;
    }, 0);
  }
}

function handleSelectionPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || event.isPrimary === false) return;
  const target = event.target instanceof Element ? event.target : null;
  const selectionCell = target?.closest("td.el-table-column--selection");
  if (!selectionCell || !target?.closest(".el-checkbox__input, .el-checkbox__original")) return;
  const rowInfo = selectionRowFromElement(selectionCell);
  if (!rowInfo || isDraft(rowInfo.row)) return;
  const tableElement = selectionCell.closest(".el-table");
  if (!(tableElement instanceof HTMLElement)) return;

  stopSelectionDrag(false);
  suppressSelectionClick = false;
  const initialSelectionIds = new Set(selectedRecords.value.map((record) => record.id));
  selectionDragState = {
    pointerId: event.pointerId,
    anchorIndex: rowInfo.index,
    currentIndex: rowInfo.index,
    lastRange: null,
    dragging: false,
    mode: !initialSelectionIds.has(rowInfo.row.id),
    initialSelectionIds,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    tableElement,
    scrollDirection: 0,
  };
  document.addEventListener("pointermove", handleSelectionPointerMove, { passive: false });
  document.addEventListener("pointerup", handleSelectionPointerUp, true);
  document.addEventListener("pointercancel", handleSelectionPointerCancel, true);
}

function handleSelectionPointerMove(event: PointerEvent): void {
  const state = selectionDragState;
  if (!state || state.pointerId !== event.pointerId) return;
  if ((event.buttons & 1) !== 1) {
    stopSelectionDrag();
    return;
  }
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  if (!state.dragging) {
    const movedX = event.clientX - state.startX;
    const movedY = event.clientY - state.startY;
    if (Math.hypot(movedX, movedY) < selectionDragThreshold) return;
    state.dragging = true;
    selectionDragging.value = true;
    suppressSelectionClick = true;
    event.preventDefault();
    applySelectionDragRange(state, state.anchorIndex);
  } else {
    event.preventDefault();
  }
  const rowInfo = selectionRowAtPoint(event.clientX, event.clientY);
  if (rowInfo) {
    state.currentIndex = rowInfo.index;
    applySelectionDragRange(state, rowInfo.index);
  }
  updateSelectionAutoScroll(event);
}

function handleSelectionPointerUp(event: PointerEvent): void {
  if (!selectionDragState || selectionDragState.pointerId !== event.pointerId) return;
  if (selectionDragState.dragging) {
    event.preventDefault();
    stopSelectionDrag();
    return;
  }
  stopSelectionDrag(false);
}

function handleSelectionPointerCancel(event: PointerEvent): void {
  if (!selectionDragState || selectionDragState.pointerId !== event.pointerId) return;
  stopSelectionDrag();
}

function handleSelectionClickCapture(event: MouseEvent): void {
  if (!suppressSelectionClick) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("td.el-table-column--selection .el-checkbox")) {
    event.preventDefault();
    event.stopPropagation();
  }
  suppressSelectionClick = false;
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

function scrollTableToBottom(): void {
  clearBottomScrollTimers();
  const applyScroll = () => {
    tableRef.value?.setScrollTop?.(Number.MAX_SAFE_INTEGER);
  };
  void nextTick(() => {
    applyScroll();
    bottomScrollTimers.push(window.setTimeout(applyScroll, 40));
    bottomScrollTimers.push(window.setTimeout(applyScroll, 140));
  });
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

async function remeasureVisibleTextareas(fieldId?: string): Promise<void> {
  await nextTick();
  autosizeTextareaRefs.forEach((instance, key) => {
    if (!fieldId || key.endsWith(`:${fieldId}`)) instance.resizeTextarea();
  });
  await nextTick();
  tableRef.value?.doLayout();
}

function refreshTableLayout(): void {
  void remeasureVisibleTextareas();
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

function valueFor(record: ProjectRecord, field: FieldDefinition): string {
  if (field.system_key === "pathology_number") return record.pathology_number;
  if (field.system_key === "block_number") return record.block_number ?? "";
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status;
  return record.values[field.id] ?? "";
}

function handleSearchScopeChange(scope: RecordSearchScope): void {
  if (scope === "selected") {
    if (!searchProjectIds.value.length && activeProjectId.value) {
      searchProjectIds.value = [activeProjectId.value];
    }
  } else {
    searchProjectIds.value = [];
  }
}

function globalMatchedValue(record: ProjectRecord): string {
  const term = appliedSearch.text.trim();
  if (!term) return "";
  const candidates = [
    record.project_name,
    record.pathology_number,
    record.block_number ?? "",
    record.experiment_number ?? "",
    ...Object.values(record.values),
  ];
  return candidates.find((value) => value.includes(term)) ?? "";
}

function scrollToFocusedRecord(): void {
  if (!focusRecordId.value) return;
  void nextTick(() => {
    const row = ledgerTableCardRef.value?.querySelector<HTMLElement>(
      ".search-focus-row",
    );
    row?.scrollIntoView({ block: "center" });
    window.setTimeout(() => {
      focusRecordId.value = "";
    }, 2200);
  });
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
  void current.finally(() => {
    if (recordSaveQueues.get(recordId) === current) recordSaveQueues.delete(recordId);
  });
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

function normalizeDate(value: string): string {
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
}

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
  selectedRecords.value = rows;
  const visibleIds = new Set(records.value.map((record) => record.id));
  const next = new Set(selectedRecordIds.value);
  visibleIds.forEach((recordId) => next.delete(recordId));
  visibleIds.forEach((recordId) => {
    if (!rows.some((record) => record.id === recordId)) selectedRecordCache.delete(recordId);
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
  selectedRecords.value = [];
  selectedRecordIds.value = new Set();
  selectedRecordCache.clear();
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
    ledgerHistory.clear();
    await loadRecords(activeProjectId.value, { showLoading: false, preserveHistory: true });
    throw error;
  } finally {
    historyReplayLoading.value = false;
  }
}

function reconcileCommittedPaste(
  entries: Array<{ record: LedgerRow; rowNumber: number }>,
  committedIds: string[],
  serverRecords: ProjectRecord[] = [],
): ProjectRecord[] | null {
  if (entries.length !== committedIds.length) return null;
  const committedDraftIds = new Set<string>();
  const committedRecords: ProjectRecord[] = [];
  entries.forEach(({ record }, index) => {
    const committedId = committedIds[index];
    if (!committedId) return;
    if (isDraft(record)) {
      const serverRecord = serverRecords.find((item) => item.id === committedId);
      const persistedRecord = serverRecord ?? ({ ...record, id: committedId } as LedgerRow);
      reanchorPendingInsertedDrafts(record, persistedRecord);
      if ("_draft" in persistedRecord) delete persistedRecord._draft;
      records.value.push(persistedRecord as ProjectRecord);
      committedRecords.push(persistedRecord as ProjectRecord);
      committedDraftIds.add(record.id);
      return;
    }
    rememberRecord(record);
    committedRecords.push(record);
  });
  if (committedDraftIds.size) {
    draftRows.value = draftRows.value.filter((row) => !committedDraftIds.has(row.id));
    cleanupInsertedGroupRegistry();
    recordTotal.value += committedDraftIds.size;
  }
  rememberAll();
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
      pendingValidationAction = errors.length
        ? null
        : async () => {
            const created = await createRecord(payload);
            finishPersistedDraft(record, created, projectId, notify);
          };
      validationPanel.value = {
        token: "",
        projectId,
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
    finishPersistedDraft(record, created, projectId, notify);
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录自动保存失败");
    return false;
  } finally {
    setSaving(record.id, false);
  }
}

function finishPersistedDraft(
  record: LedgerRow,
  created: ProjectRecord,
  projectId: string,
  notify: boolean,
): void {
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
      if (!record._insertAnchorId) scrollTableToBottom();
    }
    pushHistory("新增台账记录", [], [created], projectId);
    if (notify) {
      ElMessage.success(
        record._insertAnchorId ? "病理号已自动保存，记录位置已保留" : "病理号已自动保存，记录已加入表格底部",
      );
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
    validationPanel.value = null;
    pendingValidationAction = null;
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
        validationPanel.value = {
          token: preview.token,
          projectId: record.project_id,
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
        validationPanel.value = {
          token: "",
          projectId: record.project_id,
          label: `编辑 ${field.label}`,
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
      pendingValidationAction = null;
      await action();
      validationPanel.value = null;
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
    validationPanel.value = null;
    ElMessage.success(`已保存 ${new Set(result.changes.map((change) => change.record_id)).size} 条记录`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "批量保存失败");
  } finally {
    validationCommitLoading.value = false;
  }
}

function dismissValidationPanel(): void {
  pendingValidationAction = null;
  validationPanel.value = null;
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

async function openLedgerNative(action: NativePreviewAction): Promise<void> {
  if (!currentProject.value) return;
  if (!nativeEngineAvailable(previewEngine.value)) {
    ElMessage.warning("当前电脑未检测到可用的 Excel/WPS 表格程序");
    return;
  }
  const scope = previewScope.value;
  const cells = scope === "selection" ? selectedPreviewCells() : [];
  if (scope === "selection" && !cells.length) {
    ElMessage.warning("请先选择要预览的单元格");
    return;
  }
  nativePreviewLoading.value = true;
  try {
    const task = await createLedgerNativePreview(currentProject.value.id, {
      action,
      scope,
      cells,
      search: appliedSearch.text || undefined,
      status: appliedSearch.status || undefined,
      experiment_date: appliedSearch.date || undefined,
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
    ElMessage.error(error instanceof Error ? error.message : "台账撤销失败");
  }
}

async function redoLedger(): Promise<void> {
  try {
    const applied = await ledgerHistory.redo((entry) => replayHistoryEntry(entry, "redo"));
    if (applied) ElMessage.success("已恢复下一步台账操作");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "台账恢复失败");
  }
}

async function loadRecords(
  projectId = activeProjectId.value,
  options: { showLoading?: boolean; preserveHistory?: boolean; preserveSelection?: boolean } = {},
): Promise<void> {
  if (!options.preserveHistory) ledgerHistory.clear();
  const isGlobalScope = appliedSearch.scope !== "current";
  if (!projectId && !isGlobalScope) {
    records.value = [];
    globalSearchResults.value = [];
    globalSearchTotal.value = 0;
    return;
  }
  const showLoading = options.showLoading ?? true;
  const requestSequence = ++loadSequence;
  recordsAbortController?.abort();
  const controller = new AbortController();
  recordsAbortController = controller;
  if (showLoading) loading.value = true;
  try {
    let loaded: ProjectRecord[] = [];
    let total = 0;
    if (isGlobalScope) {
      let offset = 0;
      while (true) {
        const page = await listRecords({
          scope: appliedSearch.scope,
          project_id: undefined,
          project_ids:
            appliedSearch.scope === "selected" ? [...appliedSearch.projectIds] : undefined,
          status: appliedSearch.status || undefined,
          search: appliedSearch.text || undefined,
          experiment_date: appliedSearch.date || undefined,
          limit: 1000,
          offset,
        }, controller.signal);
        total = page.total;
        loaded.push(...page.items);
        offset += page.items.length;
        if (!page.items.length || offset >= page.total) break;
      }
    } else {
      const page = await queryRecords(buildRecordQuery(projectId), controller.signal);
      total = page.total;
      loaded = page.items;
    }
    if (requestSequence !== loadSequence || projectId !== activeProjectId.value) return;
    if (isGlobalScope) {
      records.value = [];
      draftRows.value = [];
      insertedGroupRegistry.clear();
      globalSearchResults.value = loaded;
      globalSearchTotal.value = total;
      persistedValues.clear();
    } else {
      records.value = loaded;
      recordTotal.value = total;
      globalSearchResults.value = [];
      globalSearchTotal.value = 0;
      tableProjectId.value = projectId;
    }
    activeGridCell.value = null;
    clearGridCellSelection();
    fieldErrors.value = {};
    clearAllCellSaveStates();
    selectedRecords.value = [];
    if (!options.preserveSelection) {
      selectedRecordIds.value = new Set();
      selectedRecordCache.clear();
    }
    if (!isGlobalScope) rememberAll();
    await nextTick();
    tableRef.value?.doLayout();
    if (!isGlobalScope && options.preserveSelection && selectedRecordIds.value.size) {
      records.value.forEach((record) => {
        if (selectedRecordIds.value.has(record.id)) {
          selectedRecordCache.set(record.id, record);
          tableRef.value?.toggleRowSelection(record, true);
        }
      });
    }
    if (!isGlobalScope) scrollToFocusedRecord();
  } catch (error) {
    if (requestSequence !== loadSequence || controller.signal.aborted) return;
    ElMessage.error(error instanceof Error ? error.message : "台账读取失败");
  } finally {
    if (requestSequence === loadSequence) {
      loading.value = false;
      if (recordsAbortController === controller) recordsAbortController = null;
    }
  }
}

function buildRecordQuery(projectId = activeProjectId.value): RecordComplexQuery {
  const fieldFilters: RecordFieldFilter[] = [];
  Object.entries(ledgerFilters.value).forEach(([fieldId, filter]) => {
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
    status: appliedSearch.status || null,
    search: appliedSearch.text || null,
    experiment_date_from: appliedSearch.date || null,
    experiment_date_to: appliedSearch.date || null,
    field_filters: fieldFilters,
    sort: ledgerSort.value
      ? {
          field_id: ledgerSort.value.fieldId,
          direction: ledgerSort.value.order === "descending" ? "desc" : "asc",
        }
      : null,
    limit: pageSize,
    offset: (currentPage.value - 1) * pageSize,
  };
}

function changeLedgerPage(page: number): void {
  currentPage.value = page;
  activeGridCell.value = null;
  clearGridCellSelection();
  editingGridCell.value = null;
  editingGridSnapshot.value = null;
  void loadRecords(activeProjectId.value, { preserveHistory: true, preserveSelection: true });
}

async function selectAllFilteredRecords(): Promise<void> {
  if (!activeProjectId.value) return;
  loading.value = true;
  try {
    const result = await queryRecordIds({
      ...buildRecordQuery(),
      limit: 1000,
      offset: 0,
    });
    selectedRecordCache.clear();
    selectedRecordIds.value = new Set(result.record_ids);
    tableRef.value?.clearSelection();
    const visibleSelected: ProjectRecord[] = [];
    records.value.forEach((record) => {
      if (selectedRecordIds.value.has(record.id)) {
        selectedRecordCache.set(record.id, record);
        tableRef.value?.toggleRowSelection(record, true);
        visibleSelected.push(record);
      }
    });
    selectedRecords.value = visibleSelected;
    ElMessage.success(`已选择全部 ${result.total} 条筛选结果`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "选择筛选结果失败");
  } finally {
    loading.value = false;
  }
}

async function ensureProjectLoaded(projectId: string): Promise<void> {
  if (activeProjectId.value !== projectId) {
    activeProjectId.value = projectId;
    await nextTick();
  }
  if (projectLoadPromise) await projectLoadPromise;
}

function applySearch(): void {
  try {
    const nextText = searchText.value.trim();
    const nextStatus = searchStatus.value;
    const nextDate = normalizeDate(searchDate.value);
    if (searchScope.value === "selected" && !searchProjectIds.value.length) {
      throw new Error("请选择至少一个项目");
    }
    if (
      searchScope.value !== "current" &&
      !nextText &&
      !nextStatus &&
      !nextDate
    ) {
      throw new Error("跨项目搜索时请至少填写一个搜索条件");
    }
    searchDate.value = nextDate;
    appliedSearch.text = nextText;
    appliedSearch.status = nextStatus;
    appliedSearch.date = nextDate;
    appliedSearch.scope = searchScope.value;
    appliedSearch.projectIds = [...searchProjectIds.value];
    currentPage.value = 1;
    void loadRecords();
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "筛选日期无效");
  }
}

function resetSearch(): void {
  searchText.value = "";
  searchStatus.value = "";
  searchDate.value = "";
  searchScope.value = "current";
  searchProjectIds.value = [];
  Object.assign(appliedSearch, { text: "", status: "", date: "" });
  Object.assign(appliedSearch, {
    scope: "current",
    projectIds: [],
  });
  currentPage.value = 1;
  void loadRecords(activeProjectId.value);
}

function refreshRecords(): void {
  void loadRecords(activeProjectId.value, { preserveHistory: true, preserveSelection: true });
}

function selectProject(projectId: string): void {
  const wasGlobalSearch = globalSearchActive.value;
  if (wasGlobalSearch) {
    searchScope.value = "current";
    searchProjectIds.value = [];
    appliedSearch.scope = "current";
    appliedSearch.projectIds = [];
  }
  if (activeProjectId.value === projectId) {
    if (wasGlobalSearch) void loadRecords(projectId, { preserveHistory: true });
    return;
  }
  currentPage.value = 1;
  activeProjectId.value = projectId;
}

function scrollProjectTabs(direction: -1 | 1): void {
  projectStripRef.value?.scrollBy({ left: direction * 240, behavior: "smooth" });
}

function openGlobalSearchResult(record: ProjectRecord): void {
  focusRecordId.value = record.id;
  searchScope.value = "current";
  searchProjectIds.value = [];
  appliedSearch.scope = "current";
  appliedSearch.projectIds = [];
  if (activeProjectId.value === record.project_id) {
    void loadRecords(record.project_id, { preserveHistory: true });
  } else {
    activeProjectId.value = record.project_id;
  }
}

function selectAllVisible(): void {
  const selectableRows = tableRows.value.filter((row) => !isDraft(row));
  const selectedIds = selectedRecordIds.value;
  if (selectableRows.every((row) => selectedIds.has(row.id))) return;
  const next = new Set(selectedIds);
  selectableRows.forEach((row) => {
    next.add(row.id);
    selectedRecordCache.set(row.id, row);
    tableRef.value?.toggleRowSelection(row, true);
  });
  selectedRecordIds.value = next;
  selectedRecords.value = selectableRows;
}

function invertVisibleSelection(): void {
  const selectedIds = new Set(selectedRecordIds.value);
  const next = new Set(selectedIds);
  const nextVisible: ProjectRecord[] = [];
  tableRef.value?.clearSelection();
  tableRows.value.forEach((row) => {
    if (isDraft(row)) return;
    const selected = !selectedIds.has(row.id);
    tableRef.value?.toggleRowSelection(row, selected);
    if (selected) {
      next.add(row.id);
      nextVisible.push(row);
      selectedRecordCache.set(row.id, row);
    } else {
      next.delete(row.id);
      selectedRecordCache.delete(row.id);
    }
  });
  selectedRecordIds.value = next;
  selectedRecords.value = nextVisible;
}

function selectByDateRange(): void {
  try {
    const startDate = normalizeDate(selectionStartDate.value);
    const endDate = normalizeDate(selectionEndDate.value);
    if (!startDate || !endDate) throw new Error("请选择开始日期和结束日期");
    if (startDate > endDate) throw new Error("开始日期不能晚于结束日期");
    tableRef.value?.clearSelection();
    tableRows.value.forEach((row) => {
      const date = row.experiment_date ?? "";
      if (!isDraft(row) && date >= startDate && date <= endDate) {
        tableRef.value?.toggleRowSelection(row, true);
      }
    });
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "日期无效");
  }
}

function rowCellStyle({
  row,
  column,
  columnIndex,
}: {
  row: LedgerRow;
  column?: { columnKey?: string };
  columnIndex?: number;
}): CSSProperties {
  const fieldIndex = typeof columnIndex === "number" ? columnIndex - 2 : -1;
  const fieldId = column?.columnKey ?? fields.value[fieldIndex]?.id;
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
      const before = records.value
        .filter((record) => recordIds.includes(record.id))
        .map(snapshotRecord);
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
    const before = records.value
      .filter((record) => recordIds.includes(record.id))
      .map(snapshotRecord);
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
  highlightTargetIds.value = recordIds;
  await submitHighlight(null);
}

async function handleManagerChanged(): Promise<void> {
  const changedProjectId = activeProjectId.value;
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

async function loadLedgerLayoutSettings(): Promise<void> {
  try {
    const result = await getSetting<unknown>(LEDGER_LAYOUT_SETTINGS_KEY);
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
  frozenUntilFieldId.value = layout.frozenUntilFieldId;
}

function persistLedgerProjectLayout(projectId = activeProjectId.value): Promise<void> {
  if (!projectId) return Promise.resolve();
  ledgerLayoutSettings.value = withLedgerProjectLayout(
    ledgerLayoutSettings.value,
    projectId,
    {
      sort: ledgerSort.value,
      filters: ledgerFilters.value,
      frozenUntilFieldId: frozenUntilFieldId.value,
    },
  );
  const snapshot = ledgerLayoutSettings.value;
  ledgerLayoutSaveQueue = ledgerLayoutSaveQueue
    .then(async () => {
      await putSetting(LEDGER_LAYOUT_SETTINGS_KEY, snapshot);
    })
    .catch((error) => {
      ElMessage.warning(error instanceof Error ? error.message : "台账布局设置保存失败");
    });
  return ledgerLayoutSaveQueue;
}

function freezeThroughField(field: FieldDefinition): void {
  frozenUntilFieldId.value = field.id;
  closeColumnTools();
  void persistLedgerProjectLayout();
  refreshTableLayout();
}

function clearFrozenFields(): void {
  frozenUntilFieldId.value = null;
  void persistLedgerProjectLayout();
  refreshTableLayout();
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
    "popup=yes,width=940,height=680,resizable=yes,scrollbars=no",
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
  findReplaceVisible.value = true;
}

async function runFindReplacePreview(): Promise<void> {
  if (!findReplaceForm.fieldId) {
    ElMessage.warning("请选择要处理的表头");
    return;
  }
  let recordIds = selectedRecordIdsForReplace();
  if (!selectedGridCellPositions().length) {
    const result = await queryRecordIds({ ...buildRecordQuery(), limit: 1000, offset: 0 });
    recordIds = result.record_ids;
  }
  if (!recordIds.length) {
    ElMessage.warning("当前范围没有记录");
    return;
  }
  findReplaceLoading.value = true;
  try {
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

function handleHeaderResize(
  newWidth: number,
  _oldWidth: number,
  column: { columnKey?: string },
): void {
  const fieldId = column.columnKey;
  if (!fieldId) return;
  const field = fields.value.find((item) => item.id === fieldId);
  if (!field) return;
  const width = Math.min(600, Math.max(58, Math.round(newWidth)));
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
  const existingChanges: RecordCellChange[] = [];
  const changedPositions: GridCellPosition[] = [];
  const changedPositionKeys = new Set<string>();
  let skippedLocked = 0;
  let changedCells = 0;

  try {
    const maxRowOffset = Math.max(...entries.map((entry) => entry.rowOffset), 0);
    const missingRows = startRowIndex + maxRowOffset + 1 - tableRows.value.length;
    for (let index = 0; index < missingRows; index += 1) appendDraftRow(false);
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
      ({ record }) => record.pathology_number.trim(),
    );
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
    const batchPreview = existingChanges.length || batchNewRecords.length
      ? await previewCellBatch(projectId, existingChanges, batchNewRecords)
      : null;
    const allIssues = batchPreview?.issues ?? [];
    const errors = allIssues.filter((issue) => issue.severity === "error");
    const warnings = allIssues.filter((issue) => issue.severity === "warning");
    const cellKeys = changedPositions.flatMap((position) => {
      const data = gridCellData(position);
      return data ? [persistedKey(data.record.id, data.field.id)] : [];
    });
    const cellVersions = Object.fromEntries(
      cellKeys.map((key) => [key, cellSaveVersions.get(key) ?? 0]),
    );

    const commitPasteChanges = async (acceptWarnings: boolean): Promise<void> => {
      const batchResult = batchPreview
        ? await commitCellBatch(
            batchPreview.token,
            acceptWarnings,
            committableDrafts.length > 0,
          )
        : null;
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
        if (!committedDraftRecords.length && batchResult?.created_record_ids.length) {
          await loadRecords(projectId, { showLoading: false, preserveHistory: true });
        }
        if (committedDraftRecords.length && committedAnchoredDraft) {
          await loadRecords(projectId, { showLoading: false, preserveHistory: true });
        }
      }
      if (committableDrafts.length && batchResult) {
        pushHistory(
          `${operationLabel}台账数据`,
          batchResult.before,
          batchResult.after,
          projectId,
        );
      } else if (batchResult) {
        pushCellHistory(`${operationLabel}台账数据`, batchResult.changes, projectId);
      }
      if (batchResult || committedDraftRecords.length) {
        ElMessage.success(`已${operationLabel} ${changedCells} 个单元格`);
      } else if (changedCells) {
        ElMessage.success(`已${operationLabel} ${changedCells} 个单元格，填写病理号后将自动保存`);
      }
      if (skippedLocked) ElMessage.info(`已跳过 ${skippedLocked} 个锁定单元格`);
    };

    if (errors.length || warnings.length) {
      pendingValidationAction = errors.length ? null : () => commitPasteChanges(true);
      validationPanel.value = {
        token: "",
        projectId,
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
    if (allIssues.length) {
      validationPanel.value = {
        token: "",
        projectId,
        label: `${operationLabel}台账数据`,
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
    await loadRecords(projectId, { showLoading: false });
    ElMessage.error(error instanceof Error ? error.message : "粘贴保存失败");
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

async function deleteSelectedRecords(): Promise<void> {
  const selectedTargets = await selectedTargetRecords();
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
  try {
    await ElMessageBox.confirm(
      `确认永久删除所选的 ${targets.length} 条台账记录${lockedNote}？删除后无法恢复。`,
      "批量删除二次确认",
      {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    throw error;
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
    records.value = records.value.filter((record) => !deletedIds.has(record.id));
    recordTotal.value = Math.max(0, recordTotal.value - deletedIds.size);
    selectedRecords.value = [];
    selectedRecordIds.value = new Set();
    selectedRecordCache.clear();
    activeGridCell.value = null;
    clearGridCellSelection();
    rememberAll();
    pushHistory(
      "批量删除台账记录",
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

function chooseWorkbookImport(): void {
  importFileInput.value?.click();
}

async function loadWorkbookImportPreview(sheetName = ""): Promise<void> {
  const file = importFile.value;
  const projectId = activeProjectId.value;
  if (!file || !projectId) return;
  importLoading.value = true;
  try {
    const preview = await previewWorkbookImport(projectId, file, sheetName);
    if (activeProjectId.value !== projectId) return;
    importPreview.value = preview;
    importSheetName.value = preview.selected_sheet;
    importDialogVisible.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "Excel 导入预览失败");
  } finally {
    importLoading.value = false;
  }
}

async function handleWorkbookFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = "";
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    ElMessage.warning("请选择 .xlsx 文件");
    return;
  }
  importFile.value = file;
  importSheetName.value = "";
  importPreview.value = null;
  await loadWorkbookImportPreview();
}

async function changeImportSheet(sheetName: string): Promise<void> {
  if (sheetName === importPreview.value?.selected_sheet) return;
  await loadWorkbookImportPreview(sheetName);
}

async function confirmWorkbookImport(): Promise<void> {
  const preview = importPreview.value;
  if (!preview || !preview.rows.length || importHasErrors.value) return;
  const projectId = activeProjectId.value;
  const rows = preview.rows.map(
    ({
      action: _action,
      errors: _errors,
      warnings: _warnings,
      suggestions: _suggestions,
      ...row
    }) => row,
  );
  const warningText = importWarningCount.value
    ? `其中有 ${importWarningCount.value} 条验证警告，继续即表示确认这些警告。`
    : "";
  try {
    await ElMessageBox.confirm(
      `将新建 ${preview.create_count} 条、更新 ${preview.update_count} 条记录。${warningText}记录 UUID 是唯一匹配依据，确认导入？`,
      "确认导入 Excel",
      {
        confirmButtonText: "确认导入",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    throw error;
  }

  importLoading.value = true;
  try {
    const beforeById = new Map(
      records.value.map((record) => [record.id, snapshotRecord(record)]),
    );
    const importRecordIds = [
      ...new Set(
        rows
          .map((row) => row.record_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const missingBefore = importRecordIds.filter((recordId) => !beforeById.has(recordId));
    if (missingBefore.length) {
      const fetched = await Promise.all(missingBefore.map((recordId) => getRecord(recordId)));
      fetched.forEach((record) => beforeById.set(record.id, snapshotRecord(record)));
    }
    const result = await commitWorkbookImport(projectId, rows, importWarningCount.value > 0);
    importDialogVisible.value = false;
    importFile.value = null;
    importPreview.value = null;
    await loadRecords(projectId, { showLoading: false, preserveHistory: true });
    const afterRecords = await Promise.all(
      result.record_ids.map((recordId) => getRecord(recordId)),
    );
    pushHistory(
      "导入 Excel 台账数据",
      rows
        .map((row) => row.record_id ? beforeById.get(row.record_id) : undefined)
        .filter((record): record is ProjectRecord => Boolean(record)),
      afterRecords.map(snapshotRecord),
      projectId,
    );
    ElMessage.success(`导入完成：新建 ${result.created} 条，更新 ${result.updated} 条`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "Excel 导入失败");
  } finally {
    importLoading.value = false;
  }
}

function openBulkDeleteDialog(): void {
  Object.assign(bulkDeleteFilter, {
    project_id: activeProjectId.value,
    date_field: "experiment_date",
    start_date: appliedSearch.date,
    end_date: appliedSearch.date,
  });
  bulkDeletePreview.value = null;
  bulkDeleteDialogVisible.value = true;
}

function invalidateBulkDeletePreview(): void {
  bulkDeletePreview.value = null;
}

async function previewDateRangeDelete(): Promise<void> {
  if (!bulkDeleteFilter.project_id) return;
  try {
    const start = normalizeDate(bulkDeleteFilter.start_date);
    const end = normalizeDate(bulkDeleteFilter.end_date);
    if (!start || !end) throw new Error("请选择开始日期和结束日期");
    if (start > end) throw new Error("开始日期不能晚于结束日期");
    bulkDeleteFilter.start_date = start;
    bulkDeleteFilter.end_date = end;
    bulkDeleteLoading.value = true;
    bulkDeletePreview.value = await previewBulkDelete({ ...bulkDeleteFilter });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "批量删除预览失败");
  } finally {
    bulkDeleteLoading.value = false;
  }
}

async function confirmDateRangeDelete(): Promise<void> {
  const preview = bulkDeletePreview.value;
  if (!preview?.total) return;
  if (preview.locked_count) {
    ElMessage.warning(`范围内有 ${preview.locked_count} 条锁定记录，请先解锁后重新预览`);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认永久删除预览中的 ${preview.total} 条记录？系统会在执行前再次核对记录清单，删除后无法恢复。`,
      "按日期批量删除",
      {
        confirmButtonText: "确认永久删除",
        cancelButtonText: "取消",
        type: "warning",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    throw error;
  }

  bulkDeleteLoading.value = true;
  try {
    const result = await executeBulkDelete(
      { ...bulkDeleteFilter },
      preview.record_ids,
    );
    bulkDeleteDialogVisible.value = false;
    bulkDeletePreview.value = null;
    const deletedIds = new Set(result.deleted_records.map((record) => record.id));
    records.value = records.value.filter((record) => !deletedIds.has(record.id));
    recordTotal.value = Math.max(0, recordTotal.value - result.deleted);
    activeGridCell.value = null;
    clearGridCellSelection();
    rememberAll();
    pushHistory("按日期批量删除台账记录", result.deleted_records, [], bulkDeleteFilter.project_id);
    ElMessage.success(`已删除 ${result.deleted} 条记录`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "按日期批量删除失败");
  } finally {
    bulkDeleteLoading.value = false;
  }
}
async function toggleRecordLock(record: ProjectRecord): Promise<void> {
  const nextLocked = !record.locked;
  try {
    replaceRecord(await setRecordLock(record.id, nextLocked));
    ElMessage.success(nextLocked ? "记录已锁定" : "记录已解锁");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "锁定状态修改失败");
  }
}

function openAssign(record: ProjectRecord): void {
  operationRecord.value = record;
  assignProjectId.value =
    appStore.projects.find((project) => project.id !== record.project_id)?.id ?? "";
  assignDialogVisible.value = true;
}

async function confirmAssign(): Promise<void> {
  if (!operationRecord.value || !assignProjectId.value) return;
  try {
    const assigned = await assignRecordProject(operationRecord.value.id, assignProjectId.value);
    // The source record stays in the current project; the operation creates a
    // new record in the target project.  Keeping the target project on the
    // history entry lets undo/redo switch there automatically.
    pushHistory("加入其他项目", [], [assigned], assigned.project_id);
    assignDialogVisible.value = false;
    ElMessage.success("已在目标项目建立独立台账记录");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "加入其他项目失败");
  }
}

async function removeRecord(record: ProjectRecord): Promise<void> {
  if (record.locked) {
    ElMessage.warning("记录已锁定，请先解锁");
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认删除病理号 ${record.pathology_number} 在 ${record.project_name} 项目中的台账记录？`,
      "删除台账记录",
      {
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    const before = snapshotRecord(record);
    await deleteRecord(record.id);
    tableRef.value?.toggleRowSelection(record, false);
    selectedRecords.value = selectedRecords.value.filter((item) => item.id !== record.id);
    const nextSelectedRecordIds = new Set(selectedRecordIds.value);
    nextSelectedRecordIds.delete(record.id);
    selectedRecordIds.value = nextSelectedRecordIds;
    selectedRecordCache.delete(record.id);
    records.value = records.value.filter((item) => item.id !== record.id);
    recordTotal.value = Math.max(0, recordTotal.value - 1);
    activeGridCell.value = null;
    clearGridCellSelection();
    pushHistory("删除台账记录", [before], [], before.project_id);
    ElMessage.success("台账记录已删除");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "记录删除失败");
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
  () => refreshTableLayout(),
);

watch(activeProjectId, async (projectId, previousProjectId) => {
  if (!ledgerInitialized || !projectId || projectId === previousProjectId) return;
  const load = (async () => {
    stopGridCellDrag(false);
    closeLedgerOverlays();
    applyLedgerProjectLayout(projectId);
    editingGridCell.value = null;
    editingGridSnapshot.value = null;
    clearSelectionsAfterLedgerViewChange();
    draftRows.value = [];
    insertedGroupRegistry.clear();
    selectionStartDate.value = "";
    selectionEndDate.value = "";
    importDialogVisible.value = false;
    importFile.value = null;
    importPreview.value = null;
    highlightDialogVisible.value = false;
    highlightTargetIds.value = [];
    highlightMode.value = "record";
    highlightCellTargets.value = [];
    bulkDeleteDialogVisible.value = false;
    bulkDeletePreview.value = null;
    persistedValues.clear();
    void router.replace({ query: { ...route.query, project: projectId } });
    await loadRecords(projectId, { preserveHistory: true });
    await nextTick();
    refreshTableLayout();
    scrollTableToBottom();
  })();
  projectLoadPromise = load;
  try {
    await load;
  } finally {
    if (projectLoadPromise === load) projectLoadPromise = null;
  }
}, { flush: "sync" });

async function initializeLedger(): Promise<void> {
  await appStore.bootstrap();
  await loadLedgerLayoutSettings();
  const queryProject =
    typeof route.query.project === "string" ? route.query.project : "";
  const initialProjectId = appStore.projects.some(
    (project) => project.id === queryProject,
  )
    ? queryProject
    : (appStore.projects[0]?.id ?? "");
  activeProjectId.value = initialProjectId;
  await nextTick();
  ledgerInitialized = true;
  if (!initialProjectId) {
    records.value = [];
    return;
  }
  appliedSearch.scope = "current";
  appliedSearch.projectIds = [];
  await router.replace({ query: { ...route.query, project: initialProjectId } });
  applyLedgerProjectLayout(initialProjectId);
  await loadRecords(initialProjectId);
  await nextTick();
  refreshTableLayout();
  scrollTableToBottom();
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
  document.addEventListener("click", handleSelectionClickCapture, true);
  document.addEventListener("pointerdown", handleLedgerDocumentPointerDown);
  document.addEventListener("keydown", handleLedgerDocumentKeydown);
  document.addEventListener("scroll", handleLedgerDocumentScroll, true);
  window.addEventListener("resize", handleLedgerDocumentScroll);
  const bridge = desktopBridge();
  if (bridge?.windowKind === "main") {
    removeQuickEntryChangedListener = bridge.onQuickEntryChanged((payload) => {
      if (payload.projectId !== activeProjectId.value) return;
      void loadRecords(payload.projectId, {
        showLoading: false,
        preserveHistory: true,
        preserveSelection: true,
      });
    });
  }
  void loadLedgerDisplaySettings();
  void loadPreviewEngineSetting();
  void loadPreviewCapabilities();
  void initializeLedger();
});

onBeforeUnmount(() => {
  ledgerHistory.clear();
  document.removeEventListener("click", handleSelectionClickCapture, true);
  document.removeEventListener("pointerdown", handleLedgerDocumentPointerDown);
  document.removeEventListener("keydown", handleLedgerDocumentKeydown);
  document.removeEventListener("scroll", handleLedgerDocumentScroll, true);
  window.removeEventListener("resize", handleLedgerDocumentScroll);
  removeQuickEntryChangedListener?.();
  removeQuickEntryChangedListener = undefined;
  stopGridCellDrag(false);
  stopGridFillDrag();
  stopSelectionDrag();
  recordsAbortController?.abort();
  recordsAbortController = null;
  editingGridCell.value = null;
  editingGridSnapshot.value = null;
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
  <div class="page-stack ledger-page" :class="{ 'global-search-mode': globalSearchActive }">
    <section class="page-card">
      <div class="page-card-body">
        <div class="ledger-toolbar">
          <div class="ledger-filter-group">
            <EditableDateInput
              v-model="searchDate"
              class="date-filter"
              placeholder="按实验日期筛选"
              @change="searchDate = $event"
            />
            <el-input
              v-model="searchText"
              clearable
              placeholder="搜索项目、病理号或任意表头内容"
              :prefix-icon="Search"
              @keyup.enter="applySearch"
              @clear="applySearch"
            />
            <el-select v-model="searchStatus" clearable placeholder="全部状态">
              <el-option label="待实验" value="待实验" />
              <el-option label="已完成" value="已完成" />
            </el-select>
            <el-select
              v-model="searchScope"
              class="search-scope-select"
              @change="handleSearchScopeChange"
            >
              <el-option label="当前项目" value="current" />
              <el-option label="全部项目" value="all" />
              <el-option label="选定项目" value="selected" />
            </el-select>
            <el-button class="ledger-query-button" type="primary" :icon="Search" @click="applySearch">
              查询
            </el-button>
            <el-button class="ledger-reset-button" @click="resetSearch">重置</el-button>
            <el-button class="ledger-refresh-button" :icon="Refresh" @click="refreshRecords">
              刷新
            </el-button>
          </div>
          <div v-if="!globalSearchActive" class="ledger-operation-group">
            <el-button
              class="ledger-history-button"
              text
              :disabled="!canUndoHistory"
              :loading="historyBusy"
              @click="undoLedger"
            >
              撤销
            </el-button>
            <el-button
              class="ledger-history-button"
              text
              :disabled="!canRedoHistory"
              :loading="historyBusy"
              @click="redoLedger"
            >
              恢复
            </el-button>
            <el-button
              :icon="Plus"
              type="primary"
              plain
              @click="appendDraftRow"
            >
              新增记录
            </el-button>
            <el-button :icon="Plus" @click="openQuickEntry">快速录入</el-button>
            <el-button @click="openFindReplace">查找替换</el-button>
            <el-button :icon="Download" @click="exportVisible = !exportVisible">
              导出 Excel
            </el-button>
            <el-button
              :icon="Setting"
              :type="columnToolsVisible ? 'primary' : undefined"
              @click="toggleColumnTools"
            >
              排序/筛选
            </el-button>
            <el-select
              v-model="previewEngine"
              class="ledger-preview-engine"
              aria-label="打印引擎"
              @change="savePreviewEngineSetting"
            >
              <el-option label="自动选择" value="auto" />
              <el-option label="Microsoft Excel" value="word" :disabled="!nativeEngineAvailable('word')" />
              <el-option label="WPS" value="wps" :disabled="!nativeEngineAvailable('wps')" />
            </el-select>
            <el-select v-model="previewScope" class="ledger-preview-scope" aria-label="预览范围">
              <el-option label="当前选区" value="selection" :disabled="!hasGridCellSelection" />
              <el-option label="当前项目" value="project" />
              <el-option label="整本台账" value="all" />
            </el-select>
            <el-button
              :loading="nativePreviewLoading"
              :disabled="!nativeEngineAvailable(previewEngine)"
              @click="openLedgerNative('preview')"
            >
              {{ nativeEngineLabel() }} 原生预览
            </el-button>
            <el-button
              :loading="nativePreviewLoading"
              :disabled="!nativeEngineAvailable(previewEngine)"
              @click="openLedgerNative('open')"
            >
              使用 {{ nativeEngineLabel() }} 打开
            </el-button>
            <input
              ref="importFileInput"
              class="hidden-file-input"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              @change="handleWorkbookFile"
            />
            <el-button :icon="Upload" :loading="importLoading" @click="chooseWorkbookImport">
              导入 Excel
            </el-button>
            <el-button type="danger" plain :icon="Delete" @click="openBulkDeleteDialog">
              按日期批量删除
            </el-button>
          </div>
          <div v-if="searchScope === 'selected'" class="ledger-search-advanced">
            <el-select
              v-model="searchProjectIds"
              class="search-project-select"
              multiple
              collapse-tags
              collapse-tags-tooltip
              filterable
              placeholder="选择项目"
            >
              <el-option
                v-for="project in appStore.projects"
                :key="project.id"
                :label="project.name"
                :value="project.id"
              />
            </el-select>
          </div>
        </div>
      </div>
    </section>

    <section v-if="exportVisible && !globalSearchActive" class="page-card export-panel">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">导出当前项目台账</h2>
          <p class="page-description">
            导出当前查询结果；可继续按实验日期缩小范围。
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

    <section v-if="globalSearchActive" class="page-card global-search-results">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">跨项目搜索结果</h2>
          <p class="page-description">
            共 {{ globalSearchTotal }} 条记录；点击结果可切换到对应项目并定位记录。
          </p>
        </div>
        <el-tag effect="plain">{{ appliedSearch.scope === "all" ? "全部项目" : "选定项目" }}</el-tag>
      </div>
      <el-table
        :data="globalSearchResults"
        border
        height="420"
        v-loading="loading"
        empty-text="没有匹配的跨项目记录"
        @row-click="openGlobalSearchResult"
      >
        <el-table-column prop="project_name" label="项目" min-width="160" />
        <el-table-column prop="pathology_number" label="病理号" min-width="150" />
        <el-table-column prop="experiment_number" label="实验编号" min-width="150" />
        <el-table-column prop="status" label="状态" width="100" />
        <el-table-column prop="experiment_date" label="实验日期" width="130" />
        <el-table-column label="命中内容" min-width="220">
          <template #default="{ row }: { row: ProjectRecord }">
            {{ globalMatchedValue(row) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }: { row: ProjectRecord }">
            <el-button link type="primary" @click.stop="openGlobalSearchResult(row)">
              打开台账
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="!globalSearchActive" class="selection-bar">
      <strong v-if="hasGridCellSelection">已选 {{ gridCellSelectionCount }} 个单元格</strong>
      <strong v-else>已选 {{ selectedCount }} 条记录</strong>
      <div class="selection-quick-actions" aria-label="快速选择">
        <el-button @click="selectAllVisible">全选当前页</el-button>
        <el-button @click="selectAllFilteredRecords">选择全部筛选结果</el-button>
        <el-button @click="invertVisibleSelection">反选</el-button>
      </div>
      <EditableDateInput
        v-model="selectionStartDate"
        class="selection-date"
        placeholder="开始日期"
      />
      <span class="selection-date-separator">至</span>
      <EditableDateInput
        v-model="selectionEndDate"
        class="selection-date"
        placeholder="结束日期"
      />
      <el-button @click="selectByDateRange">按日期范围选择</el-button>
      <el-button @click="updateSelectedStatus('已完成')">
        已完成
      </el-button>
      <el-button @click="updateSelectedStatus('待实验')">
        待实验
      </el-button>
      <el-button
        :icon="Brush"
        :disabled="gridCellInternalEditing || (!selectedCount && !hasGridCellSelection)"
        @click="openCurrentHighlightDialog"
      >
        {{ hasGridCellSelection ? "设置单元格底色" : "设置底色" }}
      </el-button>
      <el-button
        :icon="Delete"
        plain
        :loading="highlightLoading"
        :disabled="gridCellInternalEditing || (!selectedCount && !hasGridCellSelection)"
        @click="clearSelectedHighlight"
      >
        {{ hasGridCellSelection ? "清除单元格底色" : "清除底色" }}
      </el-button>
      <el-button :icon="Lock" @click="updateSelectedLock(true)">
        锁定
      </el-button>
      <el-button :icon="Unlock" @click="updateSelectedLock(false)">
        解锁
      </el-button>
      <el-button @click="updateSelectedReportStatus(true)">
        已生成报告
      </el-button>
      <el-button @click="updateSelectedReportStatus(false)">
        待生成报告
      </el-button>
      <el-button
        type="danger"
        plain
        :icon="Delete"
        @click="deleteSelectedRecords"
      >
        删除所选
      </el-button>
      <el-button :icon="Setting" class="manage-project-button" @click="managerVisible = true">
        管理检测项目与表头
      </el-button>
    </section>

    <section
      v-if="!globalSearchActive"
      ref="ledgerTableCardRef"
      class="page-card ledger-table-card"
      @pointerdown.capture="handleGridPointerDown"
      @click.capture="handleGridClick"
      @dblclick.capture="handleGridDoubleClick"
      @focusin.capture="handleGridFocusIn"
      @focusout.capture="handleGridFocusOut"
      @keydown.capture="handleGridKeydown"
      @copy.capture="handleGridCopy"
      @paste.capture="handleGridPaste"
      @contextmenu.capture="handleLedgerContextMenu"
    >
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
      <div class="ledger-table-surface" :style="ledgerTableStyle">
      <el-table
        ref="tableRef"
        :class="{
          'selection-dragging': selectionDragging,
          'grid-selection-dragging': gridSelectionDragging,
        }"
        v-loading="loading"
        element-loading-text="正在切换或读取项目数据…"
        element-loading-background="#ffffff"
        :data="tableRows"
        row-key="id"
        border
        :fit="false"
        table-layout="fixed"
        scrollbar-always-on
        :select-on-indeterminate="false"
        empty-text="当前项目暂无记录"
        height="100%"
        :row-class-name="rowClassName"
        :row-style="rowStyle"
        :cell-style="rowCellStyle"
        :cell-class-name="gridCellClassName"
        :header-cell-class-name="gridHeaderCellClassName"
        @selection-change="handleTableSelectionChange"
        @pointerdown="handleSelectionPointerDown"
        @header-click="handleLedgerHeaderClick"
        @header-dragend="handleHeaderResize"
      >
        <el-table-column
          type="selection"
          width="55"
          fixed="left"
          align="center"
          reserve-selection
          :selectable="(row: LedgerRow) => !isDraft(row)"
        />
        <el-table-column width="42" fixed="left" align="center">
          <template #default="{ row }: { row: LedgerRow }">
            <el-icon v-if="row.locked" class="row-lock" title="整条记录已锁定">
              <Lock />
            </el-icon>
          </template>
        </el-table-column>

        <el-table-column
          v-for="(field, columnIndex) in fields"
          :key="field.id"
          :column-key="field.id"
          class-name="ledger-editor-column"
          :label="field.label"
          :width="field.width"
          :fixed="frozenFieldIds.has(field.id) ? 'left' : undefined"
          align="center"
          header-align="center"
          resizable
        >
          <template #header>
            <div class="ledger-header-label">
              <span>{{ field.label }}</span>
              <button
                v-if="columnToolsVisible"
                type="button"
                class="ledger-column-tools-trigger"
                :class="{
                  active: columnToolsOpenFieldId === field.id,
                  sorted: ledgerSort?.fieldId === field.id,
                  filtered: Boolean(ledgerFilters[field.id]),
                }"
                :aria-label="`打开${field.label}排序和筛选`"
                @pointerdown.stop
                @click.stop="openColumnTools(field, $event)"
                @dblclick.stop
                @contextmenu.stop.prevent
              >
                <Setting />
              </button>
              <span v-if="ledgerSort?.fieldId === field.id" class="ledger-sort-indicator">
                {{ ledgerSort.order === 'ascending' ? '↑' : '↓' }}
              </span>
              <span v-if="ledgerFilters[field.id]" class="ledger-filter-indicator" />
            </div>
          </template>
          <template #default="{ row, $index }: { row: LedgerRow; $index: number }">
            <div
              class="cell-field"
              :class="{
                'cell-field-invalid': fieldErrorFor(row, field),
                'cell-field-editing': isGridCellEditing({ rowIndex: $index, columnIndex }),
              }"
              :data-row-id="row.id"
              :data-field-index="columnIndex"
              :tabindex="isGridCellEditing({ rowIndex: $index, columnIndex }) ? -1 : 0"
            >
              <EditableDateInput
                v-if="field.data_type === 'date' || field.system_key === 'experiment_date'"
                :model-value="valueFor(row, field)"
                :readonly="row.locked || !isGridCellEditing({ rowIndex: $index, columnIndex })"
                @update:model-value="setValue(row, field, $event)"
                @change="saveField(row, field)"
              />
              <EditableChoiceInput
                v-else-if="field.options.length || field.data_type === 'select'"
                :model-value="valueFor(row, field)"
                :options="fieldOptions(field)"
                :readonly="row.locked || !isGridCellEditing({ rowIndex: $index, columnIndex })"
                @update:model-value="setValue(row, field, $event)"
                @change="saveField(row, field)"
              />
              <el-input
                v-else-if="!field.is_core"
                :ref="(instance: unknown) => setAutosizeTextareaRef(instance, row.id, field.id)"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 5 }"
                resize="none"
                :model-value="valueFor(row, field)"
                :readonly="row.locked || !isGridCellEditing({ rowIndex: $index, columnIndex })"
                :inputmode="field.data_type === 'number' ? 'decimal' : undefined"
                @update:model-value="setValue(row, field, String($event))"
                @change="saveField(row, field)"
              />
              <el-input
                v-else
                :model-value="valueFor(row, field)"
                :readonly="row.locked || !isGridCellEditing({ rowIndex: $index, columnIndex })"
                :inputmode="field.data_type === 'number' ? 'decimal' : undefined"
                @update:model-value="setValue(row, field, String($event))"
                @change="saveField(row, field)"
              />
              <span
                v-if="gridFillPreviewValue($index, columnIndex) !== null"
                class="grid-fill-preview-value"
              >
                {{ gridFillPreviewValue($index, columnIndex) || "（空）" }}
              </span>
              <span
                v-if="isGridFillHandleCell($index, columnIndex)"
                class="grid-fill-handle"
                role="button"
                tabindex="-1"
                aria-label="拖动或双击自动填充"
                title="拖动填充；双击向下自动填充"
                @pointerdown.stop.prevent="handleGridFillPointerDown"
              />
              <span v-if="fieldErrorFor(row, field)" class="cell-field-error">
                {{ fieldErrorFor(row, field) }}
              </span>
              <span
                v-if="cellSaveStateFor(row, field)"
                class="cell-save-state"
                :class="`is-${cellSaveStateFor(row, field)?.status}`"
                :title="cellSaveStateFor(row, field)?.message ?? ''"
              >
                {{
                  cellSaveStateFor(row, field)?.status === 'saving'
                    ? '保存中'
                    : cellSaveStateFor(row, field)?.status === 'saved'
                      ? '已保存'
                      : cellSaveStateFor(row, field)?.status === 'error'
                        ? '失败'
                        : '未保存'
                }}
              </span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="86" fixed="right" align="center" header-align="center">
          <template #default="{ row }: { row: LedgerRow }">
            <span v-if="isDraft(row)" class="draft-row-hint">
              待保存
            </span>
            <div v-else class="row-actions">
              <el-button
                link
                :icon="row.locked ? Unlock : Lock"
                :title="row.locked ? '解锁记录' : '锁定记录'"
                @click="toggleRecordLock(row)"
              />
              <el-dropdown trigger="click">
                <el-button link type="primary" aria-label="更多操作">更多</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item :icon="CopyDocument" @click="openAssign(row)">
                      加入其他项目
                    </el-dropdown-item>
                    <el-dropdown-item :icon="Brush" @click="openHighlightDialog([row])">
                      设置底色
                    </el-dropdown-item>
                    <el-dropdown-item :icon="Document">
                      <RouterLink
                        class="dropdown-router-link"
                        :to="{ path: '/reports', query: { project: row.project_id, record: row.id } }"
                      >
                        打印报告
                      </RouterLink>
                    </el-dropdown-item>
                    <el-dropdown-item
                      :icon="Delete"
                      divided
                      :disabled="row.locked"
                      @click="removeRecord(row)"
                    >
                      删除记录
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>
      </div>
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
        <div class="ledger-column-tools-sort">
          <el-button size="small" @click="freezeThroughField(columnToolsField)">冻结到此列</el-button>
          <el-button size="small" :disabled="!frozenUntilFieldId" @click="clearFrozenFields">
            取消冻结
          </el-button>
        </div>
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
      <div
        v-if="ledgerContextMenu"
        class="ledger-context-menu"
        :style="contextMenuStyle"
        role="menu"
        @pointerdown.stop
        @click.stop
        @contextmenu.prevent
      >
        <button type="button" role="menuitem" @click="contextInsertSingleRow('before')">
          在当前记录上方插入一行
        </button>
        <button type="button" role="menuitem" @click="contextInsertMultipleRows('before')">
          在当前记录上方插入多行…
        </button>
        <button type="button" role="menuitem" @click="contextInsertSingleRow('after')">
          在当前记录下方插入一行
        </button>
        <button type="button" role="menuitem" @click="contextInsertMultipleRows('after')">
          在当前记录下方插入多行…
        </button>
        <div class="ledger-context-menu-separator" role="separator" />
        <button type="button" role="menuitem" @click="contextCopy">复制当前选区</button>
        <button
          type="button"
          role="menuitem"
          :disabled="ledgerContextMenu.target.kind !== 'cell'"
          @click="contextPaste"
        >
          粘贴到活动单元格
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="ledgerContextMenu.target.kind !== 'cell' || !hasGridCellSelection"
          @click="contextClear"
        >
          清空当前选区
        </button>
        <button type="button" role="menuitem" @click="contextSetHighlight">
          {{ ledgerContextMenu.target.kind === 'row' ? '设置记录底色' : '设置单元格底色' }}
        </button>
        <button type="button" role="menuitem" @click="contextClearHighlight">
          {{ ledgerContextMenu.target.kind === 'row' ? '清除记录底色' : '清除单元格底色' }}
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="ledgerContextMenu.target.kind !== 'cell' || selectedGridCellKeys.size !== 1 || Boolean(contextMenuRow?.locked)"
          @click="contextEdit"
        >
          进入编辑
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!contextMenuRow"
          @click="contextToggleLock"
        >
          {{ contextMenuRow?.locked ? '解锁当前记录' : '锁定当前记录' }}
        </button>
      </div>
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
            @click="selectProject(project.id)"
          >
            <span>{{ project.name }}</span>
          </button>
        </section>
        <div class="ledger-zoom-footer">
          <div v-if="selectedGridStats.selected" class="ledger-selection-stats">
            <span>选中 {{ selectedGridStats.selected }}</span>
            <span>非空 {{ selectedGridStats.nonEmpty }}</span>
            <span v-if="selectedGridStats.numericCount">数字 {{ selectedGridStats.numericCount }}</span>
            <span v-if="selectedGridStats.numericCount">合计 {{ selectedGridStats.sum }}</span>
            <span v-if="selectedGridStats.average !== null">平均 {{ selectedGridStats.average.toFixed(2) }}</span>
            <span v-if="selectedGridStats.min !== null">最小 {{ selectedGridStats.min }}</span>
            <span v-if="selectedGridStats.max !== null">最大 {{ selectedGridStats.max }}</span>
            <span>状态 {{ cellSaveStatusLabels[selectedGridStats.saveStatus] }}</span>
          </div>
          <el-pagination
            v-model:current-page="currentPage"
            :page-size="pageSize"
            :total="recordTotal"
            layout="total, prev, pager, next"
            size="small"
            @current-change="changeLedgerPage"
          />
          <div class="ledger-zoom-control" aria-label="台账缩放">
            <el-button text :icon="Minus" :disabled="historyReplayLoading" @click="zoomOut" />
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
            <el-button text :icon="Plus" :disabled="historyReplayLoading" @click="zoomIn" />
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

  <el-dialog v-model="findReplaceVisible" title="查找替换" width="660px">
    <el-form label-position="top">
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
    <div v-if="findReplacePreview" class="replace-preview-panel">
      <strong>匹配 {{ findReplacePreview.matched_count }} 个单元格</strong>
      <span v-if="findReplacePreview.skipped_locked">，跳过锁定 {{ findReplacePreview.skipped_locked }} 个</span>
      <ul v-if="findReplacePreview.issues.length">
        <li v-for="(issue, index) in findReplacePreview.issues.slice(0, 20)" :key="index">
          {{ issue.message }}
        </li>
      </ul>
    </div>
    <template #footer>
      <el-button @click="findReplaceVisible = false">取消</el-button>
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

  <div v-if="validationPanel" class="validation-panel" role="status">
    <div>
      <strong>{{ validationPanel.label }}</strong>
      <span>影响 {{ validationPanel.affectedCount }} 个单元格</span>
      <span v-if="validationPanel.skippedLocked">，跳过锁定 {{ validationPanel.skippedLocked }} 个</span>
      <ul>
        <li v-for="(issue, index) in validationPanel.issues.slice(0, 20)" :key="index" :class="`is-${issue.severity}`">
          {{ issue.message }}
        </li>
      </ul>
    </div>
    <div class="validation-panel-actions">
      <el-button @click="dismissValidationPanel">关闭</el-button>
      <el-button
        v-if="validationPanel.canContinue"
        type="primary"
        :loading="validationCommitLoading"
        @click="continueValidationCommit"
      >
        忽略警告并继续
      </el-button>
    </div>
  </div>

  <el-dialog v-model="assignDialogVisible" title="复制为其他项目记录" width="480px">
    <p class="dialog-note">
      目标项目会建立一个全新的记录 UUID。病理号只是普通字段，相同病理号之间不会联动。
    </p>
    <el-form label-position="top">
      <el-form-item label="病理号">
        <el-input :model-value="operationRecord?.pathology_number" readonly />
      </el-form-item>
      <el-form-item label="目标项目">
        <el-select v-model="assignProjectId" style="width: 100%">
          <el-option
            v-for="project in appStore.projects.filter(
              (item) => item.id !== operationRecord?.project_id,
            )"
            :key="project.id"
            :label="project.name"
            :value="project.id"
          />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="assignDialogVisible = false">取消</el-button>
      <el-button type="primary" @click="confirmAssign">确认加入</el-button>
    </template>
  </el-dialog>

  <el-dialog
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
                ✓
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
              ✓
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

  <el-dialog
    v-model="importDialogVisible"
    title="导入 Excel 台账"
    width="980px"
    destroy-on-close
  >
    <div v-loading="importLoading" class="import-dialog-body">
      <div v-if="importPreview" class="import-summary">
        <span>文件：{{ importPreview.filename }}</span>
        <el-select
          v-if="importPreview.available_sheets.length > 1"
          v-model="importSheetName"
          class="sheet-select"
          @change="changeImportSheet"
        >
          <el-option
            v-for="sheet in importPreview.available_sheets"
            :key="sheet"
            :label="sheet"
            :value="sheet"
          />
        </el-select>
        <el-tag type="success">新建 {{ importPreview.create_count }}</el-tag>
        <el-tag type="warning">更新 {{ importPreview.update_count }}</el-tag>
      </div>
      <el-alert
        v-if="importPreview?.errors.length"
        type="error"
        :closable="false"
        :title="importPreview.errors.join('；')"
        show-icon
      />
      <p class="dialog-note">
        新版导出文件通过隐藏的记录 UUID 匹配并更新；没有 UUID 的旧版 Excel 每一行都新建独立记录，绝不按病理号合并。
      </p>
      <el-table
        v-if="importPreview"
        :data="importPreview.rows"
        border
        height="380"
        empty-text="工作表中没有可导入的数据行"
      >
        <el-table-column prop="row_number" label="行" width="64" />
        <el-table-column label="操作" width="82">
          <template #default="{ row }">
            <el-tag :type="row.action === 'create' ? 'success' : 'warning'" size="small">
              {{ row.action === "create" ? "新建" : "更新" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="pathology_number" label="病理号" min-width="160" />
        <el-table-column prop="block_number" label="蜡块号" min-width="110" />
        <el-table-column prop="status" label="状态" width="90" />
        <el-table-column prop="experiment_date" label="实验日期" width="120" />
        <el-table-column prop="experiment_number" label="实验编号" min-width="150" />
        <el-table-column label="校验" min-width="240">
          <template #default="{ row }">
            <span v-if="row.errors.length" class="invalid-row-text">{{ row.errors.join("；") }}</span>
            <span v-else-if="row.warnings.length" class="warning-row-text">
              警告：{{ row.warnings.join("；") }}
            </span>
            <span v-else-if="row.suggestions.length" class="suggestion-row-text">
              提示：{{ row.suggestions.join("；") }}
            </span>
            <span v-else class="valid-row-text">可导入</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button @click="importDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="importLoading"
        :disabled="!importPreview?.rows.length || importHasErrors"
        @click="confirmWorkbookImport"
      >
        确认导入
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="bulkDeleteDialogVisible"
    title="按日期批量删除记录"
    width="900px"
    destroy-on-close
  >
    <div v-loading="bulkDeleteLoading">
      <el-form label-position="top" class="bulk-delete-form">
        <el-form-item label="日期依据">
          <el-select
            v-model="bulkDeleteFilter.date_field"
            @change="invalidateBulkDeletePreview"
          >
            <el-option label="台账实验日期" value="experiment_date" />
            <el-option label="记录创建时间" value="created_at" />
            <el-option label="记录更新时间" value="updated_at" />
          </el-select>
        </el-form-item>
        <el-form-item label="开始日期">
          <EditableDateInput
            v-model="bulkDeleteFilter.start_date"
            @change="invalidateBulkDeletePreview"
          />
        </el-form-item>
        <el-form-item label="结束日期">
          <EditableDateInput
            v-model="bulkDeleteFilter.end_date"
            @change="invalidateBulkDeletePreview"
          />
        </el-form-item>
        <el-button type="primary" plain @click="previewDateRangeDelete">
          预览删除范围
        </el-button>
      </el-form>
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="仅删除当前项目中落入日期范围的记录。预览后若记录清单变化，执行会被拒绝并要求重新预览。"
      />
      <div v-if="bulkDeletePreview" class="delete-preview-summary">
        <strong>将删除 {{ bulkDeletePreview.total }} 条记录</strong>
        <el-tag v-if="bulkDeletePreview.locked_count" type="danger">
          含 {{ bulkDeletePreview.locked_count }} 条锁定记录，不能执行
        </el-tag>
        <span v-if="bulkDeletePreview.total > bulkDeletePreview.items.length">
          表格仅展示前 {{ bulkDeletePreview.items.length }} 条
        </span>
      </div>
      <el-table
        v-if="bulkDeletePreview"
        :data="bulkDeletePreview.items"
        border
        height="320"
        empty-text="该范围内没有记录"
      >
        <el-table-column prop="pathology_number" label="病理号" min-width="160" />
        <el-table-column prop="status" label="状态" width="90" />
        <el-table-column label="匹配日期/时间" min-width="180">
          <template #default="{ row }">
            <span v-if="bulkDeleteFilter.date_field === 'experiment_date'">
              {{ row.experiment_date || "—" }}
            </span>
            <span v-else>
              {{ formatShanghaiDateTime(row[bulkDeleteFilter.date_field]) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="锁定" width="80">
          <template #default="{ row }">{{ row.locked ? "是" : "否" }}</template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button @click="bulkDeleteDialogVisible = false">取消</el-button>
      <el-button
        type="danger"
        :loading="bulkDeleteLoading"
        :disabled="!bulkDeletePreview?.total || Boolean(bulkDeletePreview?.locked_count)"
        @click="confirmDateRangeDelete"
      >
        确认永久删除
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.hidden-file-input {
  display: none;
}

.readonly-cell {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  color: #475467;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.import-dialog-body {
  min-height: 180px;
}

.import-summary,
.delete-preview-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.sheet-select {
  width: 220px;
}

.valid-row-text {
  color: #067647;
}

.invalid-row-text {
  color: #b42318;
}

.warning-row-text {
  color: #b54708;
}

.suggestion-row-text {
  color: #475467;
}

.bulk-delete-form {
  display: grid;
  grid-template-columns: 180px minmax(180px, 1fr) minmax(180px, 1fr) auto;
  align-items: end;
  gap: 12px;
}

.bulk-delete-form :deep(.el-form-item) {
  margin-bottom: 12px;
}

.bulk-delete-form > .el-button {
  margin-bottom: 12px;
}

.delete-preview-summary {
  margin-top: 14px;
}

.highlight-dialog-body {
  padding: 2px 0 8px;
}

.highlight-palette-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.highlight-palette-section + .highlight-palette-section {
  margin-top: 14px;
}

.highlight-palette-title {
  color: #344054;
  font-size: 13px;
  font-weight: 700;
}

.highlight-palette-grid {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: 4px;
}

.highlight-color-swatch {
  position: relative;
  min-width: 0;
  height: 27px;
  border: 1px solid #cfd4dc;
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
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
  text-shadow: 0 1px 2px rgb(0 0 0 / 75%);
}

.highlight-picker-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}

.highlight-picker-row .field-label {
  min-width: 62px;
}

.highlight-preview {
  width: 44px;
  height: 28px;
  border: 1px solid #cfd4dc;
  border-radius: 6px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 60%);
}

.highlight-picker-row code {
  color: var(--app-muted);
  font-size: 12px;
}

.ledger-page {
  display: flex;
  height: calc(100dvh - 68px);
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}

.ledger-page.global-search-mode {
  overflow: auto;
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
  gap: 2px;
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
  display: flex;
  min-width: 96px;
  max-width: 180px;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--app-border);
  border-bottom-color: #cfd4dc;
  border-radius: 7px 7px 0 0;
  color: #344054;
  background: #f2f4f7;
  padding: 5px 12px;
  text-align: center;
  cursor: pointer;
  white-space: nowrap;
}

.project-tab:hover {
  border-color: #84adff;
}

.project-tab.active {
  border-color: var(--app-primary);
  border-bottom-color: #fff;
  color: #0958d9;
  background: #fff;
  box-shadow: inset 0 2px 0 var(--app-primary);
}

.project-tab span {
  font-weight: 700;
}

.manage-project-button {
  margin-left: auto;
}

.ledger-toolbar {
  display: grid;
  gap: 8px;
}
.ledger-filter-group,
.ledger-operation-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ledger-filter-group {
  flex-wrap: nowrap;
}

.ledger-search-advanced {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.search-scope-select {
  width: 130px;
}

.search-project-select {
  width: 280px;
}

.ledger-operation-group {
  flex-wrap: nowrap;
  justify-content: flex-start;
  overflow-x: auto;
  scrollbar-width: thin;
}

.ledger-operation-group > * {
  flex: 0 0 auto;
}

.ledger-preview-scope {
  width: 132px;
}

.ledger-preview-engine {
  width: 150px;
}

.ledger-header-label {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 4px;
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
  color: #98a2b3;
  cursor: pointer;
  padding: 0;
}

.ledger-column-tools-trigger:hover,
.ledger-column-tools-trigger.active,
.ledger-column-tools-trigger.sorted,
.ledger-column-tools-trigger.filtered {
  background: #dbeafe;
  color: var(--app-primary);
}

.ledger-column-tools-trigger :deep(.el-icon) {
  font-size: 13px;
}

.ledger-sort-indicator {
  margin-left: -2px;
  color: var(--app-primary);
  font-size: 12px;
  font-weight: 700;
}

.ledger-filter-indicator {
  width: 5px;
  height: 5px;
  margin-left: -1px;
  border-radius: 50%;
  background: #f59e0b;
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
  gap: 3px;
  border: 1px solid #93c5fd;
  border-radius: 8px;
  background: rgb(239 246 255 / 96%);
  box-shadow: 0 8px 24px rgb(15 23 42 / 18%);
  color: #1e3a8a;
  font-size: 12px;
  line-height: 1.35;
  padding: 8px 10px;
  pointer-events: none;
}

.ledger-column-tools-popover {
  width: 330px;
  border: 1px solid #d0d5dd;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 30px rgb(16 24 40 / 18%);
  padding: 12px;
}

.ledger-column-tools-title {
  margin-bottom: 10px;
  color: #182230;
  font-size: 14px;
  font-weight: 600;
}

.ledger-column-tools-sort,
.ledger-column-tools-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ledger-column-tools-sort :deep(.el-button + .el-button),
.ledger-column-tools-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.ledger-column-tools-filter-label {
  margin: 14px 0 6px;
  color: var(--app-muted);
  font-size: 12px;
}

.ledger-column-tools-filter-control {
  width: 100%;
}

.ledger-column-tools-empty-filter {
  margin-top: 8px;
}

.ledger-column-tools-date-range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.ledger-column-tools-date-range :deep(.el-date-editor) {
  width: 100%;
}

.ledger-column-tools-actions {
  justify-content: flex-end;
  margin-top: 12px;
}

.ledger-context-menu {
  width: 230px;
  overflow: hidden;
  border: 1px solid #d0d5dd;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 30px rgb(16 24 40 / 20%);
  padding: 5px;
}

.ledger-context-menu button {
  display: block;
  width: 100%;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #344054;
  cursor: pointer;
  font: inherit;
  padding: 8px 10px;
  text-align: left;
}

.ledger-context-menu button:hover:not(:disabled) {
  background: #eff6ff;
  color: var(--app-primary);
}

.ledger-context-menu button:disabled {
  color: #b8c0cc;
  cursor: not-allowed;
}

.ledger-context-menu-separator {
  height: 1px;
  margin: 5px 4px;
  background: #eaecf0;
}

.date-filter,
.export-date {
  width: 190px;
}

.ledger-filter-group > :deep(.el-input):not(.date-filter) {
  min-width: 260px;
  flex: 1 1 320px;
}

.ledger-filter-group > :deep(.el-select) {
  flex: 0 0 130px;
  width: 130px;
}

.ledger-filter-group > :deep(.el-button) {
  flex: 0 0 auto;
  white-space: nowrap;
}

.ledger-query-button {
  min-width: 94px;
}

.ledger-reset-button {
  min-width: 72px;
}

.ledger-refresh-button {
  min-width: 96px;
}

.ledger-history-button {
  width: 72px;
  min-width: 72px;
}

.global-search-results {
  min-width: 0;
  overflow: hidden;
}

.global-search-results :deep(.el-table) {
  width: 100%;
}

:deep(.search-focus-row > td) {
  background: #e6f4ff !important;
  transition: background-color 300ms ease;
}

@media (max-width: 900px) {
  .ledger-filter-group {
    overflow-x: auto;
  }

  .ledger-filter-group > :deep(.el-input):not(.date-filter) {
    min-width: 220px;
  }

  .ledger-operation-group {
    justify-content: flex-start;
  }

  .ledger-search-advanced > :deep(.el-input),
  .ledger-search-advanced > :deep(.el-select) {
    width: 100%;
  }
}

.export-panel {
  border-color: #b9d3ff;
}

.field-label {
  color: var(--app-muted);
  font-size: 12px;
}

.selection-bar {
  display: flex;
  min-height: 44px;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
  border: 1px solid #d6e4ff;
  border-radius: 10px;
  background: #f3f8ff;
  overflow-x: auto;
  padding: 6px 10px;
  scrollbar-width: thin;
}

.selection-bar strong {
  flex: 0 0 auto;
  margin-right: 4px;
  font-size: 13px;
  white-space: nowrap;
}

.selection-quick-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.selection-quick-actions > :deep(.el-button + .el-button) {
  margin-left: 0;
}

.selection-drag-hint {
  color: var(--app-muted);
  font-size: 12px;
  white-space: nowrap;
}

.selection-date {
  width: 132px;
}

.selection-date-separator {
  color: var(--app-muted);
  font-size: 13px;
}

.selection-bar > :deep(.el-button) {
  min-height: 32px;
}

.ledger-table-card {
  display: flex;
  min-height: 0;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.ledger-table-card :deep(.el-table) {
  min-height: 0;
  flex: 1;
}

.ledger-table-surface {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  zoom: var(--ledger-zoom, 1);
  font-family: var(--ledger-font-family, inherit);
  font-size: var(--ledger-font-size, 14px);
}

.ledger-table-surface :deep(.el-table) {
  height: 100%;
  font-family: inherit;
  font-size: inherit;
}

.ledger-bottom-bar {
  display: flex;
  min-width: 0;
  min-height: 38px;
  flex: 0 0 38px;
  align-items: flex-end;
  gap: 4px;
  border-top: 1px solid var(--app-border);
  background: #f8fafc;
  padding: 5px 6px 0;
}

.project-tab-navigation {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding-bottom: 2px;
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
  gap: 8px;
  padding-bottom: 2px;
}

.ledger-zoom-control {
  display: inline-flex;
  min-width: 260px;
  align-items: center;
  gap: 4px;
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
  color: var(--app-primary);
}

.row-lock {
  color: #d48806;
  font-size: 17px;
}

.row-actions {
  display: flex;
  height: 24px;
  align-items: center;
  justify-content: center;
  gap: 1px;
  flex-wrap: nowrap;
  white-space: nowrap;
  vertical-align: middle;
}

.row-actions > * {
  flex: 0 0 auto;
}

.row-actions :deep(.el-button),
.row-actions :deep(.el-dropdown .el-button) {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  padding: 0;
  min-width: 20px;
  line-height: 1;
  vertical-align: middle;
}

.row-actions :deep(.el-dropdown) {
  display: inline-flex;
  align-items: center;
}

.row-actions :deep(.el-dropdown .el-button) {
  width: 38px;
  min-width: 38px;
}

.dropdown-router-link {
  color: inherit;
  text-decoration: none;
}

.draft-row-hint {
  color: var(--app-muted);
  font-size: 12px;
}

.cell-field {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.grid-fill-handle {
  position: absolute;
  z-index: 4;
  right: -8px;
  bottom: -8px;
  width: 16px;
  height: 16px;
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
  right: 5px;
  bottom: 5px;
  width: 6px;
  height: 6px;
  border: 1px solid #fff;
  border-radius: 1px;
  background: var(--app-primary, #1677ff);
  content: "";
}

.grid-fill-handle:hover::after {
  box-shadow: 0 0 0 1px rgb(22 119 255 / 35%);
}

.grid-fill-preview-value {
  position: absolute;
  z-index: 3;
  inset: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px dashed #60a5fa;
  border-radius: 4px;
  background: rgb(239 246 255 / 92%);
  color: #1d4ed8;
  font-size: 12px;
  line-height: 1.2;
  padding: 0 4px;
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

.cell-field:not(.cell-field-editing) :deep(*) {
  user-select: none;
  -webkit-user-select: none;
  pointer-events: none;
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
  color: #b42318;
  font-size: 11px;
  line-height: 1.3;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}

.cell-field-invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px #f04438 inset;
}

.dialog-note {
  margin: 0 0 16px;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
}

:deep(.el-table .locked-row > td.el-table__cell) {
  background: #fff;
}

:deep(.el-table .locked-row .el-input__wrapper) {
  background: #fff;
  box-shadow: 0 0 0 1px #dcdfe6 inset;
}

:deep(.el-table .locked-row .el-input__inner) {
  color: #303133;
  -webkit-text-fill-color: #303133;
  cursor: text;
}

:deep(.el-table .draft-row > td.el-table__cell) {
  background: #f8fbff;
}

:deep(.el-table .draft-row:hover > td.el-table__cell) {
  background: #f2f7ff !important;
}

:deep(.el-table .highlighted-row > td.el-table__cell),
:deep(.el-table .highlighted-row:hover > td.el-table__cell) {
  background-color: var(--record-highlight-color) !important;
}

:deep(.el-table .highlighted-row .el-input__wrapper),
:deep(.el-table .highlighted-row .el-select__wrapper),
:deep(.el-table .highlighted-row .el-textarea__inner) {
  background-color: var(--record-highlight-color);
}

:deep(.el-table td.cell-highlighted),
:deep(.el-table td.cell-highlighted:hover) {
  background-color: var(--cell-highlight-color) !important;
}

:deep(.el-table td.cell-highlighted .el-input__wrapper),
:deep(.el-table td.cell-highlighted .el-select__wrapper),
:deep(.el-table td.cell-highlighted .el-textarea__inner) {
  background-color: var(--cell-highlight-color) !important;
}

:deep(.el-table td.grid-cell-selected) {
  background: #eaf3ff !important;
  box-shadow: inset 0 0 0 1px #93c5fd;
}

:deep(.el-table td.grid-cell-selected .el-input__wrapper),
:deep(.el-table td.grid-cell-selected .el-select__wrapper),
:deep(.el-table td.grid-cell-selected .el-textarea__inner) {
  background-color: #eaf3ff !important;
}

:deep(.el-table td.grid-cell-active) {
  box-shadow: inset 0 0 0 2px var(--app-primary);
}

:deep(.el-table td.grid-cell-editing),
:deep(.el-table td.grid-cell-editing:hover) {
  background: #fff !important;
  box-shadow: inset 0 0 0 2px var(--app-primary);
}

:deep(.el-table td.grid-cell-editing .el-input__wrapper),
:deep(.el-table td.grid-cell-editing .el-select__wrapper),
:deep(.el-table td.grid-cell-editing .el-textarea__inner) {
  background-color: #fff !important;
}

:deep(.el-table td.grid-cell-fill-preview) {
  background: #dbeafe !important;
  box-shadow: inset 0 0 0 1px #60a5fa;
}

:deep(.el-table .el-textarea__inner) {
  box-sizing: border-box;
  display: block;
  min-height: var(--ledger-editor-height, 32px) !important;
  overflow-y: auto !important;
  overflow-wrap: anywhere;
  word-break: break-all;
  line-height: 20px;
  padding: max(1px, calc((var(--ledger-editor-height, 32px) - 20px) / 2)) 8px;
}

:deep(.ledger-table-surface .el-table th),
:deep(.ledger-table-surface .el-table td),
:deep(.ledger-table-surface .el-table .cell),
:deep(.ledger-table-surface .el-input__inner),
:deep(.ledger-table-surface .el-select__selected-item),
:deep(.ledger-table-surface .editable-date-input) {
  font-family: var(--ledger-font-family, inherit);
  font-size: var(--ledger-font-size, 14px);
}

:deep(.el-table .cell) {
  padding: 5px 7px;
  text-align: center;
}

:deep(.el-table .el-table__body .cell) {
  padding: 0 7px;
}

:deep(.el-table .el-table__body td.el-table__cell) {
  padding-top: 0;
  padding-bottom: 0;
}

:deep(.ledger-table-card .el-table__body) {
  border-spacing: 0 var(--ledger-row-gap, 0px);
}

:deep(.el-table td.ledger-editor-column) {
  padding-right: 0;
  padding-left: 0;
  vertical-align: middle;
}

:deep(.el-table td.ledger-editor-column > .cell) {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  padding-right: 0;
  padding-left: 0;
}

:deep(.el-table td.ledger-editor-column > .cell > .cell-field) {
  width: var(--ledger-editor-width, 100%);
  max-width: 100%;
  min-height: var(--ledger-editor-height, 32px);
  justify-content: center;
}

:deep(.el-table td.ledger-editor-column > .cell > .cell-field > .el-input),
:deep(.el-table td.ledger-editor-column > .cell > .cell-field > .el-textarea),
:deep(.el-table td.ledger-editor-column > .cell > .cell-field > .el-select),
:deep(.el-table td.ledger-editor-column > .cell > .cell-field > .editable-date-input) {
  width: var(--ledger-editor-width, 100%);
  max-width: 100%;
  min-height: var(--ledger-editor-height, 32px);
  align-self: center;
  min-width: 0;
}

:deep(.el-table td.ledger-editor-column .el-input__wrapper),
:deep(.el-table td.ledger-editor-column .el-select__wrapper) {
  height: var(--ledger-editor-height, 32px);
  min-height: var(--ledger-editor-height, 32px);
  align-items: center;
}

:deep(.el-table td.ledger-editor-column .el-input__inner) {
  line-height: 20px;
}

:deep(.el-table td.el-table-column--selection) {
  cursor: default;
  user-select: none;
}

:deep(.el-table td.el-table-column--selection .cell) {
  display: flex;
  padding: 0;
  min-height: 100%;
  align-items: center;
  justify-content: center;
}

:deep(.el-table td.el-table-column--selection .el-checkbox) {
  display: inline-flex;
  width: 100%;
  height: 100%;
  min-height: var(--ledger-selection-min-height, 42px);
  align-items: center;
  justify-content: center;
  margin: 0;
  cursor: pointer;
}

:deep(.el-table td.el-table-column--selection .el-checkbox__inner) {
  width: 20px;
  height: 20px;
}

:deep(.el-table.selection-dragging td.el-table-column--selection .el-checkbox__inner) {
  cursor: grabbing;
}

:deep(.el-table.grid-selection-dragging) {
  user-select: none;
}

:deep(.el-table th.el-table__cell) {
  color: #182230;
  background: #f2f4f7;
  text-align: center;
  user-select: none;
  -webkit-user-select: none;
}

:deep(.el-table th.grid-header-selected) {
  background: #eaf3ff !important;
  box-shadow: inset 0 -2px 0 var(--app-primary);
}

:deep(.el-table th.grid-header-partial) {
  background: #f2f7ff !important;
  box-shadow: inset 0 -2px 0 #93c5fd;
}

:deep(.el-table .el-input__inner),
:deep(.el-table .el-textarea__inner) {
  text-align: center;
}

:deep(.ledger-table-card .el-table__body-wrapper .el-scrollbar__bar.is-horizontal) {
  height: 10px;
  bottom: 2px;
}

:deep(.ledger-table-card .el-table__body-wrapper .el-scrollbar__thumb) {
  border-radius: 999px;
  background: #98a2b3;
}

.cell-save-state {
  position: absolute;
  right: 4px;
  top: 2px;
  z-index: 3;
  color: #667085;
  font-size: 10px;
  line-height: 14px;
  pointer-events: none;
}

.cell-save-state.is-saving {
  color: #2563eb;
}

.cell-save-state.is-saved {
  color: #16803c;
}

.cell-save-state.is-error {
  color: #d92d20;
  font-weight: 700;
}

.ledger-selection-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: #475467;
  font-size: 12px;
}

.two-column-dialog-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.replace-preview-panel {
  border: 1px solid #d0d5dd;
  border-radius: 8px;
  padding: 12px;
  background: #f8fafc;
}

.replace-preview-panel ul,
.validation-panel ul {
  max-height: 150px;
  overflow: auto;
  margin: 8px 0 0;
  padding-left: 20px;
}

.validation-panel {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 3000;
  display: flex;
  width: min(680px, calc(100vw - 48px));
  max-height: 320px;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid #f0b849;
  border-radius: 10px;
  padding: 16px;
  background: #fffaf0;
  box-shadow: 0 12px 36px rgb(16 24 40 / 20%);
}

.validation-panel li.is-error {
  color: #b42318;
}

.validation-panel li.is-warning {
  color: #b54708;
}

.validation-panel li.is-suggestion {
  color: #175cd3;
}

.validation-panel-actions {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 8px;
}
</style>
