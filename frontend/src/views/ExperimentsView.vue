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

import {
  addExperimentPlanItem,
  applyExperimentPlan,
  createExperimentPlan,
  deleteExperimentPlan,
  deleteExperimentPlanItem,
  listExperimentPlans,
  reorderExperimentPlan,
  updateExperimentPlan,
} from "@/api/experiments";
import { updateProject } from "@/api/projects";
import { listRecords } from "@/api/records";
import { getSetting, putSetting } from "@/api/system";
import { useAppStore } from "@/stores/app";
import type {
  ExperimentPlan,
  ExperimentPlanItem,
  ProjectRecord,
} from "@/types/api";
import { comparePathologyNumbers } from "@/utils/pathologySort";
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
  { key: "diagnosis", name: "诊断", export: true, source: "diagnosis" },
  { key: "project", name: "项目", export: true, source: "project" },
  { key: "actions", name: "顺序调整", export: false, source: "actions" },
];

const defaultCandidateColumns: QueueColumn[] = [
  { key: "candidatePathology", name: "病理号", export: false, source: "pathology_number" },
  { key: "candidateDiagnosis", name: "诊断", export: false, source: "diagnosis" },
  { key: "candidateNumber", name: "原实验编号", export: false, source: "experiment_number" },
  { key: "candidateProject", name: "项目", export: false, source: "project" },
];

const appStore = useAppStore();
const loading = ref(false);
const plans = ref<ExperimentPlan[]>([]);
const activePlanId = ref("");
const prefixDraft = ref("");
const records = ref<ProjectRecord[]>([]);
const selectedCandidates = ref<ProjectRecord[]>([]);
const candidateSearch = ref("");
const candidateProjectId = ref("");
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

const activePlan = computed(
  () => plans.value.find((plan) => plan.id === activePlanId.value) ?? null,
);
const planItems = computed(() =>
  (activePlan.value?.items ?? []).slice().sort((a, b) => a.position - b.position),
);
const recordById = computed(
  () => new Map(records.value.map((record) => [record.id, record])),
);
const queuedRecordIds = computed(
  () => new Set(planItems.value.map((item) => item.record_id)),
);
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
      record.pathology_number,
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
  appStore.projects.forEach((project) => {
    project.fields.forEach((field) => labels.add(field.label));
  });
  return Array.from(labels).sort((a, b) => a.localeCompare(b, "zh-CN"));
});

function inferSource(column: QueueColumn): QueueColumnSource {
  if (column.source) return column.source;
  return `field:${column.name}`;
}

function normalizeColumns(value: unknown, defaults: QueueColumn[]): QueueColumn[] {
  if (!Array.isArray(value) || !value.length) {
    return defaults.map((column) => ({ ...column }));
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => ({
      key:
        typeof item.key === "string" && item.key.trim()
          ? item.key
          : `custom_${index}`,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name
          : `字段${index + 1}`,
      export: item.export !== false,
      source:
        typeof item.source === "string"
          ? (item.source as QueueColumnSource)
          : "blank",
    }));
}

