<script setup lang="ts">
import {
  ArrowDown,
  ArrowUp,
  Check,
  Delete,
  Download,
  Plus,
  Rank,
  Setting,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";

import { updateProject } from "@/api/projects";
import { assignExperimentNumbers, listRecords } from "@/api/records";
import { getSetting, putSetting } from "@/api/system";
import { useAppStore } from "@/stores/app";
import type { ProjectRecord } from "@/types/api";
import {
  compareExperimentPathologyNumbers,
  experimentPathologyNumber,
} from "@/utils/experimentScheduling";
import { exportWorkbook } from "@/utils/workbook";

type QueueColumnSource =
  | "sequence"
  | "experiment_number"
  | "pathology_number"
  | "diagnosis"
  | "project"
  | "actions"
  | `field:${string}`
  | "blank";

interface QueueColumn {
  key: string;
  name: string;
  export: boolean;
  source?: QueueColumnSource;
}

interface CandidateTableRef {
  toggleAllSelection: () => void;
  clearSelection: () => void;
  toggleRowSelection: (row: ProjectRecord, selected?: boolean) => void;
}

const defaultQueueColumns: QueueColumn[] = [
  { key: "sequence", name: "序号", export: true, source: "sequence" },
  { key: "expNo", name: "实验编号", export: true, source: "experiment_number" },
  { key: "pathology", name: "病理号", export: true, source: "pathology_number" },
  { key: "project", name: "项目", export: true, source: "project" },
  { key: "actions", name: "顺序调整", export: false, source: "actions" },
];

const defaultCandidateColumns: QueueColumn[] = [
  { key: "candidatePathology", name: "病理号", export: false, source: "pathology_number" },
  { key: "candidateNumber", name: "原实验编号", export: false, source: "experiment_number" },
  { key: "candidateProject", name: "项目", export: false, source: "project" },
];

const appStore = useAppStore();
const loading = ref(false);
const records = ref<ProjectRecord[]>([]);
const queueItems = ref<ProjectRecord[]>([]);
const selectedCandidates = ref<ProjectRecord[]>([]);
const candidateSearch = ref("");
const candidateProjectId = ref("");
const prefixDraft = ref("");
const sortRule = ref<"project" | "manual" | "pathology">("pathology");
const queueColumns = ref<QueueColumn[]>(defaultQueueColumns.map((column) => ({ ...column })));
const candidateColumns = ref<QueueColumn[]>(
  defaultCandidateColumns.map((column) => ({ ...column })),
);
const queueEditorVisible = ref(false);
const candidateEditorVisible = ref(false);
const eligibilityVisible = ref(false);
const newQueueColumnName = ref("");
const newCandidateColumnName = ref("");
const candidateTableRef = ref<CandidateTableRef>();

const queuedRecordIds = computed(() => new Set(queueItems.value.map((item) => item.id)));
const experimentProjects = computed(() =>
  appStore.projects.filter((project) => project.experiment_enabled),
);
const pendingCandidates = computed(() => {
  const keyword = candidateSearch.value.trim().toLocaleLowerCase();
  return records.value.filter((record) => {
    if (record.status !== "待实验" || queuedRecordIds.value.has(record.id)) return false;
    if (!appStore.projectById(record.project_id)?.experiment_enabled) return false;
    if (candidateProjectId.value && record.project_id !== candidateProjectId.value) return false;
    if (!keyword) return true;
    return [
      experimentPathologyNumber(record),
      record.pathology_number,
      record.block_number ?? "",
      record.experiment_number ?? "",
      record.project_name,
      ...Object.values(record.values),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(keyword);
  });
});
const availableFieldLabels = computed(() => {
  const labels = new Set<string>();
  appStore.projects.forEach((project) => project.fields.forEach((field) => labels.add(field.label)));
  return Array.from(labels).sort((a, b) => a.localeCompare(b, "zh-CN"));
});

function inferSource(column: QueueColumn): QueueColumnSource {
  return column.source ?? `field:${column.name}`;
}

function normalizeColumns(value: unknown, defaults: QueueColumn[]): QueueColumn[] {
  if (!Array.isArray(value) || !value.length) return defaults.map((column) => ({ ...column }));
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .filter((item) => item.key !== "diagnosis" && item.key !== "candidateDiagnosis")
    .map((item, index) => ({
      key: typeof item.key === "string" && item.key.trim() ? item.key : `custom_${index}`,
      name: typeof item.name === "string" && item.name.trim() ? item.name : `字段${index + 1}`,
      export: item.export !== false,
      source: typeof item.source === "string" ? (item.source as QueueColumnSource) : "blank",
    }));
}

function projectFieldValue(record: ProjectRecord, fieldLabel: string): string {
  const project = appStore.projectById(record.project_id);
  const field = project?.fields.find(
    (item) => item.label === fieldLabel.trim() || item.key === fieldLabel.trim(),
  );
  if (!field) return "";
  if (field.system_key === "pathology_number") return experimentPathologyNumber(record);
  if (field.system_key === "block_number") return record.block_number ?? "";
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status;
  return record.values[field.id] ?? "";
}

function diagnosisFor(record: ProjectRecord): string {
  const project = appStore.projectById(record.project_id);
  const field = project?.fields.find(
    (item) => item.label.includes("临床诊断") || item.label.includes("诊断"),
  );
  return field ? projectFieldValue(record, field.label) : "";
}

function previewNumber(index: number): string {
  const prefix = prefixDraft.value.trim();
  return prefix ? `${prefix}-${index + 1}` : "";
}

function queueCellValue(record: ProjectRecord, column: QueueColumn, rowIndex: number): string | number {
  const source = inferSource(column);
  if (source === "sequence") return rowIndex + 1;
  if (source === "experiment_number") return previewNumber(rowIndex);
  if (source === "pathology_number") return experimentPathologyNumber(record);
  if (source === "project") return record.project_name;
  if (source === "diagnosis") return diagnosisFor(record);
  if (source.startsWith("field:")) return projectFieldValue(record, source.slice("field:".length));
  return "";
}

function candidateCellValue(record: ProjectRecord, column: QueueColumn): string {
  const source = inferSource(column);
  if (source === "pathology_number") return experimentPathologyNumber(record);
  if (source === "experiment_number") return record.experiment_number ?? "";
  if (source === "project") return record.project_name;
  if (source === "diagnosis") return diagnosisFor(record);
  if (source.startsWith("field:")) return projectFieldValue(record, source.slice("field:".length));
  return "";
}

async function loadAllRecords(): Promise<void> {
  const loaded: ProjectRecord[] = [];
  let offset = 0;
  while (true) {
    const page = await listRecords({ limit: 1000, offset });
    loaded.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total || page.items.length === 0) break;
  }
  records.value = loaded;
}

async function loadPage(): Promise<void> {
  loading.value = true;
  try {
    if (!appStore.projects.length) await appStore.bootstrap();
    const [queueSetting, candidateSetting] = await Promise.all([
      getSetting<QueueColumn[]>("queue_columns"),
      getSetting<QueueColumn[]>("candidate_columns"),
      loadAllRecords(),
    ]);
    queueColumns.value = normalizeColumns(queueSetting.value, defaultQueueColumns);
    candidateColumns.value = normalizeColumns(candidateSetting.value, defaultCandidateColumns);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编排初始化失败");
  } finally {
    loading.value = false;
  }
}

function addSelectedToQueue(): void {
  if (!selectedCandidates.value.length) {
    ElMessage.warning("请先勾选待实验记录");
    return;
  }
  const existing = new Set(queueItems.value.map((item) => item.id));
  queueItems.value.push(...selectedCandidates.value.filter((record) => !existing.has(record.id)));
  selectedCandidates.value = [];
  candidateTableRef.value?.clearSelection();
  ElMessage.success(`已加入 ${queueItems.value.length} 条记录`);
}

function invertCandidates(): void {
  pendingCandidates.value.forEach((record) => {
    candidateTableRef.value?.toggleRowSelection(
      record,
      !selectedCandidates.value.some((selected) => selected.id === record.id),
    );
  });
}

function applySort(): void {
  const next = queueItems.value.slice();
  if (sortRule.value === "project") {
    const projectOrder = new Map(appStore.projects.map((project, index) => [project.id, index]));
    next.sort(
      (a, b) =>
        (projectOrder.get(a.project_id) ?? 9999) - (projectOrder.get(b.project_id) ?? 9999) ||
        compareExperimentPathologyNumbers(a, b),
    );
  } else if (sortRule.value === "pathology") {
    next.sort(compareExperimentPathologyNumbers);
  }
  queueItems.value = next;
  ElMessage.success(sortRule.value === "manual" ? "已保持当前手动顺序" : "编号顺序已更新");
}

function moveQueueItem(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= queueItems.value.length) return;
  const next = queueItems.value.slice();
  const [item] = next.splice(index, 1);
  if (!item) return;
  next.splice(target, 0, item);
  queueItems.value = next;
}

