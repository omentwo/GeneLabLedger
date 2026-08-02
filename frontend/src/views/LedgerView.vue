<script setup lang="ts">
import {
  Brush,
  CopyDocument,
  Delete,
  Document,
  Download,
  Lock,
  Plus,
  Refresh,
  Search,
  Setting,
  Unlock,
  Upload,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
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
  DEFAULT_LEDGER_DISPLAY_SETTINGS,
  LEDGER_DISPLAY_SETTINGS_KEY,
  getSetting,
  normalizeLedgerDisplaySettings,
  type LedgerDisplaySettings,
} from "@/api/system";
import {
  assignRecordProject,
  createRecord,
  deleteRecord,
  executeBulkDelete,
  previewBulkDelete,
  listRecords,
  setRecordLock,
  setRecordsHighlight,
  setRecordsReportGenerated,
  updateRecord,
} from "@/api/records";
import EditableChoiceInput from "@/components/EditableChoiceInput.vue";
import EditableDateInput from "@/components/EditableDateInput.vue";
import ProjectFieldManager from "@/components/ProjectFieldManager.vue";
import { updateField } from "@/api/projects";
import { useAppStore } from "@/stores/app";
import type {
  FieldDefinition,
  BulkDeleteFilter,
  BulkDeletePreview,
  WorkbookImportPreview,
  ProjectRecord,
  RecordStatus,
  RecordUpdateInput,
  WorkbookImportRow,
} from "@/types/api";
import { formatShanghaiDateTime } from "@/utils/datetime";
import { exportWorkbook } from "@/utils/workbook";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();

const activeProjectId = ref("");
type LedgerRow = ProjectRecord & { _draft?: true };
const records = ref<ProjectRecord[]>([]);
const selectedRecords = ref<ProjectRecord[]>([]);
const ledgerDisplaySettings = ref<LedgerDisplaySettings>({
  ...DEFAULT_LEDGER_DISPLAY_SETTINGS,
});
const selectionStartDate = ref("");
const selectionEndDate = ref("");
const tableRef = ref<{
  clearSelection: () => void;
  doLayout: () => void;
  setScrollTop?: (top: number) => void;
  toggleAllSelection: () => void;
  toggleRowSelection: (row: LedgerRow, selected?: boolean) => void;
} | null>(null);
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
const savingIds = ref(new Set<string>());
const fieldErrors = ref<Record<string, string>>({});
const managerVisible = ref(false);
const exportVisible = ref(false);
const assignDialogVisible = ref(false);
const operationRecord = ref<ProjectRecord | null>(null);
const assignProjectId = ref("");
const searchText = ref("");
const searchStatus = ref("");
const searchDate = ref("");
const appliedSearch = reactive({
  text: "",
  status: "",
  date: "",
});
const exportFilter = reactive({
  start: "",
  end: "",
});
const draftRows = ref<LedgerRow[]>([]);
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
let draftSequence = 0;
let loadSequence = 0;
let ledgerInitialized = false;

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
    .sort((a, b) => a.sort_order - b.sort_order),
);
const selectedCount = computed(() => selectedRecords.value.length);
const tableRows = computed<LedgerRow[]>(() => [...records.value, ...draftRows.value]);
const ledgerTableStyle = computed<CSSProperties>(
  () =>
    ({
      "--ledger-row-gap": `${ledgerDisplaySettings.value.rowPaddingY}px`,
      "--ledger-editor-width": `${ledgerDisplaySettings.value.editorWidthPercent}%`,
      "--ledger-editor-height": `${Math.round((32 * ledgerDisplaySettings.value.editorHeightPercent) / 100)}px`,
      "--ledger-selection-min-height": "32px",
    }) as CSSProperties,
);
const importHasErrors = computed(
  () =>
    Boolean(importPreview.value?.errors.length) ||
    Boolean(importPreview.value?.rows.some((row) => row.errors.length)),
);

