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
  addExperimentRun,
  commitExperimentBatch,
  deleteExperimentRun,
  getExperimentBatch,
  reorderExperimentRuns,
} from "@/api/experiments";
import { updateProject } from "@/api/projects";
import { listRecords } from "@/api/records";
import { getSetting, putSetting } from "@/api/system";
import EditableDateInput from "@/components/EditableDateInput.vue";
import { useAppStore } from "@/stores/app";
import type { ExperimentRun, ProjectRecord } from "@/types/api";
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
  {
    key: "expNo",
    name: "实验编号",
    export: true,
    source: "experiment_number",
  },
  { key: "caseId", name: "病理号", export: true, source: "pathology_number" },
  { key: "diagnosis", name: "诊断", export: true, source: "diagnosis" },
  { key: "test", name: "项目", export: true, source: "project" },
  { key: "actions", name: "顺序与项目调整", export: false, source: "actions" },
];

const defaultCandidateColumns: QueueColumn[] = [
  { key: "candidateCase", name: "病理号", export: false, source: "pathology_number" },
  { key: "candidateDiagnosis", name: "诊断", export: false, source: "diagnosis" },
  { key: "candidateWax", name: "蜡块号", export: false, source: "field:蜡块号" },
  { key: "candidateProject", name: "项目", export: false, source: "project" },
];

const appStore = useAppStore();
const loading = ref(false);
const experimentDate = ref(
  new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
);
const records = ref<ProjectRecord[]>([]);
const runs = ref<ExperimentRun[]>([]);
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

const recordById = computed(
  () => new Map(records.value.map((record) => [record.id, record])),
);
const queuedRecordIds = computed(() => new Set(runs.value.map((run) => run.record_id)));
const pendingCandidates = computed(() => {
  const keyword = candidateSearch.value.trim().toLocaleLowerCase();
  return records.value.filter((record) => {
    if (record.status !== "待实验" || queuedRecordIds.value.has(record.id)) return false;
    if (!appStore.projectById(record.project_id)?.experiment_enabled) return false;
    if (candidateProjectId.value && record.project_id !== candidateProjectId.value) {
      return false;
    }
    if (!keyword) return true;
    const content = [
      record.pathology_number,
      record.project_name,
      ...Object.values(record.values),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return content.includes(keyword);
  });
});
const experimentProjects = computed(() =>
  appStore.projects.filter((project) => project.experiment_enabled),
);
const availableFieldLabels = computed(() => {
  const labels = new Set<string>();
  appStore.projects.forEach((project) => {
    project.fields.forEach((field) => labels.add(field.label));
  });
  return Array.from(labels).sort((a, b) => a.localeCompare(b, "zh-CN"));
});

function normalizeDate(value: string): string {
  const cleaned = value.trim().replace(/[/.]/g, "-");
  const match = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error("实验日期格式应为 YYYY-MM-DD");
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
    throw new Error("实验日期无效");
  }
  return normalized;
}

function inferSource(column: QueueColumn): QueueColumnSource {
  if (column.source) return column.source;
  const known: Record<string, QueueColumnSource> = {
    sequence: "sequence",
    expNo: "experiment_number",
    caseId: "pathology_number",
    diagnosis: "diagnosis",
    test: "project",
    actions: "actions",
  };
  return known[column.key] ?? `field:${column.name}`;
}

function normalizeColumns(value: unknown): QueueColumn[] {
  if (!Array.isArray(value) || !value.length) {
    return defaultQueueColumns.map((column) => ({ ...column }));
  }
  const result = value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
    )
    .map((item, index) => {
      const key =
        typeof item.key === "string" && item.key.trim()
          ? item.key
          : `custom_queue_${index}`;
      const name =
        typeof item.name === "string" && item.name.trim() ? item.name : `字段${index + 1}`;
      const column: QueueColumn = {
        key,
        name,
        export: item.export !== false,
        source:
          typeof item.source === "string"
            ? (item.source as QueueColumnSource)
            : undefined,
      };
      column.source = inferSource(column);
      if (column.source === "actions") column.export = false;
      return column;
    });
  if (!result.some((column) => column.source === "actions")) {
    result.push({ ...defaultQueueColumns[defaultQueueColumns.length - 1]! });
  }
  return result;
}

