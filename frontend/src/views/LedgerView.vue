<script setup lang="ts">
import {
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
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  assignRecordProject,
  createRecord,
  deleteRecord,
  listRecords,
  repeatRecord,
  setRecordLock,
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
  ProjectRecord,
  RecordStatus,
  RecordUpdateInput,
} from "@/types/api";
import { exportWorkbook } from "@/utils/workbook";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();

const activeProjectId = ref("");
const records = ref<ProjectRecord[]>([]);
const selectedRecords = ref<ProjectRecord[]>([]);
const loading = ref(false);
const savingIds = ref(new Set<string>());
const managerVisible = ref(false);
const exportVisible = ref(false);
const assignDialogVisible = ref(false);
const repeatDialogVisible = ref(false);
const operationRecord = ref<ProjectRecord | null>(null);
const assignProjectId = ref("");
const repeatDate = ref("");
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
type LedgerRow = ProjectRecord & { _draft?: true };
const draftRows = ref<LedgerRow[]>([]);
const persistedValues = new Map<string, string>();
let draftSequence = 0;
let loadSequence = 0;
let ledgerInitialized = false;

const currentProject = computed(() => appStore.projectById(activeProjectId.value));
const fields = computed(() =>
  (currentProject.value?.fields ?? [])
    .filter((field) => !field.hidden)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order),
);
const selectedCount = computed(() => selectedRecords.value.length);
const tableRows = computed<LedgerRow[]>(() => [...records.value, ...draftRows.value]);

function isDraft(record: LedgerRow): boolean {
  return record._draft === true;
}

function makeDraftRow(): LedgerRow {
  const now = new Date().toISOString();
  draftSequence += 1;
  return {
    id: `draft-${draftSequence}`,
    _draft: true,
    case_id: "",
    project_id: activeProjectId.value,
    project_name: currentProject.value?.name ?? "",
    pathology_number: "",
    status: "待实验",
    experiment_date: null,
    experiment_number: null,
    report_generated: false,
    locked: false,
    values: {},
    created_at: now,
    updated_at: now,
  };
}

function appendDraftRow(): void {
  if (!currentProject.value) return;
  draftRows.value.push(makeDraftRow());
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
}

