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
const monthlyHoverIndex = ref<number | null>(null);
const exportFilter = reactive({
  start: "",
  end: "",
});

const total = computed(() => records.value.length);
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
    };
  });
});
const monthlyMax = computed(() =>
  Math.max(1, ...monthlyStats.value.map((month) => month.total)),
);
const monthlyChartGeometry = {
  width: 960,
  height: 230,
  left: 48,
  right: 24,
  top: 14,
  bottom: 32,
};
type ChartPoint = { x: number; y: number };

function smoothLineCommands(points: ChartPoint[]): string[] {
  if (!points.length) return [];
  const commands = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const afterNext = points[index + 2] ?? next;
    const controlOne = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6,
    };
    const controlTwo = {
      x: next.x - (afterNext.x - current.x) / 6,
      y: next.y - (afterNext.y - current.y) / 6,
    };
    commands.push(
      `C ${controlOne.x} ${controlOne.y}, ${controlTwo.x} ${controlTwo.y}, ${next.x} ${next.y}`,
    );
  }
  return commands;
}

function smoothLinePath(points: ChartPoint[]): string {
  return smoothLineCommands(points).join(" ");
}

const monthlyPoints = computed(() => {
  const plotWidth =
    monthlyChartGeometry.width - monthlyChartGeometry.left - monthlyChartGeometry.right;
  const plotHeight =
    monthlyChartGeometry.height - monthlyChartGeometry.top - monthlyChartGeometry.bottom;
  const step = plotWidth / Math.max(1, monthlyStats.value.length - 1);
  return monthlyStats.value.map((month, index) => ({
    ...month,
    x: monthlyChartGeometry.left + step * index,
    y:
      monthlyChartGeometry.top +
      plotHeight -
      (month.total / monthlyMax.value) * plotHeight,
  }));
});
const monthlyLinePath = computed(() =>
  smoothLinePath(monthlyPoints.value.map(({ x, y }) => ({ x, y }))),
);
const monthlyAreaPath = computed(() => {
  const points = monthlyPoints.value;
  if (!points.length) return "";
  const baseline = monthlyChartGeometry.height - monthlyChartGeometry.bottom;
  const lineCommands = smoothLineCommands(points.map(({ x, y }) => ({ x, y })));
  return [
    `M ${points[0]!.x} ${baseline}`,
    `L ${points[0]!.x} ${points[0]!.y}`,
    ...lineCommands.slice(1),
    `L ${points.at(-1)!.x} ${baseline}`,
    "Z",
  ].join(" ");
});
const monthlyGridLines = computed(() => {
  const plotHeight =
    monthlyChartGeometry.height - monthlyChartGeometry.top - monthlyChartGeometry.bottom;
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    y: monthlyChartGeometry.top + plotHeight * fraction,
    value: Math.round(monthlyMax.value * (1 - fraction)),
  }));
});
const hoveredMonth = computed(() => {
  const index = monthlyHoverIndex.value;
  return index === null ? null : monthlyPoints.value[index] ?? null;
});
const hoveredMonthProjects = computed(() => {
  if (!hoveredMonth.value) return [];
  return appStore.projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      count: records.value.filter(
        (record) =>
          (!monthlyProjectId.value || record.project_id === monthlyProjectId.value) &&
          record.project_id === project.id &&
          (record.experiment_date ?? "").startsWith(hoveredMonth.value!.key),
      ).length,
    }))
    .filter((project) => project.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
});
const monthlyTooltipClass = computed(() => {
  const index = monthlyHoverIndex.value;
  if (index === 0) return "monthly-tooltip-left";
  if (index === monthlyPoints.value.length - 1) return "monthly-tooltip-right";
  return "monthly-tooltip-center";
});
const monthlyTooltipStyle = computed(() => {
  const point = hoveredMonth.value;
  if (!point) return {};
  const maxTop = Math.max(8, monthlyChartGeometry.height - 182);
  const top = Math.min(maxTop, Math.max(8, point.y - 108));
  return {
    left: `${(point.x / monthlyChartGeometry.width) * 100}%`,
    top: `${top}px`,
  };
});

