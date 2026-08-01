<script setup lang="ts">
import { Download } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref, watch } from "vue";

import { listRecords } from "@/api/records";
import EditableDateInput from "@/components/EditableDateInput.vue";
import { useAppStore } from "@/stores/app";
import type { FieldDefinition, ProjectRecord } from "@/types/api";
import { shanghaiDateKey, shiftDateKey, shiftMonthKey } from "@/utils/datetime";
import { exportWorkbook } from "@/utils/workbook";

const appStore = useAppStore();
const records = ref<ProjectRecord[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const exportVisible = ref(false);
const exportProjects = ref<string[]>([]);
const monthlyProjectId = ref("");
const exportFilter = reactive({
  start: "",
  end: "",
});

const total = computed(() => records.value.length);
const pending = computed(
  () => records.value.filter((record) => record.status === "待实验").length,
);
const completed = computed(
  () => records.value.filter((record) => record.status === "已完成").length,
);
const recentThirtyDays = computed(() => {
  const endKey = shanghaiDateKey();
  const startKey = shiftDateKey(endKey, -29);
  return records.value.filter((record) => {
    const date = record.experiment_date ?? "";
    return date >= startKey && date <= endKey;
  }).length;
});

const projectStats = computed(() =>
  appStore.projects.map((project) => {
    const projectRecords = records.value.filter((record) => record.project_id === project.id);
    return {
      id: project.id,
      name: project.name,
      total: projectRecords.length,
      pending: projectRecords.filter((record) => record.status === "待实验").length,
      completed: projectRecords.filter((record) => record.status === "已完成").length,
    };
  }),
);
const projectChartStats = computed(() =>
  projectStats.value
    .map((project) => {
      const endKey = shanghaiDateKey();
      const previousMonthKey = shiftMonthKey(endKey.slice(0, 7), -1);
      const startKey = `${previousMonthKey}-01`;
      const nextMonthKey = shiftMonthKey(previousMonthKey, 1);
      const endDate = `${nextMonthKey}-01`;
      const previousMonthCount = records.value.filter((record) => {
        const date = record.experiment_date ?? "";
        return record.project_id === project.id && date >= startKey && date < endDate;
      }).length;
      return { ...project, previousMonth: previousMonthCount };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
);
const projectMax = computed(() =>
  Math.max(1, ...projectChartStats.value.map((project) => project.total)),
);
const monthlyProjectName = computed(
  () =>
    appStore.projects.find((project) => project.id === monthlyProjectId.value)?.name ??
    "全部项目",
);
const monthlyStats = computed(() => {
  const currentMonthKey = shanghaiDateKey().slice(0, 7);
  return Array.from({ length: 12 }, (_item, index) => {
    const key = shiftMonthKey(currentMonthKey, index - 11);
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    const monthRecords = records.value.filter(
      (record) =>
        (!monthlyProjectId.value || record.project_id === monthlyProjectId.value) &&
        (record.experiment_date ?? "").startsWith(key),
    );
    return {
      key,
      label:
        month === 1
          ? `${year}年1月`
          : `${month}月`,
      total: monthRecords.length,
      pending: monthRecords.filter((record) => record.status === "待实验").length,
      completed: monthRecords.filter((record) => record.status === "已完成").length,
    };
  });
});
const monthlyMax = computed(() =>
  Math.max(1, ...monthlyStats.value.map((month) => month.total)),
);

function normalizeDate(value: string): string {
  const cleaned = value.trim().replace(/[/.]/g, "-");
  if (!cleaned) return "";
  const match = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error("日期格式应为 YYYY-MM-DD");
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
    throw new Error("日期无效");
  }
  return normalized;
}

function fieldValue(record: ProjectRecord, field: FieldDefinition): string {
  if (field.system_key === "pathology_number") return record.pathology_number;
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status;
  return record.values[field.id] ?? "";
}

async function exportStatistics(): Promise<void> {
  try {
    const start = normalizeDate(exportFilter.start);
    const end = normalizeDate(exportFilter.end);
    if (start && end && start > end) throw new Error("开始日期不能晚于结束日期");
    if (!exportProjects.value.length) throw new Error("请至少选择一个导出项目");
    exportFilter.start = start;
    exportFilter.end = end;
    const selectedProjects = appStore.projects.filter((project) =>
      exportProjects.value.includes(project.id),
    );
    const sheets = selectedProjects.map((project) => {
      const fields = project.fields
        .filter((field) => !field.hidden)
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order);
      const projectRecords = records.value.filter((record) => {
        const date = record.experiment_date ?? "";
        return (
          record.project_id === project.id &&
          (!start || date >= start) &&
          (!end || date <= end)
        );
      });
      return {
        name: project.name,
        headers: ["_record_id", "_project_id", ...fields.map((field) => field.label)],
        hiddenColumns: [1, 2],
        rows: projectRecords.map((record) => [
          record.id,
          record.project_id,
          ...fields.map((field) => fieldValue(record, field)),
        ]),
      };
    });
    const saved = await exportWorkbook(sheets, "统计筛选台账");
    const count = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
    if (!saved) return;
    ElMessage.success(`正在按 ${sheets.length} 个项目分工作表导出 ${count} 条记录`);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "导出条件无效");
  }
}