function normalizeCandidateColumns(value: unknown): QueueColumn[] {
  if (!Array.isArray(value) || !value.length) {
    return defaultCandidateColumns.map((column) => ({ ...column }));
  }
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
    )
    .map((item, index) => ({
      key:
        typeof item.key === "string" && item.key.trim()
          ? item.key
          : `custom_candidate_${index}`,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name
          : `字段${index + 1}`,
      export: false,
      source:
        typeof item.source === "string"
          ? (item.source as QueueColumnSource)
          : "blank",
    }));
}

function projectFieldValue(record: ProjectRecord, fieldLabel: string): string {
  const project = appStore.projectById(record.project_id);
  const normalized = fieldLabel.trim();
  const field = project?.fields.find(
    (item) => item.label === normalized || item.key === normalized,
  );
  if (!field) return "";
  if (field.system_key === "pathology_number") return record.pathology_number;
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status;
  return record.values[field.id] ?? "";
}

function firstMatchingField(record: ProjectRecord, names: string[]): string {
  const project = appStore.projectById(record.project_id);
  const field = project?.fields.find((item) =>
    names.some((name) => item.label.includes(name)),
  );
  return field ? projectFieldValue(record, field.label) : "";
}

function diagnosisFor(record: ProjectRecord): string {
  return firstMatchingField(record, ["临床诊断", "诊断"]);
}

