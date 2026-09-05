<script setup lang="ts">
import {
  CalendarDays as Calendar,
  Check,
  Trash2 as Delete,
  FolderOpen as FolderOpened,
  Clock3,
  Plus,
  RefreshCw as Refresh,
  Play as VideoPlay,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";

import {
  createAutoExportTask,
  deleteAutoExportTask,
  getAutoExportConfig,
  listAutoExportRuns,
  listAutoExportTasks,
  runAutoExportTask,
  updateAutoExportTask,
  validateCronExpression,
} from "@/api/autoExports";
import { useAppStore } from "@/stores/app";
import type {
  AutoExportConfig,
  AutoExportPreset,
  AutoExportRun,
  AutoExportTask,
  AutoExportTaskInput,
} from "@/types/api";
import { chooseNativeDirectory } from "@/utils/desktop";
import { formatShanghaiDateTime } from "@/utils/datetime";

const appStore = useAppStore();
const loading = ref(false);
const tasks = ref<AutoExportTask[]>([]);
const runs = ref<AutoExportRun[]>([]);
const config = ref<AutoExportConfig | null>(null);
const selectedTaskId = ref("");
const unlimitedRetention = ref(false);
const form = reactive<AutoExportTaskInput>({
  name: "",
  project_ids: [],
  output_directory: "",
  file_format: "xlsx",
  schedule_type: "preset",
  preset: "daily",
  run_time: "18:00",
  hourly_minute: 0,
  weekday: 0,
  month_day: 1,
  cron_expression: "0 18 * * *",
  failure_retries: 0,
  retention_count: 10,
  enabled: true,
});

const selectedTask = computed(() =>
  tasks.value.find((task) => task.id === selectedTaskId.value),
);
const editorTitle = computed(() =>
  selectedTask.value ? `编辑：${selectedTask.value.name}` : "新建自动导出任务",
);

const presetLabels: Record<AutoExportPreset, string> = {
  hourly: "每小时",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
};

function copyTaskToForm(task: AutoExportTask): void {
  Object.assign(form, {
    name: task.name,
    project_ids: [...task.project_ids],
    output_directory: task.output_directory,
    file_format: task.file_format,
    schedule_type: task.schedule_type,
    preset: task.preset,
    run_time: task.run_time,
    hourly_minute: task.hourly_minute,
    weekday: task.weekday,
    month_day: task.month_day,
    cron_expression: task.cron_expression ?? "0 18 * * *",
    failure_retries: task.failure_retries,
    retention_count: task.retention_count ?? 10,
    enabled: task.enabled,
  });
  unlimitedRetention.value = task.retention_count == null;
}

function resetForm(): void {
  Object.assign(form, {
    name: `任务${tasks.value.length + 1}`,
    project_ids: appStore.projects.map((project) => project.id),
    output_directory: config.value?.default_output_directory ?? "",
    file_format: "xlsx",
    schedule_type: "preset",
    preset: "daily",
    run_time: "18:00",
    hourly_minute: 0,
    weekday: 0,
    month_day: 1,
    cron_expression: "0 18 * * *",
    failure_retries: 0,
    retention_count: 10,
    enabled: true,
  });
  unlimitedRetention.value = false;
  selectedTaskId.value = "";
  runs.value = [];
}

function projectNames(task: AutoExportTask): string {
  return task.project_ids
    .map((projectId) => appStore.projectById(projectId)?.name ?? "已删除项目")
    .join("、");
}

function scheduleSummary(task: AutoExportTask): string {
  const runTime = task.run_time || "未设置时间";
  if (task.schedule_type === "cron") return `Cron：${task.cron_expression}`;
  if (task.preset === "hourly") return `每小时第 ${task.hourly_minute ?? "未设置"} 分钟`;
  if (task.preset === "weekly") {
    const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    return `每${weekdays[task.weekday] ?? "周一"} ${runTime}`;
  }
  if (task.preset === "monthly") return `每月 ${task.month_day ?? "未设置"} 日 ${runTime}`;
  return `每天 ${runTime}`;
}
let taskLoadGeneration = 0;
let taskSelectionGeneration = 0;

async function loadTasks(preferredTaskId = selectedTaskId.value): Promise<void> {
  const generation = ++taskLoadGeneration;
  const loaded = await listAutoExportTasks();
  if (generation !== taskLoadGeneration) return;
  tasks.value = loaded;
  const target = tasks.value.find((task) => task.id === preferredTaskId);
  if (target) {
    await selectTask(target);
  } else if (tasks.value[0]) {
    await selectTask(tasks.value[0]);
  } else {
    taskSelectionGeneration += 1;
    resetForm();
  }
}

async function loadPage(): Promise<void> {
  loading.value = true;
  try {
    if (!appStore.projects.length) await appStore.bootstrap();
    config.value = await getAutoExportConfig();
    await loadTasks();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "自动导出页面读取失败");
  } finally {
    loading.value = false;
  }
}