async function loadDashboard(): Promise<void> {
  loading.value = true;
  errorMessage.value = "";
  try {
    const loaded: ProjectRecord[] = [];
    let offset = 0;
    while (true) {
      const page = await listRecords({ limit: 1000, offset });
      loaded.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) break;
    }
    records.value = loaded;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "统计数据读取失败";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadDashboard();
});

watch(
  () => appStore.projects,
  (projects) => {
    if (!exportProjects.value.length) {
      exportProjects.value = projects.map((project) => project.id);
    }
    if (
      monthlyProjectId.value &&
      !projects.some((project) => project.id === monthlyProjectId.value)
    ) {
      monthlyProjectId.value = "";
    }
  },
  { deep: true, immediate: true },
);
</script>

<template>
  <div class="page-stack" v-loading="loading">
    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
    />

    <div class="dashboard-kpis">
      <div class="kpi-card">
        <span>总记录数</span>
        <strong>{{ total }}</strong>
        <small>全部项目台账</small>
      </div>
      <div class="kpi-card">
        <span>待实验</span>
        <strong>{{ pending }}</strong>
        <small>可进入实验编排</small>
      </div>
      <div class="kpi-card">
        <span>已完成</span>
        <strong>{{ completed }}</strong>
        <small>不进入待检队列</small>
      </div>
      <div class="kpi-card">
        <span>检测项目</span>
        <strong>{{ appStore.projects.length }}</strong>
        <small>独立项目台账</small>
      </div>
      <div class="kpi-card">
        <span>近 30 天</span>
        <strong>{{ recentThirtyDays }}</strong>
        <small>按实验日期统计</small>
      </div>
    </div>

    <section class="analytics-grid">
      <article class="chart-card monthly-card">
        <div class="chart-heading">
          <div>
            <h2>近 12 个月实验量</h2>
            <p>{{ monthlyProjectName }} · 按实验日期统计，区分待实验与已完成</p>
          </div>
          <div class="chart-heading-actions">
            <el-select
              v-model="monthlyProjectId"
              class="monthly-project-select"
              filterable
              placeholder="选择项目"
              aria-label="选择月度统计项目"
            >
              <el-option label="全部项目" value="" />
              <el-option
                v-for="project in appStore.projects"
                :key="project.id"
                :label="project.name"
                :value="project.id"
              />
            </el-select>
            <div class="chart-legend">
              <span><i class="legend-dot completed-dot" />已完成</span>
              <span><i class="legend-dot pending-dot" />待实验</span>
            </div>
          </div>
        </div>
        <div class="monthly-chart">
          <div
            v-for="month in monthlyStats"
            :key="month.key"
            class="month-column"
            :title="`${month.key}：共 ${month.total} 条，已完成 ${month.completed} 条，待实验 ${month.pending} 条`"
          >
            <span class="month-value">{{ month.total || "" }}</span>
            <div class="month-track">
              <div
                v-if="month.total"
                class="month-stack"
                :style="{ height: `${Math.max(6, (month.total / monthlyMax) * 100)}%` }"
              >
                <i
                  class="month-segment completed-segment"
                  :style="{ height: `${(month.completed / month.total) * 100}%` }"
                />
                <i
                  class="month-segment pending-segment"
                  :style="{ height: `${(month.pending / month.total) * 100}%` }"
                />
              </div>
            </div>
            <span class="month-label">{{ month.label }}</span>
          </div>
        </div>
      </article>

      <article class="chart-card project-volume-card">
        <div class="chart-heading">
          <div>
            <h2>项目工作量分布</h2>
            <p>横向长度代表总记录量，右侧显示上个月工作量</p>
          </div>
        </div>
        <div class="project-bars">
          <RouterLink
            v-for="project in projectChartStats"
            :key="project.id"
            class="project-bar-row"
            :to="{ path: '/ledger', query: { project: project.id } }"
          >
            <span class="project-bar-name">{{ project.name }}</span>
            <div class="project-bar-track">
              <span
                class="project-bar-total"
                :style="{ width: `${(project.total / projectMax) * 100}%` }"
              >
                <i
                  class="project-bar-completed"
                  :style="{
                    width: `${project.total ? (project.completed / project.total) * 100 : 0}%`,
                  }"
                />
                <i
                  class="project-bar-pending"
                  :style="{
                    width: `${project.total ? (project.pending / project.total) * 100 : 0}%`,
                  }"
                />
              </span>
            </div>
            <div class="project-bar-counts">
              <strong>{{ project.total }}</strong>
              <small>上月 {{ project.previousMonth }}</small>
            </div>
          </RouterLink>
        </div>
      </article>
    </section>

    <section class="page-card">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">项目概览</h2>
          <p class="page-description">统计口径与旧版保持一致</p>
        </div>
        <div class="toolbar">
          <el-button :icon="Download" @click="exportVisible = !exportVisible">
            按时间导出
          </el-button>
          <el-button @click="loadDashboard">刷新</el-button>
        </div>
      </div>
      <div v-if="exportVisible" class="stats-export-panel">
        <div class="export-row">
          <label>
            <span>开始日期</span>
            <EditableDateInput v-model="exportFilter.start" />
          </label>
          <label>
            <span>结束日期</span>
            <EditableDateInput v-model="exportFilter.end" />
          </label>
          <el-tag effect="plain">.xlsx</el-tag>
          <el-button type="primary" :icon="Download" @click="exportStatistics">
            确认导出
          </el-button>
        </div>
        <el-checkbox-group v-model="exportProjects" class="project-checkboxes">
          <el-checkbox
            v-for="project in appStore.projects"
            :key="project.id"
            :value="project.id"
            border
          >
            {{ project.name }}
          </el-checkbox>
        </el-checkbox-group>
        <p>每个项目单独一个 Excel 工作表，各自使用自己的表头。</p>
      </div>
      <div class="page-card-body">
        <div class="project-overview-grid">
          <RouterLink
            v-for="project in projectStats"
            :key="project.id"
            class="project-overview-card"
            :to="{ path: '/ledger', query: { project: project.id } }"
          >
            <div class="project-overview-title">
              <strong>{{ project.name }}</strong>
              <span>{{ project.total }} 例</span>
            </div>
            <div class="project-overview-meta">
              <span>待实验 {{ project.pending }}</span>
              <span>已完成 {{ project.completed }}</span>
            </div>
          </RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dashboard-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.kpi-card {
  display: grid;
  gap: 7px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: #fff;
  padding: 16px;
}