async function applyNumbering(): Promise<void> {
  const prefix = prefixDraft.value.trim();
  if (!queueItems.value.length) {
    ElMessage.warning("当前没有已选择的记录");
    return;
  }
  if (!prefix) {
    ElMessage.warning("请先填写实验编号前缀");
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将为 ${queueItems.value.length} 条记录写入 ${prefix}-1 至 ${prefix}-${queueItems.value.length}，并覆盖原实验编号。`,
      "确认回写实验编号",
      { confirmButtonText: "回写编号", cancelButtonText: "取消", type: "warning" },
    );
    loading.value = true;
    const updated = await assignExperimentNumbers(
      queueItems.value.map((record) => record.id),
      prefix,
    );
    const updatedById = new Map(updated.map((record) => [record.id, record]));
    records.value = records.value.map((record) => updatedById.get(record.id) ?? record);
    queueItems.value = queueItems.value.map((record) => updatedById.get(record.id) ?? record);
    ElMessage.success(`已回写 ${updated.length} 条实验编号，可继续修改或导出 Excel`);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "实验编号回写失败");
  } finally {
    loading.value = false;
  }
}

async function removeItem(item: ProjectRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认移出 ${experimentPathologyNumber(item)}？`, "移出编号队列", {
      confirmButtonText: "移出",
      cancelButtonText: "取消",
      type: "warning",
    });
    queueItems.value = queueItems.value.filter((record) => record.id !== item.id);
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : "移出失败");
    }
  }
}

