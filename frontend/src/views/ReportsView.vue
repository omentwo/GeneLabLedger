<script setup lang="ts">
import {
  Trash2 as Delete,
  FilePlus2 as DocumentAdd,
  Files,
  Plus,
  Printer,
  RefreshCw as Refresh,
  Upload as UploadFilled,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import { getNativePreviewStatus, getPreviewCapabilities } from "@/api/preview";
import { listRecords } from "@/api/records";
import {
  addReportTemplateVersion,
  createReportTemplate,
  deleteReportTemplate,
  listPrintEngines,
  listPrinters,
  listReportTemplates,
  nativePreviewReport,
  printReports,
  replaceReportMappings,
  type ReportMappingInput,
} from "@/api/reports";
import { getSetting, putSetting } from "@/api/system";
import { useAppStore } from "@/stores/app";
import {
  DEFAULT_REPORT_PRINT_ORDER,
  reportRecordIdsInPrintOrder,
  type ReportPrintOrder,
} from "@/utils/reportPrint";
import type {
  MappingSourceType,
  PrintEngine,
  PrintEngineStatus,
  Printer as PrinterInfo,
  ProjectRecord,
  ReportTemplate,
  ReportTemplateVersion,
  NativePreviewTask,
  PreviewCapabilities,
} from "@/types/api";

interface RecordTableRef {
  clearSelection: () => void;
  toggleRowSelection: (row: ProjectRecord, selected?: boolean) => void;
}

const route = useRoute();
const appStore = useAppStore();
const loading = ref(false);
const templates = ref<ReportTemplate[]>([]);
const activeTemplateId = ref("");
const activeVersionId = ref("");
const mappings = ref<ReportMappingInput[]>([]);
const records = ref<ProjectRecord[]>([]);
const selectedRecords = ref<ProjectRecord[]>([]);
const recordSearch = ref("");
const showGenerated = ref(false);
const printers = ref<PrinterInfo[]>([]);
const printEngines = ref<PrintEngineStatus[]>([]);
const selectedPrintEngine = ref<PrintEngine>("auto");
const selectedPrintOrder = ref<ReportPrintOrder>(DEFAULT_REPORT_PRINT_ORDER);
const selectedPrinterName = ref("");
const printing = ref(false);
const previewCapabilities = ref<PreviewCapabilities | null>(null);
const nativePreviewLoading = ref(false);
const createDialogVisible = ref(false);
const createProjectId = ref("");
const createName = ref("");
const createFile = ref<File | null>(null);
const versionFileInput = ref<HTMLInputElement>();
const recordTableRef = ref<RecordTableRef>();

const activeTemplate = computed(() =>
  templates.value.find((template) => template.id === activeTemplateId.value),
);
const activeVersion = computed(() =>
  activeTemplate.value?.versions.find((version) => version.id === activeVersionId.value),
);
const activeProject = computed(() =>
  activeTemplate.value
    ? appStore.projectById(activeTemplate.value.project_id)
    : undefined,
);
const filteredRecords = computed(() => {
  const keyword = recordSearch.value.trim().toLocaleLowerCase();
  return records.value.filter((record) => {
    if (!showGenerated.value && record.report_generated) return false;
    if (!keyword) return true;
    return [
      record.pathology_number,
      record.experiment_number ?? "",
      record.status,
      record.experiment_date ?? "",
      ...Object.values(record.values),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(keyword);
  });
});
const createFileLabel = computed(
  () =>
    createFile.value?.name ??
    `点击选择包含 ${placeholderText("占位符")} 的 DOCX 文件`,
);

const sourceTypeLabels: Record<MappingSourceType, string> = {
  unmapped: "暂不映射",
  field: "台账表头",
  pathology_with_block: "组合病理号",
  fixed: "固定文字",
  current_date: "当前日期",
  experiment_number: "实验编号",
  blank: "留空",
};
let querySelectionConsumed = false;
let disposed = false;
let recordRequestGeneration = 0;
onUnmounted(() => { disposed = true; recordRequestGeneration += 1; });
let templateRequestGeneration = 0;

function placeholderText(value: string): string {
  return `{{${value}}}`;
}

function latestVersion(template: ReportTemplate): ReportTemplateVersion | undefined {
  return template.versions
    .slice()
    .sort((a, b) => b.version_number - a.version_number)[0];
}

function setActiveVersion(versionId: string): void {
  activeVersionId.value = versionId;
  const version = activeVersion.value;
  mappings.value = (version?.placeholders ?? []).map((placeholder) => {
    const saved = version?.mappings.find((mapping) => mapping.placeholder === placeholder);
    return {
      placeholder,
      source_type: (saved?.source_type ?? "unmapped") as MappingSourceType,
      field_id: saved?.field_id ?? null,
      fixed_value: saved?.fixed_value ?? null,
    };
  });
}

async function loadRecordsForTemplate(): Promise<void> {
  const template = activeTemplate.value;
  const generation = ++recordRequestGeneration;
  if (!template) {
    records.value = [];
    return;
  }
  const loaded: ProjectRecord[] = [];
  let offset = 0;
  while (true) {
    const page = await listRecords({
      project_id: template.project_id,
      limit: 1000,
      offset,
    });
    if (generation !== recordRequestGeneration || activeTemplateId.value !== template.id) return;
    loaded.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total || page.items.length === 0) break;
  }
  if (generation !== recordRequestGeneration || activeTemplateId.value !== template.id) return;
  const previousSelection = new Set(selectedRecords.value.map((record) => record.id));
  records.value = loaded;
  selectedRecords.value = [];
  const queryRecords = Array.isArray(route.query.records)
    ? route.query.records.join(",")
    : typeof route.query.records === "string"
      ? route.query.records
      : "";
  const queryRecord = typeof route.query.record === "string" ? route.query.record : "";
  const requestedIds = new Set(
    [queryRecord, ...queryRecords.split(",")].map((id) => id.trim()).filter(Boolean),
  );
  const ids = querySelectionConsumed ? previousSelection : requestedIds;
  querySelectionConsumed = true;
  const requested = records.value.filter((record) => ids.has(record.id));
  if (requested.some((record) => record.report_generated)) {
    showGenerated.value = true;
  }
  await nextTick();
  if (generation !== recordRequestGeneration || activeTemplateId.value !== template.id) return;
  recordTableRef.value?.clearSelection();
  requested.forEach((record) => {
    recordTableRef.value?.toggleRowSelection(record, true);
  });
  if (requested.length) {
    selectedRecords.value = requested;
  }
}

async function loadAvailablePrinters(): Promise<void> {
  const [availablePrinters, availableEngines, savedEngine] = await Promise.all([
    listPrinters(),
    listPrintEngines(),
    getSetting<PrintEngine>("report_print_engine"),
  ]);
  printers.value = availablePrinters;
  printEngines.value = availableEngines;
  if (savedEngine.value && ["auto", "wps", "word"].includes(savedEngine.value)) {
    selectedPrintEngine.value = savedEngine.value;
  }
  const saved = window.localStorage.getItem("report_printer_name") ?? "";
  selectedPrinterName.value =
    printers.value.find((printer) => printer.name === saved)?.name ??
    printers.value.find((printer) => printer.is_default)?.name ??
    printers.value[0]?.name ??
    "";
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
  if (engine === "word") return capabilities.microsoft_writer;
  return capabilities.wps_writer;
}

function nativeEngineLabel(): string {
  if (selectedPrintEngine.value === "word") return "Office";
  if (selectedPrintEngine.value === "wps") return "WPS";
  return "Office/WPS";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function selectTemplate(template: ReportTemplate): Promise<void> {
  activeTemplateId.value = template.id;
  const version = latestVersion(template);
  setActiveVersion(version?.id ?? "");
  await loadRecordsForTemplate();
}

async function savePrintEngine(): Promise<void> {
  try {
    await putSetting("report_print_engine", selectedPrintEngine.value);
    ElMessage.success("打印引擎设置已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打印引擎设置保存失败");
  }
}

async function loadTemplates(preferredId = activeTemplateId.value): Promise<void> {
  const generation = ++templateRequestGeneration;
  const loaded = await listReportTemplates();
  if (generation !== templateRequestGeneration) return;
  templates.value = loaded;
  const queryProject =
    typeof route.query.project === "string" ? route.query.project : "";
  const preferred =
    templates.value.find((template) => template.id === preferredId) ??
    templates.value.find((template) => template.project_id === queryProject) ??
    templates.value[0];
  if (preferred) await selectTemplate(preferred);
  else {
    recordRequestGeneration += 1;
    activeTemplateId.value = "";
    activeVersionId.value = "";
    mappings.value = [];
    records.value = [];
  }
}

async function loadPage(): Promise<void> {
  loading.value = true;
  try {
    if (!appStore.projects.length) await appStore.bootstrap();
    createProjectId.value =
      typeof route.query.project === "string" &&
      appStore.projects.some((project) => project.id === route.query.project)
        ? route.query.project
        : appStore.projects[0]?.id ?? "";
    await Promise.all([loadTemplates(), loadAvailablePrinters(), loadPreviewCapabilities()]);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "报告模板读取失败");
  } finally {
    loading.value = false;
  }
}

async function directPrintSelected(): Promise<void> {
  if (!activeVersion.value || !selectedRecords.value.length) {
    ElMessage.warning("请先选择模板版本和需要打印的记录");
    return;
  }
  if (!selectedPrinterName.value) {
    ElMessage.warning("未检测到可用打印机");
    return;
  }
  const printOrderDescription =
    selectedPrintOrder.value === "descending"
      ? "倒序（先打印末条，最后打印首条）"
      : "正序（先打印首条，最后打印末条）";
  try {
    await ElMessageBox.confirm(
      `确认按${printOrderDescription}把 ${selectedRecords.value.length} 份报告直接发送到打印机“${selectedPrinterName.value}”？`,
      "批量直接打印",
      {
        confirmButtonText: "确认打印",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    throw error;
  }
  printing.value = true;
  try {
    window.localStorage.setItem("report_printer_name", selectedPrinterName.value);
    const recordIds = reportRecordIdsInPrintOrder(
      records.value,
      selectedRecords.value,
      selectedPrintOrder.value,
    );
    const result = await printReports(
      activeVersion.value.id,
      recordIds,
      selectedPrinterName.value,
      selectedPrintEngine.value,
    );
    const engineName = result.print_engine === "word" ? "Microsoft Word" : "WPS";
    ElMessage.success(
      `已通过 ${engineName} 向“${result.printer_name}”提交 ${result.printed_count} 份报告`,
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "直接打印失败");
  } finally {
    printing.value = false;
  }
}

async function openNativeReport(action: "preview" | "open"): Promise<void> {
  if (!activeVersion.value || selectedRecords.value.length !== 1) {
    ElMessage.warning("请先选择一条记录和模板版本");
    return;
  }
  if (!nativeEngineAvailable(selectedPrintEngine.value)) {
    ElMessage.warning("当前电脑未检测到可用的 Office/WPS 文字程序");
    return;
  }
  nativePreviewLoading.value = true;
  try {
    const task = await nativePreviewReport(
      activeVersion.value.id,
      selectedRecords.value[0]!.id,
      selectedPrintEngine.value,
      action,
    );
    void monitorNativeReportJob(task).catch((error) => {
      ElMessage.error(error instanceof Error ? error.message : "Office/WPS 原生窗口状态读取失败");
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "无法打开 Office/WPS 原生窗口");
  } finally {
    nativePreviewLoading.value = false;
  }
}

async function monitorNativeReportJob(task: NativePreviewTask): Promise<void> {
  let current = task;
  let openedNotified = false;
  let failures = 0;
  for (let attempt = 0; attempt < 28_800; attempt += 1) {
    if (disposed) return;
    if (current.status === "failed") {
      ElMessage.error(current.error || "Office/WPS 原生窗口打开失败");
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
    await sleep(openedNotified ? 2000 : 500);
    if (disposed) return;
    try {
      current = await getNativePreviewStatus(task.job_id);
      failures = 0;
    } catch (error) {
      if (disposed) return;
      failures += 1;
      if (failures >= 5) throw error;
    }
  }
}

watch(showGenerated, async (visible) => {
  if (visible) return;
  selectedRecords.value = selectedRecords.value.filter(
    (record) => !record.report_generated,
  );
  await nextTick();
  recordTableRef.value?.clearSelection();
  selectedRecords.value.forEach((record) => {
    recordTableRef.value?.toggleRowSelection(record, true);
  });
});

function handleCreateFile(event: Event): void {
  createFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function submitTemplate(): Promise<void> {
  if (!createProjectId.value || !createName.value.trim() || !createFile.value) {
    ElMessage.warning("请选择项目、填写模板名称并选择 DOCX 文件");
    return;
  }
  loading.value = true;
  try {
    const created = await createReportTemplate(
      createProjectId.value,
      createName.value.trim(),
      createFile.value,
    );
    createDialogVisible.value = false;
    createName.value = "";
    createFile.value = null;
    await loadTemplates(created.id);
    ElMessage.success("模板已保存并识别占位符");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "模板上传失败");
  } finally {
    loading.value = false;
  }
}

function openVersionFilePicker(): void {
  versionFileInput.value?.click();
}

async function uploadVersion(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !activeTemplate.value) return;
  loading.value = true;
  try {
    const version = await addReportTemplateVersion(activeTemplate.value.id, file);
    await loadTemplates(activeTemplate.value.id);
    setActiveVersion(version.id);
    ElMessage.success(`已添加模板版本 v${version.version_number}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "模板版本上传失败");
  } finally {
    loading.value = false;
  }
}

async function saveMappings(): Promise<void> {
  if (!activeVersion.value) return;
  loading.value = true;
  try {
    const saved = await replaceReportMappings(
      activeVersion.value.id,
      mappings.value.map((mapping) => ({
        placeholder: mapping.placeholder,
        source_type: mapping.source_type,
        field_id: mapping.source_type === "field" ? mapping.field_id : null,
        fixed_value: mapping.source_type === "fixed" ? mapping.fixed_value : null,
      })),
    );
    const templateId = activeTemplateId.value;
    await loadTemplates(templateId);
    setActiveVersion(saved.id);
    ElMessage.success("占位符映射已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "映射保存失败");
  } finally {
    loading.value = false;
  }
}

async function removeTemplate(): Promise<void> {
  if (!activeTemplate.value) return;
  try {
    await ElMessageBox.confirm(
      `确认删除报告模板“${activeTemplate.value.name}”及其全部版本？`,
      "删除报告模板",
      {
        confirmButtonText: "删除模板",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    const result = await deleteReportTemplate(activeTemplate.value.id);
    await loadTemplates("");
    if (result.cleanup_warnings.length) {
      ElMessage.warning(`报告模板已删除，但${result.cleanup_warnings.join("；")}`);
    } else {
      ElMessage.success("报告模板已删除");
    }
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "模板删除失败");
  }
}

onMounted(() => {
  void loadPage();
});
</script>

<template>
  <div class="page-stack workspace-page" v-loading="loading">
    <header class="workspace-heading">
      <Files :stroke-width="1.6" aria-hidden="true" />
      <div><h1>报告模板</h1><p>管理模板、映射字段，让记录自然衔接每一份报告。</p></div>
    </header>
    <section class="report-intro">
      <div>
        <strong>占位符由您自由映射</strong>
        <p>
          Word 中的任意 <code v-text="placeholderText('placeholder')" />
          都可对应当前项目的任意台账表头、组合病理号、固定文字、当前日期或实验编号，不依赖显示名称。
        </p>
      </div>
      <el-tag effect="plain">由本机 Office 直接打印</el-tag>
    </section>

    <div class="report-layout">
      <section class="page-card template-list-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">报告模板</h2>
            <p class="page-description">{{ templates.length }} 个模板</p>
          </div>
          <el-button type="primary" :icon="Plus" @click="createDialogVisible = true">
            添加
          </el-button>
        </div>
        <div class="template-list">
          <button
            v-for="template in templates"
            :key="template.id"
            type="button"
            class="template-item"
            :class="{ active: template.id === activeTemplateId }"
            @click="selectTemplate(template)"
          >
            <div>
              <strong>{{ template.name }}</strong>
              <el-tag size="small" effect="plain">{{ template.project_name }}</el-tag>
            </div>
            <span>
              {{ template.versions.length }} 个版本 ·
              {{ latestVersion(template)?.placeholders.length ?? 0 }} 个占位符
            </span>
          </button>
          <el-empty v-if="!templates.length" description="还没有报告模板" />
        </div>
      </section>

      <section class="page-card mapping-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">
              {{ activeTemplate?.name ?? "请选择报告模板" }}
            </h2>
            <p class="page-description">
              {{ activeTemplate?.project_name ?? "上传 DOCX 后配置占位符映射" }}
            </p>
          </div>
          <div v-if="activeTemplate" class="toolbar">
            <el-select
              v-model="activeVersionId"
              style="width: 160px"
              @change="setActiveVersion"
            >
              <el-option
                v-for="version in activeTemplate.versions
                  .slice()
                  .sort((a, b) => b.version_number - a.version_number)"
                :key="version.id"
                :label="`v${version.version_number} · ${version.original_filename}`"
                :value="version.id"
              />
            </el-select>
            <el-button :icon="UploadFilled" @click="openVersionFilePicker">
              上传新版本
            </el-button>
            <input
              ref="versionFileInput"
              class="hidden-file-input"
              type="file"
              accept=".docx"
              @change="uploadVersion"
            />
            <el-button type="danger" plain :icon="Delete" @click="removeTemplate">
              删除模板
            </el-button>
          </div>
        </div>

        <template v-if="activeVersion">
          <div class="mapping-help">
            当前版本共识别 {{ activeVersion.placeholders.length }} 个占位符。
            所有占位符完成映射或明确设为“留空”后，才能直接打印报告。
          </div>
          <el-table :data="mappings" row-key="placeholder" border max-height="430">
            <el-table-column prop="placeholder" label="Word 占位符" min-width="190">
              <template #default="{ row }: { row: ReportMappingInput }">
                <code v-text="placeholderText(row.placeholder)" />
              </template>
            </el-table-column>
            <el-table-column label="来源类型" width="150">
              <template #default="{ row }: { row: ReportMappingInput }">
                <el-select v-model="row.source_type">
                  <el-option
                    v-for="(label, value) in sourceTypeLabels"
                    :key="value"
                    :label="label"
                    :value="value"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="台账字段或固定内容" min-width="300">
              <template #default="{ row }: { row: ReportMappingInput }">
                <el-select
                  v-if="row.source_type === 'field'"
                  v-model="row.field_id"
                  filterable
                  placeholder="选择任意台账表头"
                  style="width: 100%"
                >
                  <el-option
                    v-for="field in activeProject?.fields ?? []"
                    :key="field.id"
                    :label="field.label"
                    :value="field.id"
                  />
                </el-select>
                <el-input
                  v-else-if="row.source_type === 'fixed'"
                  v-model="row.fixed_value"
                  placeholder="每份报告都写入这段文字"
                />
                <span v-else class="muted">
                  {{ sourceTypeLabels[row.source_type] }}
                </span>
              </template>
            </el-table-column>
          </el-table>
          <div class="mapping-actions">
            <el-button type="primary" @click="saveMappings">保存占位符映射</el-button>
          </div>
        </template>
        <div v-else class="empty-state">请选择或添加报告模板</div>
      </section>
    </div>

    <section v-if="activeTemplate" class="page-card">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">逐条或批量直接打印</h2>
          <p class="page-description">
            当前项目：{{ activeTemplate.project_name }}。打印时临时生成 DOCX，提交打印后立即清理，不提供文件下载。
          </p>
        </div>
        <div class="toolbar">
          <el-input
            v-model="recordSearch"
            clearable
            placeholder="搜索病理号或任意台账内容"
            style="width: 300px"
          />
          <el-checkbox v-model="showGenerated">显示已生成报告</el-checkbox>
          <el-button :icon="Refresh" @click="loadRecordsForTemplate">刷新记录</el-button>
          <el-select
            v-model="selectedPrintEngine"
            aria-label="打印引擎"
            style="width: 190px"
            @change="savePrintEngine"
          >
            <el-option
              v-for="engine in printEngines"
              :key="engine.key"
              :label="`${engine.label}${engine.available ? '' : '（未检测到）'}`"
              :value="engine.key"
              :disabled="!engine.available || !nativeEngineAvailable(engine.key)"
            />
          </el-select>
          <el-select
            v-model="selectedPrinterName"
            filterable
            placeholder="选择打印机"
            style="width: 220px"
          >
            <el-option
              v-for="printer in printers"
              :key="printer.name"
              :label="printer.is_default ? `${printer.name}（默认）` : printer.name"
              :value="printer.name"
            />
          </el-select>
          <el-select
            v-model="selectedPrintOrder"
            aria-label="打印顺序"
            style="width: 190px"
          >
            <el-option label="倒序打印（末条 → 首条）" value="descending" />
            <el-option label="正序打印（首条 → 末条）" value="ascending" />
          </el-select>
          <el-button
            :loading="nativePreviewLoading"
            :disabled="selectedRecords.length !== 1 || !nativeEngineAvailable(selectedPrintEngine)"
            @click="openNativeReport('preview')"
          >
            {{ nativeEngineLabel() }} 原生预览
          </el-button>
          <el-button
            :loading="nativePreviewLoading"
            :disabled="selectedRecords.length !== 1 || !nativeEngineAvailable(selectedPrintEngine)"
            @click="openNativeReport('open')"
          >
            使用 {{ nativeEngineLabel() }} 打开
          </el-button>
          <el-button
            type="success"
            :icon="Printer"
            :loading="printing"
            :disabled="!selectedRecords.length || !selectedPrinterName"
            @click="directPrintSelected"
          >
            直接打印 {{ selectedRecords.length || "" }} 份
          </el-button>
        </div>
      </div>
      <el-table
        ref="recordTableRef"
        :data="filteredRecords"
        row-key="id"
        border
        max-height="340"
        empty-text="当前项目暂无台账记录"
        @selection-change="selectedRecords = $event"
      >
        <el-table-column type="selection" width="52" align="center" />
        <el-table-column prop="pathology_number" label="病理号" min-width="160" />
        <el-table-column prop="experiment_date" label="实验日期" width="140">
          <template #default="{ row }: { row: ProjectRecord }">
            {{ row.experiment_date || "—" }}
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="110">
          <template #default="{ row }: { row: ProjectRecord }">
            <el-tag :type="row.status === '已完成' ? 'success' : 'warning'">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报告" width="120">
          <template #default="{ row }: { row: ProjectRecord }">
            <el-tag v-if="row.report_generated" type="success">已生成</el-tag>
            <span v-else class="muted">未生成</span>
          </template>
        </el-table-column>
        <el-table-column label="其他台账内容" min-width="300">
          <template #default="{ row }: { row: ProjectRecord }">
            <span class="record-values">
              {{
                Object.entries(row.values)
                  .map(([fieldId, value]) => {
                    const label =
                      activeProject?.fields.find((field) => field.id === fieldId)?.label ??
                      fieldId;
                    return `${label}：${value}`;
                  })
                  .join("；") || "—"
              }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>

  <el-dialog v-model="createDialogVisible" title="添加报告模板" width="560px">
    <el-form label-position="top">
      <el-form-item label="所属检测项目">
        <el-select v-model="createProjectId" style="width: 100%">
          <el-option
            v-for="project in appStore.projects"
            :key="project.id"
            :label="project.name"
            :value="project.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="模板名称">
        <el-input
          v-model="createName"
          maxlength="160"
          placeholder="例如：TB 基因检测报告"
        />
      </el-form-item>
      <el-form-item label="Word 模板（.docx）">
        <label class="file-drop">
          <el-icon><DocumentAdd /></el-icon>
          <span>{{ createFileLabel }}</span>
          <input type="file" accept=".docx" @change="handleCreateFile" />
        </label>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="createDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="submitTemplate">
        上传并识别占位符
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.report-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--app-border);
  border-left: 4px solid var(--app-primary);
  border-radius: 10px;
  background: linear-gradient(110deg, var(--app-hover), var(--app-hover));
  padding: 12px 14px;
}

.report-intro p {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 12px;
}

.report-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 14px;
}

.template-list-card,
.mapping-card {
  min-width: 0;
  overflow: hidden;
}

.template-list {
  display: grid;
  max-height: 620px;
  align-content: start;
  gap: 8px;
  overflow-y: auto;
  padding: 10px;
}

.template-item {
  display: grid;
  gap: 8px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: inherit;
  background: var(--app-bg);
  padding: 11px;
  text-align: left;
  cursor: pointer;
}

.template-item:hover {
  border-color: var(--app-primary-mid);
}

.template-item.active {
  border-color: var(--app-primary-text);
  background: var(--app-primary-soft);
  box-shadow: inset 3px 0 var(--app-primary);
}

.template-item div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.template-item span {
  color: var(--app-muted);
  font-size: 12px;
}

.mapping-help {
  border-bottom: 1px solid var(--app-border);
  color: var(--app-muted);
  background: var(--app-surface-soft);
  padding: 10px 14px;
  font-size: 12px;
}

.mapping-actions {
  display: flex;
  justify-content: flex-end;
  padding: 12px 14px;
}

.hidden-file-input {
  display: none;
}

code {
  border-radius: 5px;
  color: var(--app-primary-text);
  background: var(--app-primary-soft);
  padding: 3px 6px;
}

.record-values {
  display: block;
  overflow: hidden;
  color: var(--app-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-drop {
  display: flex;
  width: 100%;
  min-height: 100px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--app-subtle);
  border-radius: 9px;
  color: var(--app-muted);
  background: var(--app-surface-soft);
  cursor: pointer;
}

.file-drop:hover {
  color: var(--app-primary-text);
  border-color: var(--app-primary-text);
  background: var(--app-primary-soft);
}

.file-drop input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

@media (max-width: 1300px) {
  .report-layout {
    grid-template-columns: 240px minmax(0, 1fr);
  }
}
.file-drop:focus-within { outline: 2px solid var(--app-primary); outline-offset: 3px; }
.template-item strong { overflow-wrap: anywhere; }
@media (max-width: 960px) {
  .report-layout { grid-template-columns: minmax(0, 1fr); }
  .template-list { max-height: 280px; }
  .report-intro { flex-wrap: wrap; gap: 10px; }
}
</style>