.kpi-card span,
.kpi-card small {
  color: var(--app-muted);
  font-size: 12px;
}

.kpi-card strong {
  font-size: 26px;
}

.analytics-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(250px, 1fr);
  gap: 12px;
}

.chart-card {
  min-width: 0;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: #fff;
  padding: 16px;
}

.chart-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.chart-heading h2,
.chart-heading p {
  margin: 0;
}

.chart-heading h2 {
  color: #182230;
  font-size: 16px;
}

.chart-heading p {
  margin-top: 5px;
  color: var(--app-muted);
  font-size: 12px;
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--app-muted);
  font-size: 12px;
}

.chart-heading-actions {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 9px;
}

.monthly-project-select {
  width: 220px;
}

.chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.completed-dot,
.completed-segment,
.project-bar-completed {
  background: #409eff;
}

.pending-dot,
.pending-segment,
.project-bar-pending {
  background: #f5a623;
}

.monthly-chart {
  display: grid;
  min-width: 620px;
  grid-template-columns: repeat(12, minmax(38px, 1fr));
  gap: 6px;
  margin-top: 16px;
}

.monthly-card {
  grid-column: 1 / -1;
  overflow-x: auto;
}

.month-column {
  display: grid;
  min-width: 0;
  grid-template-rows: 18px 175px 30px;
  align-items: end;
  justify-items: center;
  gap: 5px;
}