function queueCellValue(
  run: ExperimentRun,
  column: QueueColumn,
  rowIndex: number,
): string | number {
  const source = inferSource(column);
  if (source === "sequence") return rowIndex + 1;
  if (source === "experiment_number") return run.experiment_number;
  if (source === "pathology_number") return run.pathology_number;
  if (source === "project") return run.project_name;
  const record = recordById.value.get(run.record_id);
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

async function loadBatch(): Promise<void> {
  try {
    experimentDate.value = normalizeDate(experimentDate.value);
    const batch = await getExperimentBatch(experimentDate.value);
    runs.value = batch.runs.slice().sort((a, b) => a.position - b.position);
    selectedCandidates.value = [];
    candidateTableRef.value?.clearSelection();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编排读取失败");
  }
}

async function loadPage(): Promise<void> {
  loading.value = true;
  try {
    if (!appStore.projects.length) await appStore.bootstrap();
    const [setting, candidateSetting] = await Promise.all([
      getSetting<QueueColumn[]>("queue_columns"),
      getSetting<QueueColumn[]>("candidate_columns"),
      loadAllRecords(),
    ]);
    queueColumns.value = normalizeColumns(setting.value);
    candidateColumns.value = normalizeCandidateColumns(candidateSetting.value);
    await loadBatch();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编排初始化失败");
  } finally {
    loading.value = false;
  }
}

function changeExperimentDate(value: string): void {
  experimentDate.value = value;
  void loadBatch();
}

async function addSelectedToQueue(): Promise<void> {
  if (!selectedCandidates.value.length) {
    ElMessage.warning("请先勾选待检记录");
    return;
  }
  loading.value = true;
  let added = 0;
  try {
    const date = normalizeDate(experimentDate.value);
    for (const record of selectedCandidates.value) {
      if (record.status !== "待实验" || queuedRecordIds.value.has(record.id)) continue;
      await addExperimentRun(date, record.id, false);
      added += 1;
    }
    await Promise.all([loadAllRecords(), loadBatch()]);
    if (added) {
      await persistRunOrder(
        runs.value
          .slice()
          .sort((a, b) =>
            comparePathologyNumbers(a.pathology_number, b.pathology_number),
          ),
      );
    }
    ElMessage.success(`已将 ${added} 条项目记录加入当天实验编排`);
  } catch (error) {
    await loadBatch();
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

async function persistRunOrder(nextRuns: ExperimentRun[]): Promise<void> {
  if (!nextRuns.length) {
    runs.value = [];
    return;
  }
  loading.value = true;
  try {
    const batch = await reorderExperimentRuns(
      normalizeDate(experimentDate.value),
      nextRuns.map((run) => run.id),
    );
    runs.value = batch.runs.slice().sort((a, b) => a.position - b.position);
  } catch (error) {
    await loadBatch();
    ElMessage.error(error instanceof Error ? error.message : "实验顺序保存失败");
  } finally {
    loading.value = false;
  }
}

async function applySort(): Promise<void> {
  const next = runs.value.slice();
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
  await persistRunOrder(next);
  ElMessage.success(sortRule.value === "project" ? "已按项目集中排序" : "已按病理号排序");
}

async function commitBatch(): Promise<void> {
  if (!runs.value.length) {
    ElMessage.warning("当天还没有可确认的实验编排");
    return;
  }
  try {
    const date = normalizeDate(experimentDate.value);
    const result = await commitExperimentBatch(date);
    await loadAllRecords();
    ElMessage.success(`已把 ${result.updated_records} 条实验编号回写到对应项目台账`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验编号回写失败");
  }
}

async function moveRun(index: number, offset: -1 | 1): Promise<void> {
  const target = index + offset;
  if (target < 0 || target >= runs.value.length) return;
  const next = runs.value.slice();
  const [run] = next.splice(index, 1);
  if (!run) return;
  next.splice(target, 0, run);
  await persistRunOrder(next);
}

async function moveProjectBlockToTop(projectId: string): Promise<void> {
  const projectRuns = runs.value.filter((run) => run.project_id === projectId);
  const otherRuns = runs.value.filter((run) => run.project_id !== projectId);
  await persistRunOrder([...projectRuns, ...otherRuns]);
  ElMessage.success("该项目组已整体置顶");
}

async function removeRun(run: ExperimentRun): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认从 ${experimentDate.value} 的实验编排移除 ${run.pathology_number}？台账记录不会新增或删除。`,
      "移出实验编排",
      {
        confirmButtonText: "移出",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    await deleteExperimentRun(run.id);
    await Promise.all([loadAllRecords(), loadBatch()]);
    ElMessage.success("已移出实验编排；原项目台账记录未发生增删");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "移出实验编排失败");
  }
}

async function saveQueueColumns(): Promise<void> {
  try {
    queueColumns.value.forEach((column) => {
      column.name = column.name.trim() || "未命名";
      column.source = inferSource(column);
      if (column.source === "actions") column.export = false;
    });
    await putSetting("queue_columns", queueColumns.value);
    ElMessage.success("实验编排表头和导出字段已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "实验表头保存失败");
  }
}

function addQueueColumn(): void {
  const name = newQueueColumnName.value.trim();
  if (!name) {
    ElMessage.warning("请输入表头名称");
    return;
  }
  queueColumns.value.splice(Math.max(0, queueColumns.value.length - 1), 0, {
    key: `custom_queue_${Date.now()}`,
    name,
    export: true,
    source: `field:${name}`,
  });
  newQueueColumnName.value = "";
}

function moveQueueColumn(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= queueColumns.value.length) return;
  const next = queueColumns.value.slice();
  const [column] = next.splice(index, 1);
  if (!column) return;
  next.splice(target, 0, column);
  queueColumns.value = next;
}

function deleteQueueColumn(index: number): void {
  if (queueColumns.value[index]?.source === "actions") return;
  queueColumns.value.splice(index, 1);
}

async function saveCandidateColumns(): Promise<void> {
  try {
    candidateColumns.value.forEach((column) => {
      column.name = column.name.trim() || "未命名";
      column.source = inferSource(column);
      column.export = false;
    });
    await putSetting("candidate_columns", candidateColumns.value);
    ElMessage.success("待检记录表头已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "待检记录表头保存失败");
  }
}

function addCandidateColumn(): void {
  const name = newCandidateColumnName.value.trim();
  if (!name) {
    ElMessage.warning("请输入表头名称");
    return;
  }
  candidateColumns.value.push({
    key: `custom_candidate_${Date.now()}`,
    name,
    export: false,
    source: `field:${name}`,
  });
  newCandidateColumnName.value = "";
}

function moveCandidateColumn(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= candidateColumns.value.length) return;
  const next = candidateColumns.value.slice();
  const [column] = next.splice(index, 1);
  if (!column) return;
  next.splice(target, 0, column);
  candidateColumns.value = next;
}

function deleteCandidateColumn(index: number): void {
  candidateColumns.value.splice(index, 1);
}

async function setProjectEligibility(projectId: string, enabled: boolean): Promise<void> {
  try {
    await updateProject(projectId, { experiment_enabled: enabled });
    await appStore.reloadProjects();
    if (
      candidateProjectId.value &&
      !appStore.projectById(candidateProjectId.value)?.experiment_enabled
    ) {
      candidateProjectId.value = "";
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "项目进入实验编排设置失败");
  }
}

async function exportQueue(): Promise<void> {
  const columns = queueColumns.value.filter(
    (column) => column.export && inferSource(column) !== "actions",
  );
  if (!columns.length) {
    ElMessage.warning("请至少勾选一个导出字段");
    return;
  }
  await exportWorkbook(
    [
      {
        name: "实验编排",
        headers: columns.map((column) => column.name),
        rows: runs.value.map((run, index) =>
          columns.map((column) => queueCellValue(run, column, index)),
        ),
      },
    ],
    `实验编排_${experimentDate.value}`,
  );
  ElMessage.success(`已导出 ${runs.value.length} 个实验位`);
}

onMounted(() => {
  void loadPage();
});
</script>

<template>
  <div class="page-stack" v-loading="loading">
    <section class="rule-card">
      <div>
        <strong>实验编排规则</strong>
        <p>
          一个病理号可参与多个项目；队列始终按项目记录 ID 关联。移出编排只删除该次实验位，不会复制、增加或删除台账记录。
        </p>
      </div>
      <el-tag effect="plain">同一实验日期共用一个批次</el-tag>
    </section>

    <div class="experiment-workspace">
      <section class="page-card candidate-card">
        <div class="page-card-header">
          <div class="step-heading">
            <span>1</span>
            <div>
              <h2 class="page-card-title">选择待检记录</h2>
              <p class="page-description">仅显示“待实验”且未加入当天编排的项目记录</p>
            </div>
          </div>
          <div class="toolbar">
            <el-button size="small" :icon="Setting" @click="candidateEditorVisible = true">
              编辑待检表头
            </el-button>
            <el-button size="small" @click="eligibilityVisible = true">
              设置进入项目
            </el-button>
            <el-button size="small" @click="candidateTableRef?.toggleAllSelection()">
              全选
            </el-button>
            <el-button size="small" @click="invertCandidates">反选</el-button>
            <span class="muted">已选 {{ selectedCandidates.length }} 条</span>
          </div>
        </div>
        <div class="page-card-body candidate-filter">
          <el-input
            v-model="candidateSearch"
            clearable
            placeholder="筛选病理号、诊断、蜡块号或项目"
          />
          <el-select v-model="candidateProjectId" clearable placeholder="全部项目">
            <el-option
              v-for="project in experimentProjects"
              :key="project.id"
              :label="project.name"
              :value="project.id"
            />
          </el-select>
          <el-button type="primary" @click="addSelectedToQueue">加入实验编排</el-button>
        </div>
        <el-table
          ref="candidateTableRef"
          :data="pendingCandidates"
          row-key="id"
          border
          max-height="calc(100vh - 330px)"
          empty-text="没有符合条件的待检记录"
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
          <div class="step-heading">
            <span>2</span>
            <div>
              <h2 class="page-card-title">实验队列编排</h2>
              <p class="page-description">共 {{ runs.length }} 个实验位</p>
            </div>
          </div>
        </div>
        <div class="page-card-body queue-toolbar">
          <label class="inline-field">
            <span>实验日期</span>
            <EditableDateInput
              v-model="experimentDate"
              @change="changeExperimentDate"
            />
          </label>
          <el-select v-model="sortRule" style="width: 170px">
            <el-option label="按病理号排序" value="pathology" />
            <el-option label="按项目集中主排序" value="project" />
            <el-option label="手动保持当前顺序" value="manual" />
          </el-select>
          <el-button type="primary" :icon="Rank" @click="applySort">应用排序</el-button>
          <el-button :icon="Setting" @click="queueEditorVisible = true">
            编辑实验表头
          </el-button>
          <el-tag effect="plain">.xlsx</el-tag>
          <el-button :icon="Download" @click="exportQueue">导出 Excel</el-button>
          <el-button type="success" :icon="Check" @click="commitBatch">
            确认编排并回写台账
          </el-button>
        </div>

        <el-table
          :data="runs"
          row-key="id"
          border
          max-height="calc(100vh - 330px)"
          empty-text="当天还没有实验编排"
        >
          <el-table-column
            v-for="column in queueColumns"
            :key="column.key"
            :label="column.name"
            :min-width="inferSource(column) === 'actions' ? 250 : 120"
            :fixed="inferSource(column) === 'actions' ? 'right' : undefined"
          >
            <template #default="{ row, $index }: { row: ExperimentRun; $index: number }">
              <div v-if="inferSource(column) === 'actions'" class="queue-actions">
                <el-button
                  link
                  :icon="ArrowUp"
                  :disabled="$index === 0"
                  title="上移一条"
                  @click="moveRun($index, -1)"
                />
                <el-button
                  link
                  :icon="ArrowDown"
                  :disabled="$index === runs.length - 1"
                  title="下移一条"
                  @click="moveRun($index, 1)"
                />
                <el-button link @click="moveProjectBlockToTop(row.project_id)">
                  项目组置顶
                </el-button>
                <el-button link type="danger" :icon="Delete" @click="removeRun(row)">
                  移出
                </el-button>
              </div>
              <code
                v-else-if="
                  inferSource(column) === 'experiment_number' ||
                  inferSource(column) === 'pathology_number'
                "
              >
                {{ queueCellValue(row, column, $index) }}
              </code>
              <el-tag v-else-if="inferSource(column) === 'project'" effect="plain">
                {{ queueCellValue(row, column, $index) }}
              </el-tag>
              <span v-else>{{ queueCellValue(row, column, $index) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>

  <el-dialog v-model="queueEditorVisible" title="实验编排表头与导出字段" width="920px">
    <p class="editor-note">
      可添加、删除、改名和调整顺序；“字段来源”可对应任意项目台账表头。不同项目没有该表头时留空。
    </p>
    <el-table :data="queueColumns" row-key="key" border max-height="470">
      <el-table-column label="顺序" width="90" align="center">
        <template #default="{ $index }">
          <el-button
            link
            :icon="ArrowUp"
            :disabled="$index === 0"
            @click="moveQueueColumn($index, -1)"
          />
          <el-button
            link
            :icon="ArrowDown"
            :disabled="$index === queueColumns.length - 1"
            @click="moveQueueColumn($index, 1)"
          />
        </template>
      </el-table-column>
      <el-table-column label="显示名称" min-width="180">
        <template #default="{ row }: { row: QueueColumn }">
          <el-input v-model="row.name" />
        </template>
      </el-table-column>
      <el-table-column label="字段来源" min-width="260">
        <template #default="{ row }: { row: QueueColumn }">
          <el-select
            v-model="row.source"
            :disabled="inferSource(row) === 'actions'"
            filterable
            style="width: 100%"
          >
            <el-option label="序号" value="sequence" />
            <el-option label="实验编号" value="experiment_number" />
            <el-option label="病理号" value="pathology_number" />
            <el-option label="项目" value="project" />
            <el-option label="自动匹配诊断字段" value="diagnosis" />
            <el-option label="留空" value="blank" />
            <el-option
              v-for="label in availableFieldLabels"
              :key="label"
              :label="`台账表头：${label}`"
              :value="`field:${label}`"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="导出" width="90" align="center">
        <template #default="{ row }: { row: QueueColumn }">
          <el-checkbox
            v-model="row.export"
            :disabled="inferSource(row) === 'actions'"
          />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" align="center">
        <template #default="{ row, $index }: { row: QueueColumn; $index: number }">
          <el-button
            link
            type="danger"
            :disabled="inferSource(row) === 'actions'"
            @click="deleteQueueColumn($index)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="add-column-row">
      <el-input
        v-model="newQueueColumnName"
        placeholder="添加表头，例如：DNA浓度"
        @keyup.enter="addQueueColumn"
      />
      <el-button :icon="Plus" @click="addQueueColumn">添加表头</el-button>
    </div>
    <template #footer>
      <el-button @click="queueEditorVisible = false">取消</el-button>
      <el-button
        type="primary"
        @click="
          saveQueueColumns();
          queueEditorVisible = false;
        "
      >
        保存设置
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="candidateEditorVisible" title="待检记录表头" width="820px">
    <p class="editor-note">
      这里只调整“选择待检记录”的显示字段，不会修改项目台账表头或原始数据。
    </p>
    <el-table :data="candidateColumns" row-key="key" border max-height="430">
      <el-table-column label="顺序" width="90" align="center">
        <template #default="{ $index }">
          <el-button
            link
            :icon="ArrowUp"
            :disabled="$index === 0"
            @click="moveCandidateColumn($index, -1)"
          />
          <el-button
            link
            :icon="ArrowDown"
            :disabled="$index === candidateColumns.length - 1"
            @click="moveCandidateColumn($index, 1)"
          />
        </template>
      </el-table-column>
      <el-table-column label="显示名称" min-width="170">
        <template #default="{ row }: { row: QueueColumn }">
          <el-input v-model="row.name" />
        </template>
      </el-table-column>
      <el-table-column label="字段来源" min-width="280">
        <template #default="{ row }: { row: QueueColumn }">
          <el-select v-model="row.source" filterable style="width: 100%">
            <el-option label="病理号" value="pathology_number" />
            <el-option label="实验编号" value="experiment_number" />
            <el-option label="项目" value="project" />
            <el-option label="自动匹配诊断字段" value="diagnosis" />
            <el-option label="留空" value="blank" />
            <el-option
              v-for="label in availableFieldLabels"
              :key="label"
              :label="`台账表头：${label}`"
              :value="`field:${label}`"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" align="center">
        <template #default="{ $index }">
          <el-button link type="danger" @click="deleteCandidateColumn($index)">
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="add-column-row">
      <el-input
        v-model="newCandidateColumnName"
        placeholder="添加显示表头，例如：标本"
        @keyup.enter="addCandidateColumn"
      />
      <el-button :icon="Plus" @click="addCandidateColumn">添加表头</el-button>
    </div>
    <template #footer>
      <el-button @click="candidateEditorVisible = false">取消</el-button>
      <el-button
        type="primary"
        @click="
          saveCandidateColumns();
          candidateEditorVisible = false;
        "
      >
        保存设置
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="eligibilityVisible" title="设置可进入实验编排的项目" width="560px">
    <p class="editor-note">
      关闭后，该项目的新待实验记录不再出现在待检列表；已经加入的实验位不受影响。
    </p>
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
    <template #footer>
      <el-button type="primary" @click="eligibilityVisible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rule-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid #b9d3ff;
  border-left: 4px solid var(--app-primary);
  border-radius: 10px;
  background: #f8fbff;
  padding: 12px 14px;
}

.rule-card p,
.editor-note {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
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

.step-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-heading > span {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 999px;
  color: #0958d9;
  background: var(--app-primary-soft);
  font-weight: 700;
}

.candidate-filter {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 135px auto;
  gap: 8px;
}

.queue-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
}

.inline-field {
  display: grid;
  width: 188px;
  gap: 5px;
  color: var(--app-muted);
  font-size: 12px;
}

.queue-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.add-column-row {
  display: flex;
  max-width: 520px;
  gap: 8px;
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
}
</style>