function setMonthlyHover(index: number): void {
  monthlyHoverIndex.value = index;
}

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
  if (field.system_key === "block_number") return record.block_number ?? "";
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
        <span>实验总量</span>
        <strong>{{ total }}</strong>
        <small>全部项目记录</small>
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
            <p>{{ monthlyProjectName }} · 按实验日期统计</p>
          </div>
          <div class="chart-heading-actions">
            <div class="monthly-chart-legend" aria-label="图表图例">
              <span><i class="monthly-legend-dot" />实验总量</span>
            </div>
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
          </div>
        </div>
        <div class="monthly-chart-shell" @mouseleave="monthlyHoverIndex = null">
          <svg
            class="monthly-line-chart"
            :viewBox="`0 0 ${monthlyChartGeometry.width} ${monthlyChartGeometry.height}`"
            preserveAspectRatio="none"
            aria-label="近 12 个月实验量折线图"
          >
            <defs>
              <linearGradient id="monthly-area-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#409eff" stop-opacity="0.22" />
                <stop offset="100%" stop-color="#409eff" stop-opacity="0.03" />
              </linearGradient>
            </defs>
            <g class="monthly-grid-lines">
              <line
                v-for="line in monthlyGridLines"
                :key="line.y"
                :x1="monthlyChartGeometry.left"
                :x2="monthlyChartGeometry.width - monthlyChartGeometry.right"
                :y1="line.y"
                :y2="line.y"
              />
              <text
                v-for="line in monthlyGridLines"
                :key="`label-${line.y}`"
                class="monthly-y-label"
                :x="monthlyChartGeometry.left - 10"
                :y="line.y + 4"
                text-anchor="end"
              >{{ line.value }}</text>
            </g>
            <path class="monthly-area" :d="monthlyAreaPath" />
            <path class="monthly-line" :d="monthlyLinePath" />
            <line
              v-if="hoveredMonth"
              class="monthly-focus-line"
              :x1="hoveredMonth.x"
              :x2="hoveredMonth.x"
              :y1="monthlyChartGeometry.top"
              :y2="monthlyChartGeometry.height - monthlyChartGeometry.bottom"
            />
            <g v-for="(point, index) in monthlyPoints" :key="point.key">
              <circle
                class="monthly-point-hit"
                :cx="point.x"
                :cy="point.y"
                r="16"
                tabindex="0"
                :aria-label="`${point.label}：${point.total} 条实验记录`"
                @mouseenter="setMonthlyHover(index)"
                @focus="setMonthlyHover(index)"
                @blur="monthlyHoverIndex = null"
              />
              <circle
                class="monthly-point"
                :class="{ 'monthly-point-active': monthlyHoverIndex === index }"
                :cx="point.x"
                :cy="point.y"
                :r="monthlyHoverIndex === index ? 5 : 3.5"
              />
              <text
                class="monthly-axis-label"
                :x="point.x"
                :y="monthlyChartGeometry.height - 9"
                text-anchor="middle"
              >{{ point.label }}</text>
            </g>
          </svg>
          <div
            v-if="hoveredMonth"
            class="monthly-tooltip"
            :class="monthlyTooltipClass"
            :style="monthlyTooltipStyle"
          >
            <strong>{{ hoveredMonth.label }}</strong>
            <div class="monthly-tooltip-row">
              <i class="monthly-tooltip-dot monthly-tooltip-total" />
              <span>实验总量</span>
              <b>{{ hoveredMonth.total }}</b>
            </div>
            <div class="monthly-tooltip-list">
              <div
                v-for="project in hoveredMonthProjects"
                :key="project.id"
                class="monthly-tooltip-row"
              >
                <i class="monthly-tooltip-dot" />
                <span>{{ project.name }}</span>
                <b>{{ project.count }}</b>
              </div>
              <span v-if="!hoveredMonthProjects.length" class="monthly-tooltip-empty">
                暂无项目记录
              </span>
            </div>
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

.chart-heading-actions {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 9px;
}

.monthly-chart-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  color: var(--app-muted);
  font-size: 12px;
}

.monthly-chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.monthly-legend-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #409eff;
  box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.14);
}

.monthly-project-select {
  width: 220px;
}

.monthly-card {
  grid-column: 1 / -1;
}

.monthly-chart-shell {
  position: relative;
  min-width: 620px;
  height: 230px;
  margin-top: 16px;
  overflow: hidden;
}

.monthly-line-chart {
  display: block;
  width: 100%;
  height: 230px;
  overflow: visible;
}

.monthly-grid-lines line {
  stroke: #f0f2f5;
  stroke-dasharray: 4 4;
  stroke-width: 1;
}

.monthly-grid-lines line:last-of-type {
  stroke: #d0d5dd;
  stroke-dasharray: none;
}

.monthly-area {
  fill: url("#monthly-area-gradient");
}

.monthly-line {
  fill: none;
  stroke: #409eff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.5;
}

.monthly-focus-line {
  stroke: #98a2b3;
  stroke-dasharray: 5 4;
  stroke-width: 1;
}

.monthly-point-hit {
  fill: transparent;
  cursor: crosshair;
  outline: none;
}

.monthly-point-hit:focus-visible {
  stroke: #409eff;
  stroke-dasharray: 3 3;
  stroke-width: 1;
}

.monthly-point {
  fill: #fff;
  stroke: #409eff;
  stroke-width: 2;
  pointer-events: none;
  transition: r 0.12s ease;
}

.monthly-point-active {
  fill: #409eff;
}

.monthly-axis-label {
  fill: var(--app-muted);
  font-size: 11px;
}

.monthly-y-label {
  fill: var(--app-muted);
  font-size: 11px;
}

.monthly-tooltip {
  position: absolute;
  top: 8px;
  z-index: 2;
  width: 220px;
  padding: 12px 14px;
  border: 1px solid #e4e7ec;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.16);
  pointer-events: none;
  transition: left 0.15s ease, top 0.15s ease;
}

.monthly-tooltip-left {
  transform: translateX(0);
}

.monthly-tooltip-center {
  transform: translateX(-50%);
}

.monthly-tooltip-right {
  transform: translateX(-100%);
}

.monthly-tooltip > strong {
  display: block;
  margin-bottom: 9px;
  color: #344054;
  font-size: 14px;
}

.monthly-tooltip-list {
  max-height: 110px;
  margin-top: 6px;
  overflow-y: auto;
}

.monthly-tooltip-row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
  color: #667085;
  font-size: 12px;
}

.monthly-tooltip-row b {
  color: #344054;
  font-size: 13px;
}

.monthly-tooltip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8b7cff;
}

.monthly-tooltip-total {
  background: #409eff;
}

.monthly-tooltip-empty {
  display: block;
  margin-top: 8px;
  color: var(--app-muted);
  font-size: 12px;
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
  background: #409eff;
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

.project-overview-title {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.project-overview-title span {
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