async function selectTask(task: AutoExportTask): Promise<void> {
  const generation = ++taskSelectionGeneration;
  selectedTaskId.value = task.id;
  copyTaskToForm(task);
  try {
    const loaded = await listAutoExportRuns(task.id);
    if (generation !== taskSelectionGeneration || selectedTaskId.value !== task.id) return;
    runs.value = loaded;
  } catch (error) {
    if (generation !== taskSelectionGeneration || selectedTaskId.value !== task.id) return;
    runs.value = [];
    ElMessage.error(error instanceof Error ? error.message : "执行历史读取失败");
  }
}

async function chooseDirectory(): Promise<void> {
  loading.value = true;
  try {
    const result = await chooseNativeDirectory(form.output_directory);
    if (result.selected) {
      form.output_directory = result.directory;
      ElMessage.success("已选择本机导出目录");
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "目录选择失败");
  } finally {
    loading.value = false;
  }
}

async function checkCron(): Promise<void> {
  try {
    const expression = form.cron_expression?.trim() ?? "";
    await validateCronExpression(expression);
    ElMessage.success("Cron 表达式有效");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "Cron 表达式无效");
  }
}

function requiredInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`请填写有效的${label}（${min}–${max}）`);
  }
  return value;
}

function payload(): AutoExportTaskInput {
  if (!form.run_time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.run_time)) {
    throw new Error("请填写有效的执行时间");
  }
  return {
    ...form,
    name: form.name.trim(),
    project_ids: [...form.project_ids],
    output_directory: form.output_directory.trim(),
    cron_expression:
      form.schedule_type === "cron" ? form.cron_expression?.trim() || null : null,
    retention_count: unlimitedRetention.value ? null : requiredInteger(form.retention_count, "保留数量", 1, 10000),
    failure_retries: requiredInteger(form.failure_retries, "重试次数", 0, 10),
    hourly_minute: requiredInteger(form.hourly_minute, "分钟", 0, 59),
    weekday: requiredInteger(form.weekday, "星期", 0, 6),
    month_day: requiredInteger(form.month_day, "日期", 1, 31),
  };
}

async function saveTask(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning("请填写任务名称");
    return;
  }
  if (!form.project_ids.length) {
    ElMessage.warning("请至少选择一个导出项目");
    return;
  }
  if (!form.output_directory.trim()) {
    ElMessage.warning("请选择或填写导出目录");
    return;
  }
  loading.value = true;
  try {
    const saved = selectedTaskId.value
      ? await updateAutoExportTask(selectedTaskId.value, payload())
      : await createAutoExportTask(payload());
    await loadTasks(saved.id);
    ElMessage.success("自动导出任务已保存，后端调度立即生效");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "任务保存失败");
  } finally {
    loading.value = false;
  }
}