function isDraft(record: LedgerRow): boolean {
  return record._draft === true;
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

function makeDraftRow(): LedgerRow {
  const now = new Date().toISOString();
  draftSequence += 1;
  return {
    id: `draft-${draftSequence}`,
    _draft: true,
    project_id: activeProjectId.value,
    project_name: currentProject.value?.name ?? "",
    pathology_number: "",
    status: "待实验",
    experiment_date: null,
    experiment_number: null,
    report_generated: false,
    locked: false,
    highlight_color: null,
    values: {},
    created_at: now,
    updated_at: now,
  };
}

function scrollTableToBottom(): void {
  bottomScrollTimers.forEach((timer) => window.clearTimeout(timer));
  bottomScrollTimers = [];
  const applyScroll = () => {
    tableRef.value?.setScrollTop?.(Number.MAX_SAFE_INTEGER);
  };
  void nextTick(() => {
    applyScroll();
    bottomScrollTimers.push(window.setTimeout(applyScroll, 40));
    bottomScrollTimers.push(window.setTimeout(applyScroll, 140));
  });
}

function refreshTableLayout(): void {
  void nextTick(() => {
    tableRef.value?.doLayout();
  });
}

function appendDraftRow(): void {
  if (!currentProject.value || loading.value) return;
  draftRows.value.push(makeDraftRow());
  scrollTableToBottom();
}

function fieldOptions(field: FieldDefinition): string[] {
  return field.options
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((option) => option.value);
}

function valueFor(record: ProjectRecord, field: FieldDefinition): string {
  if (field.system_key === "pathology_number") return record.pathology_number;
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status;
  return record.values[field.id] ?? "";
}

function setValue(record: ProjectRecord, field: FieldDefinition, value: string): void {
  if (field.system_key === "pathology_number") {
    record.pathology_number = value;
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
}

function persistedKey(recordId: string, fieldId: string): string {
  return `${recordId}:${fieldId}`;
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
  rememberRecord(updated);
}

function reconcileCommittedPaste(
  entries: Array<{ record: LedgerRow; rowNumber: number }>,
  committedIds: string[],
): boolean {
  if (entries.length !== committedIds.length) return false;
  const committedDraftIds = new Set<string>();
  entries.forEach(({ record }, index) => {
    const committedId = committedIds[index];
    if (!committedId) return;
    if (isDraft(record)) {
      const persistedRecord = { ...record, id: committedId } as LedgerRow;
      delete persistedRecord._draft;
      records.value.push(persistedRecord as ProjectRecord);
      committedDraftIds.add(record.id);
      return;
    }
    rememberRecord(record);
  });
  if (committedDraftIds.size) {
    draftRows.value = draftRows.value.filter((row) => !committedDraftIds.has(row.id));
  }
  rememberAll();
  scrollTableToBottom();
  return true;
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
    const created = await createRecord({
      project_id: projectId,
      pathology_number: pathologyNumber,
      status: record.status,
      experiment_date: experimentDate || null,
      experiment_number: record.experiment_number?.trim() || null,
      values,
    });
    const draftIndex = draftRows.value.findIndex((item) => item.id === record.id);
    if (draftIndex >= 0) draftRows.value.splice(draftIndex, 1);
    if (activeProjectId.value === projectId) {
      records.value.push(created);
      rememberRecord(created);
      scrollTableToBottom();
    }
    if (notify) ElMessage.success("病理号已自动保存，记录已加入表格底部");
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录自动保存失败");
    return false;
  } finally {
    setSaving(record.id, false);
  }
}

async function saveField(record: LedgerRow, field: FieldDefinition): Promise<void> {
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
      return;
    }
    if (field.system_key === "pathology_number") {
      await persistDraft(record);
    }
    return;
  }
  if (record.locked) return;
  const key = persistedKey(record.id, field.id);
  const before = persistedValues.get(key) ?? "";
  const current = valueFor(record, field);
  if (current === before) {
    clearFieldError(record, field);
    return;
  }

  let payload: RecordUpdateInput;
  try {
    payload = payloadForField(record, field, current);
    clearFieldError(record, field);
  } catch (error) {
    if (field.system_key === "experiment_date") {
      setFieldError(
        record,
        field,
        error instanceof Error ? error.message : "日期格式无效",
      );
    } else {
      setValue(record, field, before);
      ElMessage.error(error instanceof Error ? error.message : "单元格保存失败");
    }
    return;
  }

  setSaving(record.id, true);
  try {
    const updated = await updateRecord(record.id, payload);
    replaceRecord(updated);
  } catch (error) {
    setValue(record, field, before);
    ElMessage.error(error instanceof Error ? error.message : "单元格保存失败");
  } finally {
    setSaving(record.id, false);
  }
}