function projectFieldValue(record: ProjectRecord, fieldLabel: string): string {
  const project = appStore.projectById(record.project_id);
  const field = project?.fields.find(
    (item) => item.label === fieldLabel.trim() || item.key === fieldLabel.trim(),
  );
  if (!field) return "";
  if (field.system_key === "pathology_number") return record.pathology_number;
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

function previewNumber(item: ExperimentPlanItem): string {
  return prefixDraft.value.trim() ? `${prefixDraft.value.trim()}-${item.position}` : "";
}

function queueCellValue(
  item: ExperimentPlanItem,
  column: QueueColumn,
  rowIndex: number,
): string | number {
  const source = inferSource(column);
  if (source === "sequence") return rowIndex + 1;
  if (source === "experiment_number") return previewNumber(item);
  if (source === "pathology_number") return item.pathology_number;
  if (source === "project") return item.project_name;
  const record = recordById.value.get(item.record_id);
  if (!record) return "";
  if (source === "diagnosis") return diagnosisFor(record);
  if (source.startsWith("field:")) {
    return projectFieldValue(record, source.slice("field:".length));
  }
  return "";
}

function candidateCellValue(record: ProjectRecord, column: QueueColumn): string {
  const source = inferSource(column);
  if (source === "pathology_number") return record.pathology_number;
  if (source === "experiment_number") return record.experiment_number ?? "";
  if (source === "project") return record.project_name;
  if (source === "diagnosis") return diagnosisFor(record);
  if (source.startsWith("field:")) {
    return projectFieldValue(record, source.slice("field:".length));
  }
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

async function loadPlans(preferredId = activePlanId.value): Promise<void> {
  plans.value = await listExperimentPlans();
  if (!plans.value.length) {
    const created = await createExperimentPlan("");
    plans.value = [created];
  }
  activePlanId.value =
    plans.value.find((plan) => plan.id === preferredId)?.id ?? plans.value[0]!.id;
  prefixDraft.value = activePlan.value?.prefix ?? "";
  selectedCandidates.value = [];
  candidateTableRef.value?.clearSelection();
}

async function loadPage(): Promise<void> {
  loading.value = true;
  try {
    if (!appStore.projects.length) await appStore.bootstrap();
    const [queueSetting, candidateSetting] = await Promise.all([
      getSetting<QueueColumn[]>("queue_columns"),
      getSetting<QueueColumn[]>("candidate_columns"),
      loadAllRecords(),
      loadPlans(),
    ]);
    queueColumns.value = normalizeColumns(queueSetting.value, defaultQueueColumns);
    candidateColumns.value = normalizeColumns(
      candidateSetting.value,
      defaultCandidateColumns,
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编排初始化失败");
  } finally {
    loading.value = false;
  }
}

function changeActivePlan(): void {
  prefixDraft.value = activePlan.value?.prefix ?? "";
  selectedCandidates.value = [];
  candidateTableRef.value?.clearSelection();
}

async function createPlan(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      "编号前缀可以与其他编排单相同，并且之后仍可自由修改。",
      "新建实验编排单",
      {
        inputPlaceholder: "例如：20260801",
        confirmButtonText: "创建",
        cancelButtonText: "取消",
      },
    );
    const plan = await createExperimentPlan(value.trim());
    await loadPlans(plan.id);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "新建编排单失败");
  }
}

async function savePrefix(showMessage = false): Promise<void> {
  if (!activePlan.value) return;
  const updated = await updateExperimentPlan(activePlan.value.id, prefixDraft.value);
  const index = plans.value.findIndex((plan) => plan.id === updated.id);
  if (index >= 0) plans.value[index] = updated;
  prefixDraft.value = updated.prefix;
  if (showMessage) ElMessage.success("编号前缀已保存，实验编号已重新计算");
}

