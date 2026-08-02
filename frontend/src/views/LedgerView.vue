<script setup lang="ts">
import {
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
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";

import { commitWorkbookImport, previewWorkbookImport } from "@/api/imports";
import {
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
import EditableDateInput from "@/components/EditableDateInput.vue";
import ProjectFieldManager from "@/components/ProjectFieldManager.vue";
import UniverLedgerGrid from "@/components/UniverLedgerGrid.vue";
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
const selectionStartDate = ref("");
const selectionEndDate = ref("");
const loading = ref(false);
const savingIds = ref(new Set<string>());
const fieldErrors = ref<Record<string, string>>({});
const managerVisible = ref(false);
const exportVisible = ref(false);
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
const highlightLoading = ref(false);
const bulkDeleteFilter = reactive<BulkDeleteFilter>({
  project_id: "",
  date_field: "experiment_date",
  start_date: "",
  end_date: "",
});
const persistedValues = new Map<string, string>();
let draftSequence = 0;
let loadSequence = 0;
let ledgerInitialized = false;

const currentProject = computed(() => appStore.projectById(activeProjectId.value));
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
const importHasErrors = computed(
  () =>
    Boolean(importPreview.value?.errors.length) ||
    Boolean(importPreview.value?.rows.some((row) => row.errors.length)),
);

function isDraft(record: LedgerRow): boolean {
  return record._draft === true;
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

function appendDraftRow(): void {
  if (!currentProject.value || loading.value) return;
  draftRows.value.push(makeDraftRow());
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
    const selectedIds = new Set(selectedRecords.value.map((record) => record.id));
    records.value = loaded;
    tableProjectId.value = projectId;
    fieldErrors.value = {};
    selectedRecords.value = loaded.filter((record) => selectedIds.has(record.id));
    rememberAll();
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

function handleUniverSelection(recordsFromGrid: ProjectRecord[]): void {
  selectedRecords.value = recordsFromGrid;
}

function handleUniverCellChange(payload: {
  record: LedgerRow;
  field: FieldDefinition;
  value: string;
}): void {
  if (payload.record.locked) return;
  setValue(payload.record, payload.field, payload.value);
  void saveField(payload.record, payload.field);
}

async function handleUniverBackgroundChange(payload: {
  recordIds: string[];
  color: string | null;
}): Promise<void> {
  if (!payload.recordIds.length) return;
  try {
    const updated = await setRecordsHighlight(payload.recordIds, payload.color);
    const updatedById = new Map(updated.map((record) => [record.id, record]));
    updated.forEach(replaceRecord);
    selectedRecords.value = selectedRecords.value.map(
      (record) => updatedById.get(record.id) ?? record,
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录底色保存失败");
    await loadRecords(activeProjectId.value, { showLoading: false });
  }
}

async function handleUniverColumnResize(payload: { fieldId: string; width: number }): Promise<void> {
  const field = fields.value.find((item) => item.id === payload.fieldId);
  const width = Math.max(72, Math.round(payload.width));
  if (!field || field.width === width) return;
  try {
    await updateField(field.id, { width });
    await appStore.reloadProjects();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "列宽保存失败");
  }
}

function selectAllVisible(): void {
  selectedRecords.value = tableRows.value.filter((row) => !isDraft(row));
}

function invertVisibleSelection(): void {
  const selectedIds = new Set(selectedRecords.value.map((record) => record.id));
  selectedRecords.value = tableRows.value.filter(
    (row): row is ProjectRecord => !isDraft(row) && !selectedIds.has(row.id),
  );
}

function selectByDateRange(): void {
  try {
    const startDate = normalizeDate(selectionStartDate.value);
    const endDate = normalizeDate(selectionEndDate.value);
    if (!startDate || !endDate) throw new Error("请选择开始日期和结束日期");
    if (startDate > endDate) throw new Error("开始日期不能晚于结束日期");
    selectedRecords.value = tableRows.value.filter((row): row is ProjectRecord => {
      const date = row.experiment_date ?? "";
      return !isDraft(row) && date >= startDate && date <= endDate;
    });
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "日期无效");
  }
}

async function clearSelectedHighlight(): Promise<void> {
  const recordIds = [...new Set(selectedRecords.value.map((record) => record.id))];
  if (!recordIds.length) {
    ElMessage.warning("请先勾选需要清除底色的记录");
    return;
  }
  highlightLoading.value = true;
  try {
    const updated = await setRecordsHighlight(recordIds, null);
    const updatedById = new Map(updated.map((record) => [record.id, record]));
    updated.forEach(replaceRecord);
    selectedRecords.value = selectedRecords.value.map(
      (record) => updatedById.get(record.id) ?? record,
    );
    ElMessage.success(`已清除 ${updated.length} 条记录的底色标记`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录底色清除失败");
  } finally {
    highlightLoading.value = false;
  }
}

async function handleManagerChanged(): Promise<void> {
  await loadRecords();
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
  bulkDeleteDialogVisible.value = false;
  bulkDeletePreview.value = null;
  persistedValues.clear();
  void router.replace({ query: { ...route.query, project: projectId } });
  await loadRecords(projectId);
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
  ledgerInitialized = true;
  if (!initialProjectId) {
    records.value = [];
    return;
  }
  await router.replace({ query: { ...route.query, project: initialProjectId } });
  await loadRecords(initialProjectId);
}

onMounted(() => {
  void initializeLedger();
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
      <UniverLedgerGrid
        :project-id="activeProjectId"
        :project-name="currentProject?.name ?? '台账'"
        :fields="fields"
        :rows="tableRows"
        :loading="loading"
        @selection-change="handleUniverSelection"
        @cell-change="handleUniverCellChange"
        @background-change="handleUniverBackgroundChange"
        @column-resize="handleUniverColumnResize"
      />
    </section>
  </div>

  <ProjectFieldManager
    v-model="managerVisible"
    :selected-project-id="activeProjectId"
    @changed="handleManagerChanged"
    @select-project="selectProject"
  />

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

.ledger-table-card :deep(.univer-ledger-grid) {
  min-height: 0;
  flex: 1;
}

.dialog-note {
  margin: 0 0 16px;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
}

</style>