async function loadLedgerDisplaySettings(): Promise<void> {
  try {
    const result = await getSetting<Partial<LedgerDisplaySettings>>(LEDGER_DISPLAY_SETTINGS_KEY);
    ledgerDisplaySettings.value = normalizeLedgerDisplaySettings(result.value);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "台账显示设置读取失败");
  }
}

async function loadRecords(
  projectId = activeProjectId.value,
  options: { showLoading?: boolean } = {},
): Promise<void> {
  if (!projectId) {
    records.value = [];
    return;
  }
  const showLoading = options.showLoading ?? true;
  const requestSequence = ++loadSequence;
  if (showLoading) loading.value = true;
  try {
    const loaded: ProjectRecord[] = [];
    let offset = 0;
    while (true) {
      const page = await listRecords({
        project_id: projectId,
        status: appliedSearch.status || undefined,
        search: appliedSearch.text || undefined,
        experiment_date: appliedSearch.date || undefined,
        limit: 1000,
        offset,
      });
      loaded.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) break;
    }
    if (requestSequence !== loadSequence || projectId !== activeProjectId.value) return;
    records.value = loaded;
    tableProjectId.value = projectId;
    fieldErrors.value = {};
    selectedRecords.value = [];
    rememberAll();
    await nextTick();
    tableRef.value?.doLayout();
  } catch (error) {
    if (requestSequence !== loadSequence) return;
    ElMessage.error(error instanceof Error ? error.message : "台账读取失败");
  } finally {
    if (requestSequence === loadSequence) loading.value = false;
  }
}

function applySearch(): void {
  try {
    appliedSearch.text = searchText.value.trim();
    appliedSearch.status = searchStatus.value;
    appliedSearch.date = normalizeDate(searchDate.value);
    searchDate.value = appliedSearch.date;
    void loadRecords();
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "筛选日期无效");
  }
}

function resetSearch(): void {
  searchText.value = "";
  searchStatus.value = "";
  searchDate.value = "";
  Object.assign(appliedSearch, { text: "", status: "", date: "" });
  void loadRecords();
}

function selectProject(projectId: string): void {
  if (activeProjectId.value === projectId) return;
  activeProjectId.value = projectId;
}

function selectAllVisible(): void {
  const selectableRows = tableRows.value.filter((row) => !isDraft(row));
  const selectedIds = new Set(selectedRecords.value.map((record) => record.id));
  if (selectableRows.every((row) => selectedIds.has(row.id))) return;
  if (selectedIds.size) tableRef.value?.clearSelection();
  tableRef.value?.toggleAllSelection();
}