async function exportQueue(): Promise<void> {
  if (!queueItems.value.length) {
    ElMessage.warning("当前没有可导出的记录");
    return;
  }
  const columns = queueColumns.value.filter(
    (column) => column.export && inferSource(column) !== "actions",
  );
  if (!columns.length) {
    ElMessage.warning("请至少勾选一个导出字段");
    return;
  }
  try {
    const saved = await exportWorkbook(
      [
        {
          name: "实验编号",
          headers: columns.map((column) => column.name),
          rows: queueItems.value.map((record, index) =>
            columns.map((column) => queueCellValue(record, column, index)),
          ),
        },
      ],
      `实验编号_${prefixDraft.value.trim() || "未命名"}`,
    );
    if (saved) ElMessage.success(`已导出 ${queueItems.value.length} 条记录`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编号导出失败");
  }
}

async function saveQueueColumns(): Promise<void> {
  queueColumns.value.forEach((column) => {
    column.name = column.name.trim() || "未命名";
    if (inferSource(column) === "actions") column.export = false;
  });
  await putSetting("queue_columns", queueColumns.value);
  ElMessage.success("编号表头和导出字段已保存");
}

async function saveCandidateColumns(): Promise<void> {
  candidateColumns.value.forEach((column) => {
    column.name = column.name.trim() || "未命名";
    column.export = false;
  });
  await putSetting("candidate_columns", candidateColumns.value);
  ElMessage.success("待实验记录表头已保存");
}

function addColumn(target: "queue" | "candidate"): void {
  const name = target === "queue" ? newQueueColumnName.value.trim() : newCandidateColumnName.value.trim();
  if (!name) {
    ElMessage.warning("请输入表头名称");
    return;
  }
  const column: QueueColumn = {
    key: `custom_${target}_${Date.now()}`,
    name,
    export: target === "queue",
    source: `field:${name}`,
  };
  if (target === "queue") {
    queueColumns.value.splice(Math.max(0, queueColumns.value.length - 1), 0, column);
    newQueueColumnName.value = "";
  } else {
    candidateColumns.value.push(column);
    newCandidateColumnName.value = "";
  }
}

function moveColumn(target: "queue" | "candidate", index: number, offset: -1 | 1): void {
  const columns = target === "queue" ? queueColumns.value : candidateColumns.value;
  const destination = index + offset;
  if (destination < 0 || destination >= columns.length) return;
  const [column] = columns.splice(index, 1);
  if (column) columns.splice(destination, 0, column);
}

function deleteColumn(target: "queue" | "candidate", index: number): void {
  const columns = target === "queue" ? queueColumns.value : candidateColumns.value;
  if (target === "queue" && inferSource(columns[index]!) === "actions") return;
  columns.splice(index, 1);
}

async function setProjectEligibility(projectId: string, enabled: boolean): Promise<void> {
  try {
    await updateProject(projectId, { experiment_enabled: enabled });
    await appStore.reloadProjects();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "项目设置保存失败");
  }
}