.month-value {
  color: #344054;
  font-size: 11px;
}

.month-track {
  display: flex;
  width: 100%;
  height: 175px;
  align-items: end;
  justify-content: center;
  border-bottom: 1px solid #d0d5dd;
  background-image: linear-gradient(to top, #f2f4f7 1px, transparent 1px);
  background-size: 100% 25%;
}

.month-stack {
  display: flex;
  width: min(30px, 72%);
  min-height: 6px;
  flex-direction: column-reverse;
  overflow: hidden;
  border-radius: 5px 5px 2px 2px;
}

.month-segment {
  display: block;
  width: 100%;
  min-height: 1px;
}

.month-label {
  color: var(--app-muted);
  font-size: 10px;
  text-align: center;
  white-space: nowrap;
}

.project-volume-card {
  grid-column: 1 / -1;
}

.project-bars {
  display: grid;
  gap: 11px;
  margin-top: 16px;
}

.project-bar-row {
  display: grid;
  grid-template-columns: minmax(90px, 150px) minmax(140px, 1fr) 84px;
  align-items: center;
  gap: 10px;
  color: inherit;
  text-decoration: none;
}

.project-bar-row:hover .project-bar-name {
  color: var(--app-primary);
}

.project-bar-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-bar-counts {
  display: grid;
  justify-items: end;
  gap: 3px;
}

.project-bar-counts strong {
  color: #344054;
  font-size: 13px;
}

.project-bar-counts small {
  color: var(--app-muted);
  font-size: 11px;
  white-space: nowrap;
}

.project-bar-track {
  height: 12px;
  overflow: hidden;
  border-radius: 999px;
  background: #edf1f5;
}

.project-bar-total {
  display: flex;
  height: 100%;
  min-width: 2px;
  overflow: hidden;
  border-radius: inherit;
}

.project-bar-total i {
  height: 100%;
}

.project-bar-row > strong {
  color: #344054;
  font-size: 12px;
  text-align: right;
}

.project-overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.project-overview-card {
  display: grid;
  gap: 9px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: inherit;
  padding: 13px;
  text-decoration: none;
}

.project-overview-card:hover {
  border-color: var(--app-primary);
  background: var(--app-primary-soft);
}

.stats-export-panel {
  display: grid;
  gap: 10px;
  border-bottom: 1px solid var(--app-border);
  background: #f8fbff;
  padding: 12px 14px;
}

.export-row,
.project-checkboxes {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
}

.export-row label {
  display: grid;
  width: 190px;
  gap: 5px;
  color: var(--app-muted);
  font-size: 12px;
}

.stats-export-panel p {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}

.project-overview-title,
.project-overview-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.project-overview-title span,
.project-overview-meta {
  color: var(--app-muted);
  font-size: 12px;
}

@media (max-width: 900px) {
  .analytics-grid {
    grid-template-columns: 1fr;
  }

  .chart-heading {
    flex-direction: column;
  }

  .chart-heading-actions {
    width: 100%;
    align-items: flex-start;
  }

  .monthly-project-select {
    width: min(100%, 320px);
  }

  .project-volume-card {
    grid-column: auto;
  }

  .project-overview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