function invertVisibleSelection(): void {
  const selectedIds = new Set(selectedRecords.value.map((record) => record.id));
  tableRef.value?.clearSelection();
  tableRows.value.forEach((row) => {
    if (!isDraft(row)) tableRef.value?.toggleRowSelection(row, !selectedIds.has(row.id));
  });
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

function rowCellStyle({ row }: { row: LedgerRow }): CSSProperties {
  return row.highlight_color ? { backgroundColor: row.highlight_color } : {};
}

function rowClassName({ row }: { row: LedgerRow }): string {
  const classes: string[] = [];
  if (isDraft(row)) classes.push("draft-row");
  else if (row.locked) classes.push("locked-row");
  if (row.highlight_color) classes.push("highlighted-row");
  return classes.join(" ");
}

function rowStyle({ row }: { row: LedgerRow }): CSSProperties {
  return row.highlight_color
    ? ({ "--record-highlight-color": row.highlight_color } as CSSProperties)
    : {};
}

function openHighlightDialog(targets: ProjectRecord[]): void {
  const uniqueTargets = [...new Map(targets.map((record) => [record.id, record])).values()];
  if (!uniqueTargets.length) {
    ElMessage.warning("请先勾选需要标记的记录");
    return;
  }
  highlightTargetIds.value = uniqueTargets.map((record) => record.id);
  const firstColor = uniqueTargets[0]?.highlight_color ?? null;
  highlightColor.value =
    firstColor && uniqueTargets.every((record) => record.highlight_color === firstColor)
      ? firstColor
      : "#fff2cc";
  highlightDialogVisible.value = true;
}

function openSelectedHighlightDialog(): void {
  openHighlightDialog(selectedRecords.value);
}

function selectHighlightColor(color: string): void {
  highlightColor.value = color;
}

function isHighlightColorSelected(color: string): boolean {
  return highlightColor.value.toLowerCase() === color.toLowerCase();
}

async function submitHighlight(color: string | null): Promise<void> {
  const recordIds = highlightTargetIds.value;
  if (!recordIds.length) return;
  highlightLoading.value = true;
  try {
    const updated = await setRecordsHighlight(recordIds, color);
    const updatedById = new Map(updated.map((record) => [record.id, record]));
    updated.forEach(replaceRecord);
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
  const recordIds = [...new Set(selectedRecords.value.map((record) => record.id))];
  if (!recordIds.length) {
    ElMessage.warning("请先勾选需要清除底色的记录");
    return;
  }
  highlightTargetIds.value = recordIds;
  await submitHighlight(null);
}

async function handleManagerChanged(): Promise<void> {
  await loadRecords();
}

async function handleHeaderResize(
  newWidth: number,
  _oldWidth: number,
  column: { columnKey?: string },
): Promise<void> {
  const fieldId = column.columnKey;
  const field = fields.value.find((item) => item.id === fieldId);
  if (!field || Math.round(newWidth) === field.width) return;
  try {
    await updateField(field.id, { width: Math.round(newWidth) });
    await appStore.reloadProjects();
    await nextTick();
    tableRef.value?.doLayout();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "列宽保存失败");
  }
}

function workbookRowFor(record: LedgerRow, rowNumber: number): WorkbookImportRow {
  const projectFields = currentProject.value?.fields ?? [];
  const values: Record<string, string> = {};
  projectFields.forEach((field) => {
    if (!field.is_core) values[field.id] = (record.values[field.id] ?? "").trim();
  });
  return {
    row_number: rowNumber,
    record_id: isDraft(record) ? null : record.id,
    pathology_number: record.pathology_number.trim(),
    status: record.status,
    experiment_date: record.experiment_date ? normalizeDate(record.experiment_date) : null,
    experiment_number: record.experiment_number?.trim() || null,
    values,
  };
}

async function pasteGrid(
  event: ClipboardEvent,
  startRowIndex: number,
  startColumnIndex: number,
): Promise<void> {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  event.preventDefault();
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const matrix = lines.map((line) => line.split("\t"));
  const changedRows = new Map<string, { record: LedgerRow; rowNumber: number }>();
  let skippedLocked = 0;
  let changedCells = 0;

  try {
    const missingRows = startRowIndex + matrix.length - tableRows.value.length;
    for (let index = 0; index < missingRows; index += 1) appendDraftRow();
    const rows = tableRows.value;

    matrix.forEach((rowValues, rowOffset) => {
      const record = rows[startRowIndex + rowOffset];
      if (!record) return;
      if (record.locked) {
        skippedLocked += 1;
        return;
      }
      rowValues.forEach((rawValue, columnOffset) => {
        const field = fields.value[startColumnIndex + columnOffset];
        if (!field) return;
        const value = rawValue.trim();
        // Validate core values before mutating the row.  This keeps an invalid
        // pasted date from becoming an unexplainable batch-save failure.
        payloadForField(record, field, value);
        setValue(record, field, value);
        if (field.system_key === "experiment_date") {
          record.experiment_date = normalizeDate(value) || null;
        }
        changedRows.set(record.id, {
          record,
          rowNumber: startRowIndex + rowOffset + 2,
        });
        changedCells += 1;
      });
    });

    const committableEntries = [...changedRows.values()].filter(
      ({ record }) => !isDraft(record) || record.pathology_number.trim(),
    );
    const rowsToCommit = committableEntries.map(({ record, rowNumber }) =>
      workbookRowFor(record, rowNumber),
    );
    if (rowsToCommit.length) {
      const result = await commitWorkbookImport(activeProjectId.value, rowsToCommit);
      if (!reconcileCommittedPaste(committableEntries, result.record_ids)) {
        await loadRecords(activeProjectId.value, { showLoading: false });
      }
      ElMessage.success(`已粘贴 ${changedCells} 个单元格${result.created ? `，新建 ${result.created} 条记录` : ""}`);
    } else if (changedCells) {
      ElMessage.success(`已粘贴 ${changedCells} 个单元格，填写病理号后将自动保存`);
    }
    if (skippedLocked) {
      ElMessage.info(`已跳过 ${skippedLocked} 条锁定记录`);
    }
  } catch (error) {
    await loadRecords(activeProjectId.value, { showLoading: false });
    ElMessage.error(error instanceof Error ? error.message : "粘贴保存失败");
  }
}

async function updateSelectedStatus(status: RecordStatus): Promise<void> {
  const targets = selectedRecords.value.filter((record) => !record.locked);
  if (!targets.length) {
    ElMessage.warning("没有可修改的未锁定记录");
    return;
  }
  loading.value = true;
  try {
    await Promise.all(targets.map((record) => updateRecord(record.id, { status })));
    await loadRecords();
    ElMessage.success(`已将 ${targets.length} 条记录标记为${status}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "批量状态修改失败");
  } finally {
    loading.value = false;
  }
}

async function updateSelectedLock(locked: boolean): Promise<void> {
  if (!selectedRecords.value.length) {
    ElMessage.warning("请先勾选记录");
    return;
  }
  loading.value = true;
  try {
    await Promise.all(
      selectedRecords.value.map((record) => setRecordLock(record.id, locked)),
    );
    await loadRecords();
    ElMessage.success(locked ? "所选记录已锁定" : "所选记录已解锁");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "锁定状态修改失败");
  } finally {
    loading.value = false;
  }
}

function generateSelectedReports(): void {
  if (!selectedRecords.value.length) {
    ElMessage.warning("请先勾选需要打印报告的记录");
    return;
  }
  void router.push({
    path: "/reports",
    query: {
      project: activeProjectId.value,
      records: selectedRecords.value.map((record) => record.id).join(","),
    },
  });
}

async function updateSelectedReportStatus(reportGenerated: boolean): Promise<void> {
  const targets = selectedRecords.value.filter((record) => !record.locked);
  if (!targets.length) {
    ElMessage.warning("没有可修改的未锁定记录");
    return;
  }
  loading.value = true;
  try {
    await setRecordsReportGenerated(
      targets.map((record) => record.id),
      reportGenerated,
    );
    await loadRecords();
    ElMessage.success(reportGenerated ? "所选记录已标记为已生成报告" : "所选记录已恢复为未生成报告");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "报告状态修改失败");
  } finally {
    loading.value = false;
  }
}

async function deleteSelectedRecords(): Promise<void> {
  if (!selectedRecords.value.length) {
    ElMessage.warning("请先勾选需要删除的记录");
    return;
  }
  const targets = selectedRecords.value.filter((record) => !record.locked);
  const lockedCount = selectedRecords.value.length - targets.length;
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
    const results = await Promise.allSettled(
      targets.map((record) => deleteRecord(record.id)),
    );
    const deletedIds = new Set(
      targets
        .filter((_record, index) => results[index]?.status === "fulfilled")
        .map((record) => record.id),
    );
    records.value = records.value.filter((record) => !deletedIds.has(record.id));
    selectedRecords.value = [];
    rememberAll();
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
  const rows = preview.rows.map(({ action: _action, errors: _errors, ...row }) => row);
  try {
    await ElMessageBox.confirm(
      `将新建 ${preview.create_count} 条、更新 ${preview.update_count} 条记录。记录 UUID 是唯一匹配依据，确认导入？`,
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
    const result = await commitWorkbookImport(activeProjectId.value, rows);
    importDialogVisible.value = false;
    importFile.value = null;
    importPreview.value = null;
    await loadRecords();
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
    await loadRecords();
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
    await assignRecordProject(operationRecord.value.id, assignProjectId.value);
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
    await deleteRecord(record.id);
    records.value = records.value.filter((item) => item.id !== record.id);
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
    const items = records.value.filter((record) => {
      const date = record.experiment_date ?? "";
      return (!start || date >= start) && (!end || date <= end);
    });
    const saved = await exportWorkbook(
      [
        {
          name: currentProject.value.name,
          headers: ["_record_id", "_project_id", ...fields.value.map((field) => field.label)],
          hiddenColumns: [1, 2],
          rows: items.map((record) => [
            record.id,
            record.project_id,
            ...fields.value.map((field) => valueFor(record, field)),
          ]),
        },
      ],
      `${currentProject.value.name}_台账`,
    );
    if (!saved) return;
    ElMessage.success(`已导出 ${items.length} 条记录`);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "导出条件无效");
  }
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

watch(activeProjectId, async (projectId, previousProjectId) => {
  if (!ledgerInitialized || !projectId || projectId === previousProjectId) return;
  draftRows.value = [];
  selectedRecords.value = [];
  selectionStartDate.value = "";
  selectionEndDate.value = "";
  importDialogVisible.value = false;
  importFile.value = null;
  importPreview.value = null;
  highlightDialogVisible.value = false;
  highlightTargetIds.value = [];
  bulkDeleteDialogVisible.value = false;
  bulkDeletePreview.value = null;
  persistedValues.clear();
  void router.replace({ query: { ...route.query, project: projectId } });
  await loadRecords(projectId);
  await nextTick();
  refreshTableLayout();
  scrollTableToBottom();
}, { flush: "sync" });

async function initializeLedger(): Promise<void> {
  await appStore.bootstrap();
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
  await router.replace({ query: { ...route.query, project: initialProjectId } });
  await loadRecords(initialProjectId);
  await nextTick();
  refreshTableLayout();
  scrollTableToBottom();
}

onMounted(() => {
  document.addEventListener("click", handleSelectionClickCapture, true);
  void loadLedgerDisplaySettings();
  void initializeLedger();
});

onBeforeUnmount(() => {
  document.removeEventListener("click", handleSelectionClickCapture, true);
  stopSelectionDrag();
  bottomScrollTimers.forEach((timer) => window.clearTimeout(timer));
  bottomScrollTimers = [];
});
</script>

<template>
  <div class="page-stack">
    <section class="project-strip">
      <button
        v-for="project in appStore.projects"
        :key="project.id"
        class="project-tab"
        :class="{ active: project.id === activeProjectId }"
        type="button"
        @click="selectProject(project.id)"
      >
        <span>{{ project.name }}</span>
      </button>
    </section>

    <section class="page-card">
      <div class="page-card-body">
        <div class="ledger-toolbar">
          <EditableDateInput
            v-model="searchDate"
            class="date-filter"
            placeholder="按实验日期筛选"
            @change="searchDate = $event"
          />
          <el-input
            v-model="searchText"
            clearable
            placeholder="搜索病理号或任意表头内容"
            :prefix-icon="Search"
            @keyup.enter="applySearch"
            @clear="applySearch"
          />
          <el-select v-model="searchStatus" clearable placeholder="全部状态">
            <el-option label="待实验" value="待实验" />
            <el-option label="已完成" value="已完成" />
          </el-select>
          <el-button type="primary" :icon="Search" @click="applySearch">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button :icon="Refresh" @click="loadRecords()">刷新</el-button>
          <div class="toolbar-spacer" />
          <el-button
            :icon="Plus"
            type="primary"
            plain
            @click="appendDraftRow"
          >
            新增记录
          </el-button>
          <el-button :icon="Download" @click="exportVisible = !exportVisible">
            导出 Excel
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
      </div>
    </section>

    <section v-if="exportVisible" class="page-card export-panel">
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

    <section class="selection-bar">
      <strong>已选 {{ selectedCount }} 条</strong>
      <el-button @click="selectAllVisible">全选</el-button>
      <el-button @click="invertVisibleSelection">反选</el-button>
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
        标记已完成
      </el-button>
      <el-button @click="updateSelectedStatus('待实验')">
        标记待实验
      </el-button>
      <el-button
        :icon="Brush"
        :disabled="!selectedCount"
        @click="openSelectedHighlightDialog"
      >
        设置底色
      </el-button>
      <el-button
        :icon="Delete"
        plain
        :loading="highlightLoading"
        :disabled="!selectedCount"
        @click="clearSelectedHighlight"
      >
        清除底色
      </el-button>
      <el-button :icon="Lock" @click="updateSelectedLock(true)">
        锁定所选
      </el-button>
      <el-button :icon="Unlock" @click="updateSelectedLock(false)">
        解锁所选
      </el-button>
      <el-button :icon="Document" @click="generateSelectedReports">
        打印报告
      </el-button>
      <el-button @click="updateSelectedReportStatus(true)">
        标记已生成报告
      </el-button>
      <el-button @click="updateSelectedReportStatus(false)">
        恢复未生成报告
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

    <section class="page-card ledger-table-card">
      <el-table
        ref="tableRef"
        :class="{ 'selection-dragging': selectionDragging }"
        :style="ledgerTableStyle"
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
        @selection-change="selectedRecords = $event"
        @pointerdown="handleSelectionPointerDown"
        @header-dragend="handleHeaderResize"
      >
        <el-table-column
          type="selection"
          width="55"
          fixed="left"
          align="center"
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
          align="center"
          header-align="center"
          resizable
        >
          <template #default="{ row, $index }: { row: LedgerRow; $index: number }">
            <div
              v-if="field.data_type === 'date' || field.system_key === 'experiment_date'"
              class="cell-field"
              :class="{ 'cell-field-invalid': fieldErrorFor(row, field) }"
            >
              <EditableDateInput
                :model-value="valueFor(row, field)"
                :readonly="row.locked"
                @update:model-value="setValue(row, field, $event)"
                @change="saveField(row, field)"
                @paste="pasteGrid($event, $index, columnIndex)"
              />
              <span v-if="fieldErrorFor(row, field)" class="cell-field-error">
                {{ fieldErrorFor(row, field) }}
              </span>
            </div>
            <EditableChoiceInput
              v-else-if="field.options.length || field.data_type === 'select'"
              :model-value="valueFor(row, field)"
              :options="fieldOptions(field)"
              :readonly="row.locked"
              @update:model-value="setValue(row, field, $event)"
              @change="saveField(row, field)"
              @paste="pasteGrid($event, $index, columnIndex)"
            />
            <el-input
              v-else-if="!field.is_core"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 5 }"
              resize="none"
              :model-value="valueFor(row, field)"
              :readonly="row.locked"
              :inputmode="field.data_type === 'number' ? 'decimal' : undefined"
              @update:model-value="setValue(row, field, String($event))"
              @change="saveField(row, field)"
              @paste="pasteGrid($event, $index, columnIndex)"
            />
            <el-input
              v-else
              :model-value="valueFor(row, field)"
              :readonly="row.locked"
              :inputmode="field.data_type === 'number' ? 'decimal' : undefined"
              @update:model-value="setValue(row, field, String($event))"
              @change="saveField(row, field)"
              @keyup.enter="saveField(row, field)"
              @paste="pasteGrid($event, $index, columnIndex)"
            />
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
    </section>
  </div>

  <ProjectFieldManager
    v-model="managerVisible"
    :selected-project-id="activeProjectId"
    @changed="handleManagerChanged"
    @select-project="selectProject"
  />

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
    :title="`设置记录底色（${highlightTargetIds.length} 条）`"
    width="430px"
    destroy-on-close
  >
    <div class="highlight-dialog-body">
      <p class="dialog-note">
        选择一种底色后，会应用到当前选中的记录；锁定记录也可以设置或清除底色标记。
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
        <el-table-column prop="status" label="状态" width="90" />
        <el-table-column prop="experiment_date" label="实验日期" width="120" />
        <el-table-column prop="experiment_number" label="实验编号" min-width="150" />
        <el-table-column label="校验" min-width="240">
          <template #default="{ row }">
            <span v-if="!row.errors.length" class="valid-row-text">可导入</span>
            <span v-else class="invalid-row-text">{{ row.errors.join("；") }}</span>
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

.project-strip {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 4px 4px 10px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: rgb(255 255 255 / 82%);
  box-shadow: 0 5px 16px rgb(16 24 40 / 6%);
  backdrop-filter: blur(12px);
  overflow-x: auto;
  scrollbar-color: #98a2b3 #eef2f6;
  scrollbar-width: auto;
}

.project-strip::-webkit-scrollbar {
  height: 10px;
}

.project-strip::-webkit-scrollbar-track {
  border-radius: 999px;
  background: #eef2f6;
}

.project-strip::-webkit-scrollbar-thumb {
  border: 2px solid #eef2f6;
  border-radius: 999px;
  background: #98a2b3;
}

.project-tab {
  display: flex;
  min-width: 150px;
  min-height: 42px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: #344054;
  background: #fff;
  padding: 8px 12px;
  text-align: center;
  cursor: pointer;
}

.project-tab:hover {
  border-color: #84adff;
}

.project-tab.active {
  border-color: var(--app-primary);
  color: #0958d9;
  background: var(--app-primary-soft);
  box-shadow: 0 0 0 1px var(--app-primary);
}

.project-tab span {
  font-weight: 700;
}

.manage-project-button {
  margin-left: auto;
}

.ledger-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.toolbar-spacer {
  min-width: 12px;
  flex: 1 1 12px;
}

.date-filter,
.export-date {
  width: 190px;
}

.ledger-toolbar > :deep(.el-input):not(.date-filter) {
  min-width: 260px;
  flex: 1 1 320px;
}

.ledger-toolbar > :deep(.el-select) {
  width: 130px;
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
  min-height: 48px;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  border: 1px solid #d6e4ff;
  border-radius: 10px;
  background: #f3f8ff;
  padding: 8px 12px;
}

.selection-bar strong {
  margin-right: 4px;
  font-size: 13px;
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
  height: calc(100vh - 300px);
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.ledger-table-card :deep(.el-table) {
  min-height: 0;
  flex: 1;
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
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
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

:deep(.el-table .el-textarea__inner) {
  box-sizing: border-box;
  display: block;
  min-height: var(--ledger-editor-height, 32px) !important;
  overflow-wrap: anywhere;
  word-break: break-all;
  line-height: 20px;
  padding: max(1px, calc((var(--ledger-editor-height, 32px) - 20px) / 2)) 8px;
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

:deep(.el-table td.ledger-editor-column > .cell > .el-input),
:deep(.el-table td.ledger-editor-column > .cell > .el-textarea),
:deep(.el-table td.ledger-editor-column > .cell > .el-select),
:deep(.el-table td.ledger-editor-column > .cell > .editable-date-input) {
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

:deep(.el-table th.el-table__cell) {
  color: #182230;
  background: #f2f4f7;
  text-align: center;
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
</style>