onMounted(() => {
  void loadPage();
});
</script>

<template>
  <div class="page-stack" v-loading="loading">
    <section class="rule-card">
      <div>
        <strong>实验编号编排</strong>
        <p>选择待实验记录，填写前缀并按顺序回写实验编号；不修改日期、状态，也不会锁定记录。</p>
      </div>
      <el-tag effect="plain">实验编号允许重复，也可反复修改</el-tag>
    </section>

    <section class="page-card numbering-bar">
      <label class="prefix-field">
        <span>实验编号前缀</span>
        <el-input v-model="prefixDraft" maxlength="80" placeholder="例如：20260801">
          <template #append>-1、-2、-3…</template>
        </el-input>
      </label>
      <span class="numbering-count">当前已选择：<strong>{{ queueItems.length }}</strong> 条</span>
    </section>

    <div class="experiment-workspace">
      <section class="page-card candidate-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">选择待实验记录</h2>
            <p class="page-description">已有实验编号的待实验记录也可以重新加入并覆盖编号</p>
          </div>
          <div class="toolbar">
            <el-button size="small" :icon="Setting" @click="candidateEditorVisible = true">编辑表头</el-button>
            <el-button size="small" @click="eligibilityVisible = true">设置项目</el-button>
            <el-button size="small" @click="candidateTableRef?.toggleAllSelection()">全选</el-button>
            <el-button size="small" @click="invertCandidates">反选</el-button>
          </div>
        </div>
        <div class="page-card-body candidate-filter">
          <el-input v-model="candidateSearch" clearable placeholder="筛选病理号、实验编号、诊断或项目" />
          <el-select v-model="candidateProjectId" clearable placeholder="全部项目">
            <el-option v-for="project in experimentProjects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-button type="primary" @click="addSelectedToQueue">加入编号（{{ selectedCandidates.length }}）</el-button>
        </div>
        <el-table
          ref="candidateTableRef"
          :data="pendingCandidates"
          row-key="id"
          border
          max-height="calc(100vh - 360px)"
          empty-text="没有符合条件的待实验记录"
          @selection-change="selectedCandidates = $event"
        >
          <el-table-column type="selection" width="46" align="center" />
          <el-table-column v-for="column in candidateColumns" :key="column.key" :label="column.name" min-width="120">
            <template #default="{ row }: { row: ProjectRecord }">
              <el-tag v-if="inferSource(column) === 'project'" effect="plain">{{ candidateCellValue(row, column) }}</el-tag>
              <span v-else>{{ candidateCellValue(row, column) || "—" }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="page-card queue-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">编号编排</h2>
            <p class="page-description">当前 {{ queueItems.length }} 条；回写后仍可继续修改</p>
          </div>
          <el-button :icon="Setting" @click="queueEditorVisible = true">编辑表头</el-button>
        </div>
        <div class="page-card-body queue-toolbar">
          <el-select v-model="sortRule" style="width: 160px">
            <el-option label="按病理号排序" value="pathology" />
            <el-option label="按项目集中排序" value="project" />
            <el-option label="保持手动顺序" value="manual" />
          </el-select>
          <el-button :icon="Rank" @click="applySort">应用排序</el-button>
          <el-button :icon="Download" @click="exportQueue">导出 Excel</el-button>
          <el-button type="success" :icon="Check" @click="applyNumbering">编排完成并回写编号</el-button>
        </div>
        <el-table :data="queueItems" row-key="id" border max-height="calc(100vh - 360px)" empty-text="当前没有已选择的记录">
          <el-table-column v-for="column in queueColumns" :key="column.key" :label="column.name" :min-width="inferSource(column) === 'actions' ? 130 : 115" :fixed="inferSource(column) === 'actions' ? 'right' : undefined">
            <template #default="{ row, $index }: { row: ProjectRecord; $index: number }">
              <div v-if="inferSource(column) === 'actions'" class="queue-actions">
                <el-button link :icon="ArrowUp" :disabled="$index === 0" @click="moveQueueItem($index, -1)" />
                <el-button link :icon="ArrowDown" :disabled="$index === queueItems.length - 1" @click="moveQueueItem($index, 1)" />
                <el-button link type="danger" :icon="Delete" @click="removeItem(row)" />
              </div>
              <code v-else-if="inferSource(column) === 'experiment_number' || inferSource(column) === 'pathology_number'">{{ queueCellValue(row, column, $index) || "—" }}</code>
              <el-tag v-else-if="inferSource(column) === 'project'" effect="plain">{{ queueCellValue(row, column, $index) }}</el-tag>
              <span v-else>{{ queueCellValue(row, column, $index) || "—" }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>

  <el-dialog v-model="queueEditorVisible" title="编号表头与导出字段" width="900px">
    <el-table :data="queueColumns" row-key="key" border max-height="460">
      <el-table-column label="顺序" width="90" align="center"><template #default="{ $index }"><el-button link :icon="ArrowUp" :disabled="$index === 0" @click="moveColumn('queue', $index, -1)" /><el-button link :icon="ArrowDown" :disabled="$index === queueColumns.length - 1" @click="moveColumn('queue', $index, 1)" /></template></el-table-column>
      <el-table-column label="显示名称" min-width="170"><template #default="{ row }: { row: QueueColumn }"><el-input v-model="row.name" /></template></el-table-column>
      <el-table-column label="字段来源" min-width="260"><template #default="{ row }: { row: QueueColumn }"><el-select v-model="row.source" :disabled="inferSource(row) === 'actions'" filterable style="width: 100%"><el-option label="序号" value="sequence" /><el-option label="实验编号" value="experiment_number" /><el-option label="病理号" value="pathology_number" /><el-option label="项目" value="project" /><el-option label="自动匹配诊断" value="diagnosis" /><el-option label="留空" value="blank" /><el-option v-for="label in availableFieldLabels" :key="label" :label="`台账表头：${label}`" :value="`field:${label}`" /></el-select></template></el-table-column>
      <el-table-column label="导出" width="80"><template #default="{ row }: { row: QueueColumn }"><el-checkbox v-model="row.export" :disabled="inferSource(row) === 'actions'" /></template></el-table-column>
      <el-table-column label="操作" width="80"><template #default="{ row, $index }: { row: QueueColumn; $index: number }"><el-button link type="danger" :disabled="inferSource(row) === 'actions'" @click="deleteColumn('queue', $index)">删除</el-button></template></el-table-column>
    </el-table>
    <div class="add-column-row"><el-input v-model="newQueueColumnName" placeholder="添加表头" @keyup.enter="addColumn('queue')" /><el-button :icon="Plus" @click="addColumn('queue')">添加</el-button></div>
    <template #footer><el-button @click="queueEditorVisible = false">取消</el-button><el-button type="primary" @click="saveQueueColumns(); queueEditorVisible = false">保存</el-button></template>
  </el-dialog>

  <el-dialog v-model="candidateEditorVisible" title="待实验记录表头" width="820px">
    <el-table :data="candidateColumns" row-key="key" border max-height="430">
      <el-table-column label="顺序" width="90"><template #default="{ $index }"><el-button link :icon="ArrowUp" :disabled="$index === 0" @click="moveColumn('candidate', $index, -1)" /><el-button link :icon="ArrowDown" :disabled="$index === candidateColumns.length - 1" @click="moveColumn('candidate', $index, 1)" /></template></el-table-column>
      <el-table-column label="显示名称" min-width="170"><template #default="{ row }: { row: QueueColumn }"><el-input v-model="row.name" /></template></el-table-column>
      <el-table-column label="字段来源" min-width="260"><template #default="{ row }: { row: QueueColumn }"><el-select v-model="row.source" filterable style="width: 100%"><el-option label="病理号" value="pathology_number" /><el-option label="原实验编号" value="experiment_number" /><el-option label="项目" value="project" /><el-option label="自动匹配诊断" value="diagnosis" /><el-option label="留空" value="blank" /><el-option v-for="label in availableFieldLabels" :key="label" :label="`台账表头：${label}`" :value="`field:${label}`" /></el-select></template></el-table-column>
      <el-table-column label="操作" width="80"><template #default="{ $index }"><el-button link type="danger" @click="deleteColumn('candidate', $index)">删除</el-button></template></el-table-column>
    </el-table>
    <div class="add-column-row"><el-input v-model="newCandidateColumnName" placeholder="添加显示表头" @keyup.enter="addColumn('candidate')" /><el-button :icon="Plus" @click="addColumn('candidate')">添加</el-button></div>
    <template #footer><el-button @click="candidateEditorVisible = false">取消</el-button><el-button type="primary" @click="saveCandidateColumns(); candidateEditorVisible = false">保存</el-button></template>
  </el-dialog>

  <el-dialog v-model="eligibilityVisible" title="设置可进入编号编排的项目" width="560px">
    <p class="editor-note">关闭后，该项目的待实验记录不会出现在候选列表。</p>
    <div class="eligibility-list"><div v-for="project in appStore.projects" :key="project.id" class="eligibility-row"><span>{{ project.name }}</span><el-switch :model-value="project.experiment_enabled" active-text="显示" inactive-text="隐藏" @change="setProjectEligibility(project.id, Boolean($event))" /></div></div>
    <template #footer><el-button type="primary" @click="eligibilityVisible = false">完成</el-button></template>
  </el-dialog>
</template>

<style scoped>
.rule-card,
.numbering-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid #b9d3ff;
  border-radius: 10px;
  background: #f8fbff;
  padding: 10px 14px;
}

.rule-card { border-left: 4px solid var(--app-primary); }
.rule-card p,
.editor-note { margin: 4px 0 0; color: var(--app-muted); font-size: 12px; line-height: 1.6; }
.prefix-field { display: grid; width: min(440px, 48vw); gap: 5px; color: var(--app-muted); font-size: 12px; }
.numbering-count { color: var(--app-muted); font-size: 13px; }
.numbering-count strong { color: #175cd3; font-size: 18px; }
.experiment-workspace { display: grid; grid-template-columns: minmax(420px, 0.9fr) minmax(560px, 1.1fr); gap: 12px; }
.candidate-card,
.queue-card { min-width: 0; overflow: hidden; }
.candidate-filter { display: grid; grid-template-columns: minmax(160px, 1fr) 130px auto; gap: 8px; }
.queue-toolbar,
.queue-actions,
.add-column-row { display: flex; align-items: center; gap: 8px; }
.queue-toolbar { flex-wrap: wrap; }
.add-column-row { max-width: 520px; margin-top: 12px; }
.eligibility-list { display: grid; gap: 8px; margin-top: 14px; }
.eligibility-row { display: flex; align-items: center; justify-content: space-between; border: 1px solid var(--app-border); border-radius: 8px; padding: 10px 12px; }
code { border-radius: 4px; background: #f2f4f7; padding: 2px 5px; }

@media (max-width: 1280px) {
  .experiment-workspace { grid-template-columns: 1fr; }
  .prefix-field { width: min(100%, 520px); }
  .numbering-bar { align-items: stretch; flex-direction: column; }
}
</style>