async function removeCurrentPlan(): Promise<void> {
  if (!activePlan.value) return;
  try {
    await ElMessageBox.confirm(
      "删除编排单不会清除已经回写到台账的实验编号。",
      "删除实验编排单",
      {
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    await deleteExperimentPlan(activePlan.value.id);
    await loadPlans("");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "删除编排单失败");
  }
}

async function addSelectedToQueue(): Promise<void> {
  if (!activePlan.value || !selectedCandidates.value.length) {
    ElMessage.warning("请先勾选待实验记录");
    return;
  }
  loading.value = true;
  let added = 0;
  try {
    await savePrefix();
    for (const record of selectedCandidates.value) {
      await addExperimentPlanItem(activePlan.value.id, record.id);
      added += 1;
    }
    await loadPlans(activePlan.value.id);
    ElMessage.success(`已加入 ${added} 条记录`);
  } catch (error) {
    await loadPlans(activePlan.value.id);
    ElMessage.error(error instanceof Error ? error.message : "加入实验编排失败");
  } finally {
    loading.value = false;
  }
}

function invertCandidates(): void {
  pendingCandidates.value.forEach((record) => {
    candidateTableRef.value?.toggleRowSelection(
      record,
      !selectedCandidates.value.some((selected) => selected.id === record.id),
    );
  });
}

async function persistOrder(nextItems: ExperimentPlanItem[]): Promise<void> {
  if (!activePlan.value || !nextItems.length) return;
  loading.value = true;
  try {
    const updated = await reorderExperimentPlan(
      activePlan.value.id,
      nextItems.map((item) => item.id),
    );
    const index = plans.value.findIndex((plan) => plan.id === updated.id);
    if (index >= 0) plans.value[index] = updated;
  } catch (error) {
    await loadPlans(activePlan.value.id);
    ElMessage.error(error instanceof Error ? error.message : "实验顺序保存失败");
  } finally {
    loading.value = false;
  }
}

async function applySort(): Promise<void> {
  const next = planItems.value.slice();
  if (sortRule.value === "project") {
    const projectOrder = new Map(
      appStore.projects.map((project, index) => [project.id, index]),
    );
    next.sort(
      (a, b) =>
        (projectOrder.get(a.project_id) ?? 9999) -
          (projectOrder.get(b.project_id) ?? 9999) ||
        a.position - b.position,
    );
  } else if (sortRule.value === "pathology") {
    next.sort((a, b) =>
      comparePathologyNumbers(a.pathology_number, b.pathology_number),
    );
  } else {
    ElMessage.info("已保持当前手动顺序");
    return;
  }
  await persistOrder(next);
  ElMessage.success("实验顺序已保存");
}

async function applyPlan(): Promise<void> {
  if (!activePlan.value || !planItems.value.length) {
    ElMessage.warning("当前编排单没有可回写记录");
    return;
  }
  try {
    await savePrefix();
    const result = await applyExperimentPlan(activePlan.value.id);
    await Promise.all([loadAllRecords(), loadPlans(activePlan.value.id)]);
    ElMessage.success(`已回写 ${result.updated_records} 条实验编号，记录状态和实验日期未改变`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编号回写失败");
  }
}

async function moveItem(index: number, offset: -1 | 1): Promise<void> {
  const target = index + offset;
  if (target < 0 || target >= planItems.value.length) return;
  const next = planItems.value.slice();
  const [item] = next.splice(index, 1);
  if (!item) return;
  next.splice(target, 0, item);
  await persistOrder(next);
}

async function removeItem(item: ExperimentPlanItem): Promise<void> {
  if (!activePlan.value) return;
  try {
    await ElMessageBox.confirm(
      `确认从当前编排单移除 ${item.pathology_number}？已回写的台账编号不会自动清除。`,
      "移出实验编排",
      {
        confirmButtonText: "移出",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    await deleteExperimentPlanItem(activePlan.value.id, item.id);
    await loadPlans(activePlan.value.id);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "移出实验编排失败");
  }
}

async function saveQueueColumns(): Promise<void> {
  queueColumns.value.forEach((column) => {
    column.name = column.name.trim() || "未命名";
    if (inferSource(column) === "actions") column.export = false;
  });
  await putSetting("queue_columns", queueColumns.value);
  ElMessage.success("实验编排表头和导出字段已保存");
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
  const name =
    target === "queue" ? newQueueColumnName.value.trim() : newCandidateColumnName.value.trim();
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
    ElMessage.error(error instanceof Error ? error.message : "项目进入实验编排设置失败");
  }
}

async function exportQueue(): Promise<void> {
  if (!activePlan.value || !planItems.value.length) {
    ElMessage.warning("当前编排单没有可导出的记录");
    return;
  }
  try {
    await savePrefix();
    const columns = queueColumns.value.filter(
      (column) => column.export && inferSource(column) !== "actions",
    );
    if (!columns.length) {
      ElMessage.warning("请至少勾选一个导出字段");
      return;
    }
    const saved = await exportWorkbook(
      [
        {
          name: "实验编排",
          headers: columns.map((column) => column.name),
          rows: planItems.value.map((item, index) =>
            columns.map((column) => queueCellValue(item, column, index)),
          ),
        },
      ],
      `实验编排_${prefixDraft.value.trim() || "未命名"}`,
    );
    if (!saved) return;
    ElMessage.success(`已导出 ${planItems.value.length} 条编排记录`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编排导出失败");
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
        <strong>实验编排仅用于生成、回写实验编号和导出 Excel</strong>
        <p>
          编排不读取或修改台账实验日期，不改变“待实验/已完成”状态，也不会因为回写而锁定。
        </p>
      </div>
      <el-tag effect="plain">前缀可重复、可反复修改</el-tag>
    </section>

    <section class="page-card plan-bar">
      <div class="plan-selector">
        <label>
          <span>编排单</span>
          <el-select v-model="activePlanId" @change="changeActivePlan">
            <el-option
              v-for="plan in plans"
              :key="plan.id"
              :label="plan.prefix || '未命名编排单'"
              :value="plan.id"
            />
          </el-select>
        </label>
        <el-button :icon="Plus" @click="createPlan">新建</el-button>
        <el-button :icon="Delete" type="danger" plain @click="removeCurrentPlan">
          删除
        </el-button>
      </div>
      <label class="prefix-field">
        <span>实验编号前缀</span>
        <el-input
          v-model="prefixDraft"
          placeholder="例如：20260801"
          maxlength="80"
          @change="savePrefix(true)"
        >
          <template #append>-1, -2, -3…</template>
        </el-input>
      </label>
      <div class="plan-meta">
        <span>最近回写：</span>
        <strong>{{ activePlan?.last_applied_at || "尚未回写" }}</strong>
      </div>
    </section>

    <div class="experiment-workspace">
      <section class="page-card candidate-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">选择待实验记录</h2>
            <p class="page-description">已有实验编号的待实验记录也可以重新加入并覆盖编号</p>
          </div>
          <div class="toolbar">
            <el-button size="small" :icon="Setting" @click="candidateEditorVisible = true">
              编辑表头
            </el-button>
            <el-button size="small" @click="eligibilityVisible = true">设置项目</el-button>
            <el-button size="small" @click="candidateTableRef?.toggleAllSelection()">全选</el-button>
            <el-button size="small" @click="invertCandidates">反选</el-button>
          </div>
        </div>
        <div class="page-card-body candidate-filter">
          <el-input
            v-model="candidateSearch"
            clearable
            placeholder="筛选病理号、实验编号、诊断或项目"
          />
          <el-select v-model="candidateProjectId" clearable placeholder="全部项目">
            <el-option
              v-for="project in experimentProjects"
              :key="project.id"
              :label="project.name"
              :value="project.id"
            />
          </el-select>
          <el-button type="primary" @click="addSelectedToQueue">
            加入编排（{{ selectedCandidates.length }}）
          </el-button>
        </div>
        <el-table
          ref="candidateTableRef"
          :data="pendingCandidates"
          row-key="id"
          border
          max-height="calc(100vh - 390px)"
          empty-text="没有符合条件的待实验记录"
          @selection-change="selectedCandidates = $event"
        >
          <el-table-column type="selection" width="52" align="center" />
          <el-table-column
            v-for="column in candidateColumns"
            :key="column.key"
            :label="column.name"
            min-width="130"
          >
            <template #default="{ row }: { row: ProjectRecord }">
              <el-tag v-if="inferSource(column) === 'project'" effect="plain">
                {{ candidateCellValue(row, column) }}
              </el-tag>
              <span v-else>{{ candidateCellValue(row, column) || "—" }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="page-card queue-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">编号编排</h2>
            <p class="page-description">当前 {{ planItems.length }} 条；编排完成后仍可继续修改</p>
          </div>
          <el-button :icon="Setting" @click="queueEditorVisible = true">编辑表头</el-button>
        </div>
        <div class="page-card-body queue-toolbar">
          <el-select v-model="sortRule" style="width: 170px">
            <el-option label="按病理号排序" value="pathology" />
            <el-option label="按项目集中排序" value="project" />
            <el-option label="保持手动顺序" value="manual" />
          </el-select>
          <el-button :icon="Rank" @click="applySort">应用排序</el-button>
          <el-button :icon="Download" @click="exportQueue">导出 Excel</el-button>
          <el-button type="success" :icon="Check" @click="applyPlan">
            编排完成并回写编号
          </el-button>
        </div>
        <el-table
          :data="planItems"
          row-key="id"
          border
          max-height="calc(100vh - 390px)"
          empty-text="当前编排单还没有记录"
        >
          <el-table-column
            v-for="column in queueColumns"
            :key="column.key"
            :label="column.name"
            :min-width="inferSource(column) === 'actions' ? 170 : 120"
            :fixed="inferSource(column) === 'actions' ? 'right' : undefined"
          >
            <template #default="{ row, $index }: { row: ExperimentPlanItem; $index: number }">
              <div v-if="inferSource(column) === 'actions'" class="queue-actions">
                <el-button
                  link
                  :icon="ArrowUp"
                  :disabled="$index === 0"
                  @click="moveItem($index, -1)"
                />
                <el-button
                  link
                  :icon="ArrowDown"
                  :disabled="$index === planItems.length - 1"
                  @click="moveItem($index, 1)"
                />
                <el-button link type="danger" :icon="Delete" @click="removeItem(row)">
                  移出
                </el-button>
              </div>
              <code
                v-else-if="
                  inferSource(column) === 'experiment_number' ||
                  inferSource(column) === 'pathology_number'
                "
              >
                {{ queueCellValue(row, column, $index) || "—" }}
              </code>
              <el-tag v-else-if="inferSource(column) === 'project'" effect="plain">
                {{ queueCellValue(row, column, $index) }}
              </el-tag>
              <span v-else>{{ queueCellValue(row, column, $index) || "—" }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>

  <el-dialog v-model="queueEditorVisible" title="实验编排表头与导出字段" width="900px">
    <el-table :data="queueColumns" row-key="key" border max-height="460">
      <el-table-column label="顺序" width="90" align="center">
        <template #default="{ $index }">
          <el-button link :icon="ArrowUp" :disabled="$index === 0" @click="moveColumn('queue', $index, -1)" />
          <el-button link :icon="ArrowDown" :disabled="$index === queueColumns.length - 1" @click="moveColumn('queue', $index, 1)" />
        </template>
      </el-table-column>
      <el-table-column label="显示名称" min-width="170">
        <template #default="{ row }: { row: QueueColumn }"><el-input v-model="row.name" /></template>
      </el-table-column>
      <el-table-column label="字段来源" min-width="260">
        <template #default="{ row }: { row: QueueColumn }">
          <el-select v-model="row.source" :disabled="inferSource(row) === 'actions'" filterable style="width: 100%">
            <el-option label="序号" value="sequence" />
            <el-option label="实验编号" value="experiment_number" />
            <el-option label="病理号" value="pathology_number" />
            <el-option label="项目" value="project" />
            <el-option label="自动匹配诊断" value="diagnosis" />
            <el-option label="留空" value="blank" />
            <el-option v-for="label in availableFieldLabels" :key="label" :label="`台账表头：${label}`" :value="`field:${label}`" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="导出" width="80">
        <template #default="{ row }: { row: QueueColumn }"><el-checkbox v-model="row.export" :disabled="inferSource(row) === 'actions'" /></template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ row, $index }: { row: QueueColumn; $index: number }">
          <el-button link type="danger" :disabled="inferSource(row) === 'actions'" @click="deleteColumn('queue', $index)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="add-column-row">
      <el-input v-model="newQueueColumnName" placeholder="添加表头" @keyup.enter="addColumn('queue')" />
      <el-button :icon="Plus" @click="addColumn('queue')">添加</el-button>
    </div>
    <template #footer>
      <el-button @click="queueEditorVisible = false">取消</el-button>
      <el-button type="primary" @click="saveQueueColumns(); queueEditorVisible = false">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="candidateEditorVisible" title="待实验记录表头" width="820px">
    <el-table :data="candidateColumns" row-key="key" border max-height="430">
      <el-table-column label="顺序" width="90">
        <template #default="{ $index }">
          <el-button link :icon="ArrowUp" :disabled="$index === 0" @click="moveColumn('candidate', $index, -1)" />
          <el-button link :icon="ArrowDown" :disabled="$index === candidateColumns.length - 1" @click="moveColumn('candidate', $index, 1)" />
        </template>
      </el-table-column>
      <el-table-column label="显示名称" min-width="170">
        <template #default="{ row }: { row: QueueColumn }"><el-input v-model="row.name" /></template>
      </el-table-column>
      <el-table-column label="字段来源" min-width="260">
        <template #default="{ row }: { row: QueueColumn }">
          <el-select v-model="row.source" filterable style="width: 100%">
            <el-option label="病理号" value="pathology_number" />
            <el-option label="原实验编号" value="experiment_number" />
            <el-option label="项目" value="project" />
            <el-option label="自动匹配诊断" value="diagnosis" />
            <el-option label="留空" value="blank" />
            <el-option v-for="label in availableFieldLabels" :key="label" :label="`台账表头：${label}`" :value="`field:${label}`" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ $index }"><el-button link type="danger" @click="deleteColumn('candidate', $index)">删除</el-button></template>
      </el-table-column>
    </el-table>
    <div class="add-column-row">
      <el-input v-model="newCandidateColumnName" placeholder="添加显示表头" @keyup.enter="addColumn('candidate')" />
      <el-button :icon="Plus" @click="addColumn('candidate')">添加</el-button>
    </div>
    <template #footer>
      <el-button @click="candidateEditorVisible = false">取消</el-button>
      <el-button type="primary" @click="saveCandidateColumns(); candidateEditorVisible = false">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="eligibilityVisible" title="设置可进入实验编排的项目" width="560px">
    <p class="editor-note">关闭后，该项目的待实验记录不会出现在候选列表。</p>
    <div class="eligibility-list">
      <div v-for="project in appStore.projects" :key="project.id" class="eligibility-row">
        <span>{{ project.name }}</span>
        <el-switch
          :model-value="project.experiment_enabled"
          active-text="显示"
          inactive-text="隐藏"
          @change="setProjectEligibility(project.id, Boolean($event))"
        />
      </div>
    </div>
    <template #footer><el-button type="primary" @click="eligibilityVisible = false">完成</el-button></template>
  </el-dialog>
</template>

<style scoped>
.rule-card,
.plan-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid #b9d3ff;
  border-radius: 10px;
  background: #f8fbff;
  padding: 12px 14px;
}

.rule-card {
  border-left: 4px solid var(--app-primary);
}

.rule-card p,
.editor-note {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.plan-selector,
.plan-meta {
  display: flex;
  align-items: end;
  gap: 8px;
}

.plan-selector label,
.prefix-field {
  display: grid;
  gap: 5px;
  color: var(--app-muted);
  font-size: 12px;
}

.plan-selector label {
  width: 220px;
}

.prefix-field {
  width: min(420px, 40vw);
}

.experiment-workspace {
  display: grid;
  grid-template-columns: minmax(440px, 0.85fr) minmax(620px, 1.15fr);
  gap: 14px;
}

.candidate-card,
.queue-card {
  min-width: 0;
  overflow: hidden;
}

.candidate-filter {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 135px auto;
  gap: 8px;
}

.queue-toolbar,
.queue-actions,
.add-column-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.queue-toolbar {
  flex-wrap: wrap;
}

.add-column-row {
  max-width: 520px;
  margin-top: 12px;
}

.eligibility-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.eligibility-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 10px 12px;
}

code {
  border-radius: 4px;
  background: #f2f4f7;
  padding: 2px 5px;
}

@media (max-width: 1500px) {
  .experiment-workspace {
    grid-template-columns: 1fr;
  }

  .plan-bar {
    align-items: stretch;
    flex-direction: column;
  }

  .prefix-field {
    width: 100%;
  }
}
</style>