async function runTaskNow(): Promise<void> {
  const taskId = selectedTask.value?.id;
  if (!taskId) {
    ElMessage.warning("请先保存或选择任务");
    return;
  }
  loading.value = true;
  try {
    const run = await runAutoExportTask(taskId);
    const loadedRuns = await listAutoExportRuns(taskId);
    if (selectedTaskId.value === taskId) {
      runs.value = loadedRuns;
      tasks.value = await listAutoExportTasks();
    }
    ElMessage.success(`导出成功：${run.file_path ?? "已完成"}`);
  } catch (error) {
    if (selectedTaskId.value === taskId) {
      runs.value = await listAutoExportRuns(taskId).catch(() => []);
    }
    ElMessage.error(error instanceof Error ? error.message : "立即导出失败");
  } finally {
    loading.value = false;
  }
}

async function removeTask(): Promise<void> {
  if (!selectedTask.value) return;
  try {
    await ElMessageBox.confirm(
      `确认删除自动导出任务“${selectedTask.value.name}”？已导出的 Excel 文件会保留。`,
      "删除自动导出任务",
      {
        confirmButtonText: "删除任务",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    await deleteAutoExportTask(selectedTask.value.id);
    await loadTasks("");
    ElMessage.success("任务已删除，已有导出文件未删除");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "任务删除失败");
  }
}

onMounted(() => {
  void loadPage();
});
</script>

<template>
  <div class="page-stack workspace-page" v-loading="loading">
    <header class="workspace-heading">
      <Clock3 :stroke-width="1.6" aria-hidden="true" />
      <div><h1>自动导出</h1><p>安排导出计划，在本机运行期间有序留存数据。</p></div>
    </header>
    <section class="auto-export-intro">
      <div>
        <strong>由本机后端定时执行</strong>
        <p>
          每个任务可独立选择项目、周期、格式、目录、重试次数和成功文件保留份数。自动导出由本机后端执行；关闭桌面应用会同时停止后端，应用关闭期间不会运行，请保持桌面应用运行。
        </p>
      </div>
      <el-tag effect="plain">
        {{ config?.timezone ?? "Asia/Shanghai" }}
      </el-tag>
    </section>

    <div class="auto-export-layout">
      <section class="page-card task-list-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">自动导出任务</h2>
            <p class="page-description">{{ tasks.length }} 个任务</p>
          </div>
          <el-button type="primary" :icon="Plus" @click="resetForm">添加任务</el-button>
        </div>
        <div class="task-list">
          <button
            v-for="task in tasks"
            :key="task.id"
            type="button"
            class="task-item"
            :class="{ active: task.id === selectedTaskId }"
            @click="selectTask(task)"
          >
            <div class="task-title">
              <span
                class="status-dot"
                :class="{
                  enabled: task.enabled && task.last_status !== 'failed',
                  failed: task.last_status === 'failed',
                  disabled: !task.enabled,
                }"
              />
              <strong>{{ task.name }}</strong>
              <el-tag size="small" effect="plain">{{ task.file_format }}</el-tag>
            </div>
            <p>{{ projectNames(task) }}</p>
            <small>{{ scheduleSummary(task) }}</small>
            <small>下次执行：{{ formatShanghaiDateTime(task.next_run_at) }}</small>
          </button>
          <el-empty v-if="!tasks.length" description="还没有自动导出任务" />
        </div>
      </section>

      <section class="page-card editor-card">
        <div class="page-card-header">
          <div>
            <h2 class="page-card-title">{{ editorTitle }}</h2>
            <p class="page-description">
              {{ selectedTask ? "修改保存后立即更新调度" : "保存后由后端开始调度；需保持桌面应用运行" }}
            </p>
          </div>
          <el-switch
            v-model="form.enabled"
            active-text="启用任务"
            inactive-text="停用"
          />
        </div>
        <div class="page-card-body">
          <el-form label-position="top">
            <div class="form-grid">
              <el-form-item label="任务名称" class="span-2">
                <el-input
                  v-model="form.name"
                  maxlength="160"
                  placeholder="例如：每日TB导出"
                />
              </el-form-item>
              <el-form-item label="导出格式">
                <el-input model-value=".xlsx" disabled />
              </el-form-item>
              <el-form-item label="周期类型">
                <el-select v-model="form.schedule_type">
                  <el-option label="预设周期" value="preset" />
                  <el-option label="Cron 表达式" value="cron" />
                </el-select>
              </el-form-item>

              <el-form-item label="导出项目" class="span-full">
                <el-checkbox-group v-model="form.project_ids" class="project-choices">
                  <el-checkbox
                    v-for="project in appStore.projects"
                    :key="project.id"
                    :value="project.id"
                    border
                  >
                    {{ project.name }}
                  </el-checkbox>
                </el-checkbox-group>
              </el-form-item>

              <el-form-item label="导出目录（Windows 绝对路径）" class="span-full">
                <div class="directory-row">
                  <el-input
                    v-model="form.output_directory"
                    placeholder="例如：D:\实验室自动导出"
                  />
                  <el-button :icon="FolderOpened" @click="chooseDirectory">
                    选择目录
                  </el-button>
                  <el-button
                    v-if="config"
                    @click="form.output_directory = config.default_output_directory"
                  >
                    使用默认
                  </el-button>
                </div>
              </el-form-item>

              <template v-if="form.schedule_type === 'preset'">
                <el-form-item label="预设周期">
                  <el-select v-model="form.preset">
                    <el-option
                      v-for="(label, value) in presetLabels"
                      :key="value"
                      :label="label"
                      :value="value"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item v-if="form.preset === 'hourly'" label="每小时的第几分钟">
                  <el-input-number
                    v-model="form.hourly_minute"
                    :min="0"
                    :max="59"
                    controls-position="right"
                  />
                </el-form-item>
                <el-form-item v-else label="执行时间">
                  <el-time-picker
                    v-model="form.run_time"
                    value-format="HH:mm"
                    format="HH:mm"
                    placeholder="选择时间"
                  />
                </el-form-item>
                <el-form-item v-if="form.preset === 'weekly'" label="星期">
                  <el-select v-model="form.weekday">
                    <el-option label="星期一" :value="0" />
                    <el-option label="星期二" :value="1" />
                    <el-option label="星期三" :value="2" />
                    <el-option label="星期四" :value="3" />
                    <el-option label="星期五" :value="4" />
                    <el-option label="星期六" :value="5" />
                    <el-option label="星期日" :value="6" />
                  </el-select>
                </el-form-item>
                <el-form-item v-if="form.preset === 'monthly'" label="每月日期">
                  <el-input-number
                    v-model="form.month_day"
                    :min="1"
                    :max="31"
                    controls-position="right"
                  />
                </el-form-item>
              </template>

              <el-form-item v-else label="Cron 表达式" class="span-full">
                <div class="cron-row">
                  <el-input
                    v-model="form.cron_expression"
                    placeholder="例如：0 18 * * *"
                  />
                  <el-button :icon="Check" @click="checkCron">验证</el-button>
                </div>
                <div class="form-help">
                  {{ config?.cron_format ?? "分钟 小时 日期 月份 星期" }}
                </div>
              </el-form-item>

              <el-form-item label="失败重试次数">
                <el-input-number
                  v-model="form.failure_retries"
                  :min="0"
                  :max="10"
                  controls-position="right"
                />
              </el-form-item>
              <el-form-item label="成功文件保留份数" class="span-2">
                <div class="retention-row">
                  <el-input-number
                    v-model="form.retention_count"
                    :min="1"
                    :max="10000"
                    :disabled="unlimitedRetention"
                    controls-position="right"
                  />
                  <el-checkbox v-model="unlimitedRetention">不设上限</el-checkbox>
                </div>
              </el-form-item>
            </div>
          </el-form>

          <div class="editor-actions">
            <el-button type="primary" :icon="Calendar" @click="saveTask">
              保存任务
            </el-button>
            <el-button
              :icon="VideoPlay"
              :disabled="!selectedTask"
              @click="runTaskNow"
            >
              立即执行
            </el-button>
            <el-button
              type="danger"
              plain
              :icon="Delete"
              :disabled="!selectedTask"
              @click="removeTask"
            >
              删除任务
            </el-button>
          </div>
        </div>

        <div class="history-heading">
          <div>
            <strong>最近执行历史</strong>
            <span>{{ selectedTask ? selectedTask.name : "保存或选择任务后显示" }}</span>
          </div>
          <el-button
            link
            :icon="Refresh"
            :disabled="!selectedTask"
            @click="selectedTask && selectTask(selectedTask)"
          >
            刷新
          </el-button>
        </div>
        <el-table :data="runs" border max-height="300" empty-text="暂无执行记录">
          <el-table-column label="开始时间" width="175">
            <template #default="{ row }: { row: AutoExportRun }">
              {{ formatShanghaiDateTime(row.started_at) }}
            </template>
          </el-table-column>
          <el-table-column label="触发方式" width="100">
            <template #default="{ row }: { row: AutoExportRun }">
              {{ row.trigger === "manual" ? "手动" : "定时" }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="95">
            <template #default="{ row }: { row: AutoExportRun }">
              <el-tag
                :type="
                  row.status === 'success'
                    ? 'success'
                    : row.status === 'running'
                      ? 'warning'
                      : 'danger'
                "
              >
                {{ row.status === "success" ? "成功" : row.status === "running" ? "执行中" : "失败" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="attempt_count" label="尝试次数" width="95" />
          <el-table-column label="文件或错误" min-width="280">
            <template #default="{ row }: { row: AutoExportRun }">
              <span class="run-detail">{{ row.file_path || row.error_message || "—" }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.auto-export-intro {
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

.auto-export-intro p {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 12px;
}

.auto-export-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 14px;
}

.task-list-card,
.editor-card {
  min-width: 0;
  overflow: hidden;
}

.task-list {
  display: grid;
  max-height: calc(100vh - 220px);
  align-content: start;
  gap: 8px;
  overflow-y: auto;
  padding: 10px;
}

.task-item {
  display: grid;
  gap: 7px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: inherit;
  background: var(--app-bg);
  padding: 11px;
  text-align: left;
  cursor: pointer;
}

.task-item:hover {
  border-color: var(--app-primary-mid);
}

.task-item.active {
  border-color: var(--app-primary-text);
  background: var(--app-primary-soft);
  box-shadow: inset 3px 0 var(--app-primary);
}

.task-title {
  display: flex;
  align-items: center;
  gap: 7px;
}

.task-title strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-item p,
.task-item small {
  margin: 0;
  overflow: hidden;
  color: var(--app-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--app-subtle);
}

.status-dot.enabled {
  background: var(--app-live);
}

.status-dot.failed {
  background: var(--app-danger);
}

.status-dot.disabled {
  background: var(--app-subtle);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(135px, 1fr));
  gap: 0 12px;
}

.span-2 {
  grid-column: span 2;
}

.span-full {
  grid-column: 1 / -1;
}

.project-choices,
.directory-row,
.cron-row,
.retention-row,
.editor-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.directory-row,
.cron-row {
  width: 100%;
}

.directory-row .el-input,
.cron-row .el-input {
  min-width: 0;
  flex: 1 1 220px;
}

.form-help {
  margin-top: 5px;
  color: var(--app-muted);
  font-size: 12px;
}

.editor-actions {
  border-top: 1px solid var(--app-border);
  padding-top: 14px;
}

.history-heading {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--app-border);
  padding: 8px 14px;
}

.history-heading span {
  margin-left: 10px;
  color: var(--app-muted);
  font-size: 12px;
}

.run-detail {
  overflow-wrap: anywhere;
}

@media (max-width: 1350px) {
  .auto-export-layout {
    grid-template-columns: 240px minmax(0, 1fr);
  }

  .form-grid {
    grid-template-columns: repeat(2, minmax(160px, 1fr));
  }
}
.task-item small { font-size: 12px; line-height: 1.6; }
@media (max-width: 960px) {
  .auto-export-layout { grid-template-columns: minmax(0, 1fr); }
  .task-list { max-height: 280px; }
  .auto-export-intro { flex-wrap: wrap; gap: 10px; }
}
@media (max-width: 600px) {
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .span-2 { grid-column: auto; }
  .history-heading { flex-wrap: wrap; }
}
</style>