function persistedKey(recordId: string, fieldId: string): string {
  return `${recordId}:${fieldId}`;
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
  if (field.system_key === "status") {
    if (value !== "待实验" && value !== "已完成") {
      throw new Error("状态只能是“待实验”或“已完成”");
    }
    return { status: value };
  }
  if (field.system_key === "experiment_number") {
    return { experiment_number: value || null };
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

  setSaving(record.id, true);
  try {
    const experimentDate = normalizeDate(record.experiment_date ?? "");
    const values: Record<string, string> = {};
    fields.value.forEach((field) => {
      if (!field.is_core) values[field.id] = (record.values[field.id] ?? "").trim();
    });
    const created = await createRecord({
      project_id: projectId,
      pathology_number: pathologyNumber,
      status: record.status,
      experiment_date: experimentDate || null,
      experiment_number: record.experiment_number,
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
      } catch (error) {
        ElMessage.warning(error instanceof Error ? error.message : "日期格式无效");
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
  if (current === before) return;

  setSaving(record.id, true);
  try {
    const payload = payloadForField(record, field, current);
    const updated = await updateRecord(record.id, payload);
    replaceRecord(updated);
  } catch (error) {
    setValue(record, field, before);
    ElMessage.error(error instanceof Error ? error.message : "单元格保存失败");
  } finally {
    setSaving(record.id, false);
  }
}

async function loadRecords(projectId = activeProjectId.value): Promise<void> {
  if (!projectId) {
    records.value = [];
    return;
  }
  const requestSequence = ++loadSequence;
  loading.value = true;
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
    selectedRecords.value = [];
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
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "列宽保存失败");
  }
}

function mergePayload(
  target: RecordUpdateInput,
  incoming: RecordUpdateInput,
): RecordUpdateInput {
  if (incoming.pathology_number !== undefined) {
    target.pathology_number = incoming.pathology_number;
  }
  if (incoming.status !== undefined) target.status = incoming.status;
  if ("experiment_date" in incoming) target.experiment_date = incoming.experiment_date;
  if ("experiment_number" in incoming) {
    target.experiment_number = incoming.experiment_number;
  }
  if (incoming.values) target.values = { ...(target.values ?? {}), ...incoming.values };
  return target;
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
  const updates = new Map<string, { record: ProjectRecord; payload: RecordUpdateInput }>();
  const draftsToPersist = new Map<string, LedgerRow>();
  let skippedLocked = 0;
  let changedCells = 0;
  let createdRecords = 0;

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
        setValue(record, field, value);
        if (isDraft(record)) {
          draftsToPersist.set(record.id, record);
          changedCells += 1;
          return;
        }
        const partial = payloadForField(record, field, value);
        const entry = updates.get(record.id) ?? { record, payload: {} };
        mergePayload(entry.payload, partial);
        updates.set(record.id, entry);
        changedCells += 1;
      });
    });

    for (const { record, payload } of updates.values()) {
      setSaving(record.id, true);
      const updated = await updateRecord(record.id, payload);
      replaceRecord(updated);
      setSaving(record.id, false);
    }
    for (const draft of draftsToPersist.values()) {
      if (draft.pathology_number.trim() && (await persistDraft(draft, false))) {
        createdRecords += 1;
      }
    }
    if (changedCells) {
      const createdText = createdRecords ? `，新建 ${createdRecords} 条记录` : "";
      ElMessage.success(`已粘贴 ${changedCells} 个单元格${createdText}`);
    }
    if (skippedLocked) {
      ElMessage.info(`已跳过 ${skippedLocked} 条锁定记录`);
    }
  } catch (error) {
    updates.forEach(({ record }) => setSaving(record.id, false));
    await loadRecords(activeProjectId.value);
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
    ElMessage.warning("请先勾选需要生成报告的记录");
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

async function toggleRecordLock(record: ProjectRecord): Promise<void> {
  try {
    replaceRecord(await setRecordLock(record.id, !record.locked));
    ElMessage.success(record.locked ? "记录已解锁" : "记录已锁定");
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

function openRepeat(record: ProjectRecord): void {
  operationRecord.value = record;
  repeatDate.value = record.experiment_date ?? new Date().toISOString().slice(0, 10);
  repeatDialogVisible.value = true;
}

async function confirmRepeat(): Promise<void> {
  if (!operationRecord.value) return;
  try {
    const date = normalizeDate(repeatDate.value);
    if (!date) throw new Error("请选择或输入实验日期");
    await repeatRecord(operationRecord.value.id, date);
    repeatDialogVisible.value = false;
    await loadRecords();
    ElMessage.success("重复实验已加入对应日期的实验编排");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "重复实验创建失败");
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
    await exportWorkbook(
      [
        {
          name: currentProject.value.name,
          headers: fields.value.map((field) => field.label),
          rows: items.map((record) => fields.value.map((field) => valueFor(record, field))),
        },
      ],
      `${currentProject.value.name}_台账`,
    );
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
  records.value = [];
  draftRows.value = [];
  selectedRecords.value = [];
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
  await nextTick();
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
        <span>{{ project.name }} 项目台账</span>
      </button>
      <el-button :icon="Setting" class="manage-project-button" @click="managerVisible = true">
        管理检测项目与表头
      </el-button>
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
      <el-button size="small" @click="updateSelectedStatus('已完成')">
        标记已完成
      </el-button>
      <el-button size="small" @click="updateSelectedStatus('待实验')">
        标记待实验
      </el-button>
      <el-button size="small" :icon="Lock" @click="updateSelectedLock(true)">
        锁定所选
      </el-button>
      <el-button size="small" :icon="Unlock" @click="updateSelectedLock(false)">
        解锁所选
      </el-button>
      <el-button size="small" :icon="Document" @click="generateSelectedReports">
        生成报告
      </el-button>
      <el-button size="small" @click="updateSelectedReportStatus(true)">
        标记已生成报告
      </el-button>
      <el-button size="small" @click="updateSelectedReportStatus(false)">
        恢复未生成报告
      </el-button>
      <el-button
        size="small"
        type="danger"
        plain
        :icon="Delete"
        @click="deleteSelectedRecords"
      >
        删除所选
      </el-button>
      <span class="selection-hint">
        单击即可编辑；可直接粘贴 Excel 多行多列数据。锁定后仍可复制。
      </span>
    </section>

    <section class="page-card ledger-table-card">
      <div class="table-title-row">
        <strong>
          当前显示：【{{ currentProject?.name ?? "—" }}】专属台账（{{ records.length }} 条）
          <span v-if="draftRows.length">，另有 {{ draftRows.length }} 个待填写空行</span>
        </strong>
        <span v-if="savingIds.size" class="saving-indicator">
          正在保存 {{ savingIds.size }} 条记录…
        </span>
      </div>

      <el-table
        v-loading="loading"
        element-loading-text="正在切换或读取项目数据…"
        element-loading-background="#ffffff"
        :data="tableRows"
        row-key="id"
        border
        empty-text="当前项目暂无记录"
        height="calc(100vh - 330px)"
        :row-class-name="
          ({ row }: { row: LedgerRow }) =>
            isDraft(row) ? 'draft-row' : row.locked ? 'locked-row' : ''
        "
        @selection-change="selectedRecords = $event"
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
          :label="field.label"
          :width="field.width"
          resizable
        >
          <template #default="{ row, $index }: { row: LedgerRow; $index: number }">
            <EditableDateInput
              v-if="field.data_type === 'date' || field.system_key === 'experiment_date'"
              :model-value="valueFor(row, field)"
              :readonly="row.locked"
              @update:model-value="setValue(row, field, $event)"
              @change="saveField(row, field)"
              @paste="pasteGrid($event, $index, columnIndex)"
            />
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

        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }: { row: LedgerRow }">
            <span v-if="isDraft(row)" class="draft-row-hint">
              填写病理号后自动保存
            </span>
            <div v-else class="row-actions">
              <el-button
                link
                :icon="row.locked ? Unlock : Lock"
                @click="toggleRecordLock(row)"
              >
                {{ row.locked ? "解锁" : "锁定" }}
              </el-button>
              <el-dropdown trigger="click">
                <el-button link type="primary">更多</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item :icon="CopyDocument" @click="openAssign(row)">
                      加入其他项目
                    </el-dropdown-item>
                    <el-dropdown-item :icon="Refresh" @click="openRepeat(row)">
                      重复实验
                    </el-dropdown-item>
                    <el-dropdown-item :icon="Document">
                      <RouterLink
                        class="dropdown-router-link"
                        :to="{ path: '/reports', query: { project: row.project_id, record: row.id } }"
                      >
                        生成报告
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

  <el-dialog v-model="assignDialogVisible" title="把同一病理号加入其他项目" width="480px">
    <p class="dialog-note">
      病理号保持唯一；目标项目会建立独立台账记录，不会复制或增加当前项目记录。
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

  <el-dialog v-model="repeatDialogVisible" title="创建重复实验" width="460px">
    <p class="dialog-note">
      不复制台账记录，只为当前项目记录新增一次实验编排。
    </p>
    <el-form label-position="top">
      <el-form-item label="实验日期">
        <EditableDateInput v-model="repeatDate" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="repeatDialogVisible = false">取消</el-button>
      <el-button type="primary" @click="confirmRepeat">加入实验编排</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.project-strip {
  display: flex;
  align-items: stretch;
  gap: 8px;
  overflow-x: auto;
}

.project-tab {
  display: flex;
  min-width: 190px;
  min-height: 54px;
  align-items: center;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: #344054;
  background: #fff;
  padding: 11px 13px;
  text-align: left;
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

.selection-hint {
  margin-left: auto;
  color: var(--app-muted);
  font-size: 12px;
}

.ledger-table-card {
  min-width: 0;
  overflow: hidden;
}

.table-title-row {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
}

.saving-indicator {
  color: var(--app-primary);
  font-size: 12px;
}

.row-lock {
  color: #d48806;
  font-size: 17px;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.dropdown-router-link {
  color: inherit;
  text-decoration: none;
}

.draft-row-hint {
  color: var(--app-muted);
  font-size: 12px;
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

:deep(.el-table .el-textarea__inner) {
  min-height: 32px !important;
  overflow-wrap: anywhere;
  word-break: break-all;
  line-height: 20px;
  padding: 5px 8px;
}

:deep(.el-table .cell) {
  padding: 5px 7px;
}

:deep(.el-table th.el-table__cell) {
  color: #182230;
  background: #f2f4f7;
}
</style>
