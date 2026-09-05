<script setup lang="ts">
import {
  ArrowUpRight,
  CalendarRange,
  ChevronDown,
  CircleAlert,
  Download,
  FileSpreadsheet,
  FlaskConical,
  Layers3,
  LoaderCircle,
  Radar,
  RefreshCw,
} from "@lucide/vue";
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
const countFormatter = new Intl.NumberFormat("zh-CN");

function formatCount(value: number): string {
  return countFormatter.format(value);
}

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
  <div class="dashboard-stage page-stack" :aria-busy="loading">
    <div v-if="errorMessage" class="dashboard-alert" role="alert">
      <CircleAlert :size="18" :stroke-width="1.8" aria-hidden="true" />
      <span>{{ errorMessage }}</span>
    </div>

    <header class="dashboard-masthead">
      <div class="masthead-copy">
        <div class="masthead-kicker">
          <Radar :size="16" :stroke-width="1.8" aria-hidden="true" />
          <span>实验运行态势</span>
        </div>
        <h1><span>数据</span><em>观测台</em></h1>
        <p>以实验日期为统一口径，观察跨项目记录、月度轨迹与工作负载。</p>
      </div>
      <div class="masthead-side">
        <div class="coverage-chip">
          <LoaderCircle
            v-if="loading"
            class="coverage-loader"
            :size="18"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <span v-else class="coverage-pulse" aria-hidden="true" />
          <div>
            <small aria-live="polite">{{ loading ? "正在同步数据" : "当前统计范围" }}</small>
            <strong>{{ formatCount(total) }} 条记录</strong>
          </div>
        </div>
        <div class="dashboard-actions">
          <el-button
            class="dashboard-button dashboard-button-ghost"
            @click="exportVisible = !exportVisible"
          >
            <Download class="button-icon" :size="16" :stroke-width="1.8" aria-hidden="true" />
            {{ exportVisible ? "收起导出" : "按时间导出" }}
          </el-button>
          <el-button
            class="dashboard-button dashboard-button-primary"
            :disabled="loading"
            @click="loadDashboard"
          >
            <RefreshCw
              class="button-icon"
              :class="{ 'is-spinning': loading }"
              :size="16"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            刷新数据
          </el-button>
        </div>
      </div>
    </header>

    <Transition name="export-panel">
      <section v-if="exportVisible" class="stats-export-panel" aria-label="按时间导出统计数据">
        <div class="export-panel-heading">
          <span class="export-heading-icon" aria-hidden="true">
            <FileSpreadsheet :size="20" :stroke-width="1.7" />
          </span>
          <div>
            <strong>导出实验记录</strong>
            <p>按实验日期筛选，每个项目生成独立的 Excel 工作表。</p>
          </div>
        </div>
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
          <el-button class="export-confirm-button" @click="exportStatistics">
            <Download :size="16" :stroke-width="1.8" aria-hidden="true" />
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
      </section>
    </Transition>

    <section class="dashboard-kpis" aria-label="核心统计指标">
      <article class="kpi-card kpi-card-primary">
        <div class="kpi-card-topline">
          <span class="kpi-icon" aria-hidden="true">
            <FlaskConical :size="21" :stroke-width="1.7" />
          </span>
          <span class="kpi-index">01</span>
        </div>
        <div class="kpi-value">{{ formatCount(total) }}</div>
        <div class="kpi-caption">
          <strong>实验总量</strong>
          <span>全部项目记录</span>
        </div>
      </article>
      <article class="kpi-card">
        <div class="kpi-card-topline">
          <span class="kpi-icon" aria-hidden="true">
            <Layers3 :size="21" :stroke-width="1.7" />
          </span>
          <span class="kpi-index">02</span>
        </div>
        <div class="kpi-value">{{ formatCount(appStore.projects.length) }}</div>
        <div class="kpi-caption">
          <strong>检测项目</strong>
          <span>独立项目台账</span>
        </div>
      </article>
      <article class="kpi-card">
        <div class="kpi-card-topline">
          <span class="kpi-icon" aria-hidden="true">
            <CalendarRange :size="21" :stroke-width="1.7" />
          </span>
          <span class="kpi-index">03</span>
        </div>
        <div class="kpi-value">{{ formatCount(recentThirtyDays) }}</div>
        <div class="kpi-caption">
          <strong>近 30 天</strong>
          <span>按实验日期统计</span>
        </div>
      </article>
    </section>

    <section class="analytics-grid">
      <article class="chart-card monthly-card">
        <div class="chart-heading">
          <div>
            <span class="section-eyebrow">月度轨迹</span>
            <h2>近 12 个月实验量</h2>
            <p>{{ monthlyProjectName }}，按实验日期统计</p>
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
              :suffix-icon="ChevronDown"
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
        <div class="monthly-chart-scroll">
          <div class="monthly-chart-shell" @mouseleave="monthlyHoverIndex = null">
            <svg
              class="monthly-line-chart"
              :viewBox="`0 0 ${monthlyChartGeometry.width} ${monthlyChartGeometry.height}`"
              preserveAspectRatio="none"
              role="img"
              aria-label="近 12 个月实验量折线图"
            >
              <defs>
                <linearGradient id="monthly-area-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop class="monthly-gradient-start" offset="0%" />
                  <stop class="monthly-gradient-end" offset="100%" />
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
              <path class="monthly-line" :d="monthlyLinePath" pathLength="1" />
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
        </div>
      </article>

      <article class="chart-card project-volume-card">
        <div class="chart-heading">
          <div>
            <span class="section-eyebrow">负载分布</span>
            <h2>项目工作量分布</h2>
            <p>总记录量与上月工作量对照</p>
          </div>
          <span class="section-count">{{ projectChartStats.length }} 项</span>
        </div>
        <div v-if="projectChartStats.length" class="project-bars">
          <RouterLink
            v-for="(project, index) in projectChartStats"
            :key="project.id"
            class="project-bar-row"
            :to="{ path: '/ledger', query: { project: project.id } }"
          >
            <div class="project-bar-heading">
              <span class="project-bar-rank">{{ String(index + 1).padStart(2, "0") }}</span>
              <span class="project-bar-name">{{ project.name }}</span>
              <strong>{{ formatCount(project.total) }}</strong>
              <ArrowUpRight :size="15" :stroke-width="1.8" aria-hidden="true" />
            </div>
            <div class="project-bar-track" aria-hidden="true">
              <span
                class="project-bar-total"
                :style="{ width: `${(project.total / projectMax) * 100}%` }"
              >
              </span>
            </div>
            <small>上月 {{ formatCount(project.previousMonth) }} 条</small>
          </RouterLink>
        </div>
        <div v-else class="dashboard-empty-state">
          <FlaskConical :size="22" :stroke-width="1.6" aria-hidden="true" />
          <span>暂无项目统计数据</span>
        </div>
      </article>
    </section>

    <section class="overview-panel">
      <div class="overview-panel-header">
        <div>
          <span class="section-eyebrow">项目索引</span>
          <h2>进入项目台账</h2>
          <p>查看各项目记录，继续录入与管理。</p>
        </div>
        <span class="overview-total">{{ appStore.projects.length }} 个项目</span>
      </div>
      <div class="project-overview-grid">
        <RouterLink
          v-for="project in projectStats"
          :key="project.id"
          class="project-overview-card"
          :to="{ path: '/ledger', query: { project: project.id } }"
        >
          <span class="project-overview-line" aria-hidden="true" />
          <div class="project-overview-title">
            <span>{{ project.name }}</span>
            <ArrowUpRight :size="17" :stroke-width="1.7" aria-hidden="true" />
          </div>
          <div class="project-overview-metric">
            <strong>{{ formatCount(project.total) }}</strong>
            <span>例记录</span>
          </div>
        </RouterLink>
        <div v-if="!projectStats.length" class="dashboard-empty-state dashboard-empty-overview">
          <Layers3 :size="22" :stroke-width="1.6" aria-hidden="true" />
          <span>暂无可查看的项目</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dashboard-stage {
  --dashboard-ink: #243746;
  --dashboard-ink-soft: #526775;
  --dashboard-paper: #f7fafc;
  --dashboard-line: #e3ecef;
  --dashboard-accent: #167d73;
  --dashboard-aqua: #238b80;
  --dashboard-blue: #3e8cb5;
  position: relative;
  isolation: isolate;
  min-height: calc(100vh - 60px);
  margin: -12px -12px -20px;
  padding: clamp(18px, 2.5vw, 34px);
  overflow: hidden;
  background:
    radial-gradient(circle at 92% 4%, #eaf7f2, transparent 25rem),
    var(--dashboard-paper);
  color: var(--dashboard-ink);
  gap: clamp(14px, 1.7vw, 22px);
}

.dashboard-stage::before {
  content: none;
}

.dashboard-stage::after {
  content: none;
}

.dashboard-alert {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid rgba(217, 45, 32, 0.2);
  border-radius: 14px;
  background: rgba(255, 245, 244, 0.92);
  color: #b42318;
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 12px 30px rgba(180, 35, 24, 0.08);
}

.dashboard-masthead {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.6fr);
  min-height: 148px;
  overflow: hidden;
  border: 1px solid var(--dashboard-line);
  border-radius: 26px;
  background:
    radial-gradient(circle at 96% 0%, #edf6fd, transparent 36%),
    radial-gradient(circle at 70% 100%, #eaf7f2, transparent 32%),
    #fff;
  box-shadow: 0 6px 24px rgba(36, 55, 70, 0.04);
  animation: dashboard-rise 700ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.dashboard-masthead::before {
  content: none;
}

.masthead-copy,
.masthead-side {
  position: relative;
  z-index: 1;
}

.masthead-copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: clamp(22px, 2.5vw, 30px);
}

.masthead-kicker,
.section-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #6f7c93;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.masthead-kicker {
  color: var(--dashboard-aqua);
}

.masthead-copy h1 {
  margin: 12px 0 10px;
  color: var(--dashboard-ink);
  font-size: clamp(28px, 3vw, 40px);
  font-weight: 760;
  letter-spacing: -0.065em;
  line-height: 1.2;
}

.masthead-copy h1 span,
.masthead-copy h1 em {
  display: inline-block;
}

.masthead-copy h1 em {
  margin-left: 0.14em;
  color: var(--dashboard-accent);
  font-style: normal;
  font-weight: 420;
}

.masthead-copy p {
  max-width: 610px;
  margin: 0;
  color: var(--dashboard-ink-soft);
  font-size: 14px;
  line-height: 1.7;
}

.masthead-side {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 24px;
  border-left: 1px solid var(--dashboard-line);
  padding: clamp(20px, 2vw, 28px);
}

.coverage-chip {
  display: flex;
  align-items: center;
  gap: 12px;
  align-self: flex-end;
  min-width: 190px;
  border: 1px solid #e3ecef;
  border-radius: 16px;
  background: #f5faf8;
  padding: 12px 14px;
}

.coverage-pulse {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--dashboard-accent);
  box-shadow: 0 0 0 5px #eaf7f2;

}

.coverage-loader {
  flex: 0 0 auto;
  color: var(--dashboard-aqua);
  animation: dashboard-spin 900ms linear infinite;
}

.coverage-chip div {
  display: grid;
  gap: 2px;
}

.coverage-chip small {
  color: var(--dashboard-ink-soft);
  font-size: 12px;
}

.coverage-chip strong {
  color: var(--dashboard-ink);
  font-size: 14px;
  font-weight: 650;
}

.dashboard-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dashboard-button {
  min-height: 38px;
  border-radius: 999px;
  padding-inline: 16px;
  font-weight: 650;
  transition:
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms ease,
    background 180ms ease;
}

.dashboard-button:hover {
  transform: translateY(-2px);
}

.dashboard-button-ghost {
  border-color: #bccfca;
  background: #fff;
  color: var(--dashboard-ink);
}

.dashboard-button-ghost:hover,
.dashboard-button-ghost:focus-visible {
  border-color: var(--dashboard-accent);
  background: #eaf7f2;
  color: var(--dashboard-accent);
}

.dashboard-button-primary {
  border-color: var(--dashboard-accent);
  background: var(--dashboard-accent);
  color: #fff;
}

.dashboard-button-primary:hover,
.dashboard-button-primary:focus-visible {
  border-color: #11695f;
  background: #11695f;
  color: #fff;
}

.button-icon,
.export-confirm-button svg {
  flex: 0 0 auto;
}

.button-icon.is-spinning {
  animation: dashboard-spin 900ms linear infinite;
}

.stats-export-panel {
  display: grid;
  grid-template-columns: minmax(220px, 0.7fr) minmax(0, 1.3fr);
  gap: 18px 26px;
  align-items: center;
  border: 1px solid rgba(11, 16, 32, 0.1);
  border-radius: 20px;
  background: #fff;
  padding: 18px;
  box-shadow: 0 6px 22px rgba(36, 55, 70, 0.05);
}

.export-panel-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  grid-row: 1 / 3;
}

.export-heading-icon {
  display: inline-grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 14px;
  background: #eaf7f2;
  color: var(--dashboard-accent);
}

.export-panel-heading div {
  display: grid;
  gap: 4px;
}

.export-panel-heading strong {
  font-size: 15px;
}

.export-panel-heading p,
.overview-panel-header p {
  margin: 0;
  color: #667085;
  font-size: 12px;
  line-height: 1.55;
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
  width: min(190px, 100%);
  gap: 6px;
  color: #596579;
  font-size: 12px;
  font-weight: 650;
}

.export-confirm-button {
  border-color: var(--dashboard-accent);
  border-radius: 10px;
  background: var(--dashboard-accent);
  color: #fff;
}

.export-confirm-button:hover,
.export-confirm-button:focus-visible {
  border-color: #11695f;
  background: #11695f;
  color: #fff;
}

.export-panel-enter-active,
.export-panel-leave-active {
  overflow: hidden;
  transition:
    opacity 240ms ease,
    transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
    max-height 320ms ease;
}

.export-panel-enter-from,
.export-panel-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-10px);
}

.export-panel-enter-to,
.export-panel-leave-from {
  max-height: 260px;
}

.dashboard-kpis {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.kpi-card {
  position: relative;
  display: grid;
  min-height: 160px;
  overflow: hidden;
  border: 1px solid var(--dashboard-line);
  border-radius: 22px;
  background: #fff;
  padding: 18px;
  box-shadow: 0 6px 22px rgba(36, 55, 70, 0.05);
  transition:
    transform 360ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 360ms ease,
    border-color 260ms ease;
  animation: dashboard-rise 650ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.kpi-card:nth-child(2) {
  animation-delay: 70ms;
}

.kpi-card:nth-child(3) {
  animation-delay: 140ms;
}

.kpi-card::after {
  content: none;
}

.kpi-card:hover {
  border-color: rgba(11, 16, 32, 0.2);
  box-shadow: 0 6px 22px rgba(36, 55, 70, 0.05);
  transform: translateY(-2px);
}

.kpi-card:hover::after {
  transform: scale(1.2) translate(-5px, -5px);
}

.kpi-card-primary {
  background: linear-gradient(115deg, #fff 55%, #f0faf5);
  color: var(--dashboard-ink);
}

.kpi-card-primary::after {
  content: none;
}

.kpi-card-topline {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.kpi-icon {
  display: inline-grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 13px;
  background: #edf2f6;
  color: var(--dashboard-ink);
}

.kpi-card-primary .kpi-icon {
  background: #eaf7f2;
  color: var(--dashboard-accent);
}

.kpi-index {
  color: #627985;
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 12px;
  letter-spacing: 0.12em;
}

.kpi-card-primary .kpi-index {
  color: var(--dashboard-ink-soft);
}

.kpi-value {
  align-self: end;
  font-size: clamp(34px, 4vw, 50px);
  font-weight: 680;
  letter-spacing: -0.06em;
  line-height: 0.9;
}

.kpi-caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
}

.kpi-caption strong {
  font-size: 14px;
}

.kpi-caption span {
  color: #526775;
  font-size: 12px;
}

.kpi-card-primary .kpi-caption span {
  color: var(--dashboard-ink-soft);
}

.analytics-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(300px, 0.7fr);
  gap: 12px;
  align-items: stretch;
}

.chart-card,
.overview-panel {
  min-width: 0;
  border: 1px solid var(--dashboard-line);
  border-radius: 24px;
  background: #fff;
  box-shadow: 0 6px 22px rgba(36, 55, 70, 0.05);
  animation: dashboard-rise 720ms 110ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.chart-card {
  padding: clamp(18px, 2vw, 26px);
}

.chart-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.chart-heading h2,
.chart-heading p,
.overview-panel-header h2 {
  margin: 0;
}

.chart-heading h2,
.overview-panel-header h2 {
  margin-top: 7px;
  color: var(--dashboard-ink);
  font-size: 20px;
  font-weight: 670;
  letter-spacing: -0.035em;
}

.chart-heading p {
  margin-top: 6px;
  color: #526775;
  font-size: 12px;
}

.chart-heading-actions {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.monthly-card {
  overflow: hidden;
  border-color: var(--dashboard-line);
  background: linear-gradient(180deg, #fff 70%, #f8fcfb);
  color: var(--dashboard-ink);
}

.monthly-card .section-eyebrow {
  color: var(--dashboard-aqua);
}

.monthly-card .chart-heading h2 {
  color: var(--dashboard-ink);
}

.monthly-card .chart-heading p {
  color: var(--dashboard-ink-soft);
}

.monthly-chart-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  color: var(--dashboard-ink-soft);
  font-size: 12px;
}

.monthly-chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.monthly-legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dashboard-aqua);
  box-shadow: 0 0 0 5px rgba(126, 231, 218, 0.1);
}

.monthly-project-select {
  width: 220px;
}

.monthly-project-select :deep(.el-select__wrapper) {
  min-height: 38px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 0 0 1px #b8cbc8 inset;
}

.monthly-project-select :deep(.el-select__wrapper:hover),
.monthly-project-select :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px rgba(126, 231, 218, 0.48) inset;
}

.monthly-project-select :deep(.el-select__selected-item),
.monthly-project-select :deep(.el-select__placeholder),
.monthly-project-select :deep(.el-select__caret) {
  color: var(--dashboard-ink);
}

.monthly-chart-scroll {
  margin: 20px -4px -4px;
  overflow-x: auto;
  scrollbar-color: rgba(126, 231, 218, 0.28) transparent;
  scrollbar-width: thin;
}

.monthly-chart-shell {
  position: relative;
  min-width: 620px;
  height: 250px;
  overflow: hidden;
}

.monthly-line-chart {
  display: block;
  width: 100%;
  height: 250px;
  overflow: visible;
}

.monthly-gradient-start {
  stop-color: var(--dashboard-aqua);
  stop-opacity: 0.16;
}

.monthly-gradient-end {
  stop-color: var(--dashboard-blue);
  stop-opacity: 0.015;
}

.monthly-grid-lines line {
  stroke: #e3ecef;
  stroke-dasharray: 3 7;
  stroke-width: 1;
}

.monthly-grid-lines line:last-of-type {
  stroke: #b9cbcf;
  stroke-dasharray: none;
}

.monthly-area {
  fill: url("#monthly-area-gradient");
}

.monthly-line {
  fill: none;
  stroke: var(--dashboard-aqua);
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.5;
  animation: monthly-trace 900ms 160ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

.monthly-focus-line {
  stroke: var(--dashboard-accent);
  stroke-dasharray: 4 5;
  stroke-width: 1;
}

.monthly-point-hit {
  fill: transparent;
  cursor: crosshair;
  outline: none;
}

.monthly-point-hit:focus-visible {
  stroke: var(--dashboard-accent);
  stroke-dasharray: 3 3;
  stroke-width: 1.5;
}

.monthly-point {
  fill: #fff;
  stroke: var(--dashboard-aqua);
  stroke-width: 2;
  pointer-events: none;
  transition: r 180ms cubic-bezier(0.22, 1, 0.36, 1), fill 180ms ease;
}

.monthly-point-active {
  fill: var(--dashboard-accent);
  stroke: var(--dashboard-accent);
}

.monthly-axis-label,
.monthly-y-label {
  fill: #526775;
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 12px;
}

.monthly-tooltip {
  position: absolute;
  top: 8px;
  z-index: 2;
  width: 220px;
  padding: 13px 14px;
  border: 1px solid #c8d9d5;
  border-radius: 13px;
  background: #fff;
  box-shadow: 0 8px 26px rgba(36, 55, 70, 0.12);
  color: var(--dashboard-ink);
  pointer-events: none;
  transition: left 150ms ease, top 150ms ease;
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
  color: var(--dashboard-ink);
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
  color: var(--dashboard-ink-soft);
  font-size: 12px;
}

.monthly-tooltip-row b {
  color: var(--dashboard-ink);
  font-size: 13px;
}

.monthly-tooltip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dashboard-blue);
}

.monthly-tooltip-total {
  background: var(--dashboard-accent);
}

.monthly-tooltip-empty {
  display: block;
  margin-top: 8px;
  color: var(--dashboard-ink-soft);
  font-size: 12px;
}

.project-volume-card {
  display: flex;
  flex-direction: column;
}

.section-count,
.overview-total {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  border: 1px solid rgba(11, 16, 32, 0.1);
  border-radius: 999px;
  background: #f3f5f8;
  color: #566176;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
}

.project-bars {
  display: grid;
  gap: 9px;
  margin-top: 18px;
}

.project-bar-row {
  display: grid;
  gap: 9px;
  border: 1px solid transparent;
  border-radius: 14px;
  color: inherit;
  padding: 11px;
  text-decoration: none;
  transition:
    border-color 180ms ease,
    background 180ms ease,
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.project-bar-row:hover,
.project-bar-row:focus-visible {
  border-color: rgba(11, 16, 32, 0.1);
  background: rgba(238, 242, 247, 0.82);
  outline: none;
  transform: translateX(2px);
}

.project-bar-heading {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 8px;
}

.project-bar-rank {
  color: #627985;
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 12px;
}

.project-bar-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-bar-heading strong {
  font-size: 14px;
  letter-spacing: -0.025em;
}

.project-bar-heading svg {
  color: #627985;
  transition: color 180ms ease, transform 180ms ease;
}

.project-bar-row:hover .project-bar-heading svg,
.project-bar-row:focus-visible .project-bar-heading svg {
  color: var(--dashboard-ink);
  transform: translate(2px, -2px);
}

.project-bar-track {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: #e9edf2;
}

.project-bar-total {
  display: block;
  height: 100%;
  min-width: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--dashboard-blue), var(--dashboard-aqua));
  transform: scaleX(1);
  transform-origin: left;
  animation: project-bar-reveal 650ms 160ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

.project-bar-row small {
  color: #526775;
  font-size: 12px;
  text-align: right;
}

.overview-panel {
  overflow: hidden;
  padding: clamp(18px, 2vw, 26px);
}

.overview-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--dashboard-line);
}

.overview-panel-header h2 {
  margin-bottom: 6px;
}

.project-overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding-top: 14px;
}

.project-overview-card {
  position: relative;
  display: grid;
  min-height: 120px;
  overflow: hidden;
  border: 1px solid var(--dashboard-line);
  border-radius: 17px;
  background: #fafbfc;
  color: inherit;
  padding: 15px;
  text-decoration: none;
  transition:
    border-color 220ms ease,
    background 220ms ease,
    transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 320ms ease;
}

.project-overview-card:hover,
.project-overview-card:focus-visible {
  border-color: rgba(11, 16, 32, 0.24);
  background: #fff;
  box-shadow: 0 6px 22px rgba(36, 55, 70, 0.05);
  outline: none;
  transform: translateY(-2px);
}

.project-overview-line {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--dashboard-blue), var(--dashboard-aqua), var(--dashboard-accent));
  transform: scaleX(0.28);
  transform-origin: left;
  transition: transform 460ms cubic-bezier(0.22, 1, 0.36, 1);
}

.project-overview-card:hover .project-overview-line,
.project-overview-card:focus-visible .project-overview-line {
  transform: scaleX(1);
}

.project-overview-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.project-overview-title span {
  overflow: hidden;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-overview-title svg {
  flex: 0 0 auto;
  color: #627985;
}

.project-overview-metric {
  display: flex;
  align-items: baseline;
  gap: 6px;
  align-self: end;
}

.project-overview-metric strong {
  font-size: 30px;
  font-weight: 650;
  letter-spacing: -0.055em;
}

.project-overview-metric span {
  color: #526775;
  font-size: 12px;
}

.dashboard-empty-state {
  display: flex;
  min-height: 150px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: #526775;
  font-size: 13px;
}

.dashboard-empty-overview {
  grid-column: 1 / -1;
}

:deep(.stats-export-panel .el-input__wrapper) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px rgba(11, 16, 32, 0.11) inset;
}

:deep(.stats-export-panel .el-checkbox.is-bordered) {
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.66);
}

@keyframes dashboard-rise {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.99);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes monthly-trace {
  from { stroke-dashoffset: 1; }
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes project-bar-reveal {
  from { transform: scaleX(0); }
  to {
    transform: scaleX(1);
  }
}

@keyframes coverage-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(185, 247, 101, 0.32);
  }

  70%,
  100% {
    box-shadow: 0 0 0 10px rgba(185, 247, 101, 0);
  }
}

@keyframes dashboard-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1180px) {
  .analytics-grid {
    grid-template-columns: 1fr;
  }

  .project-bars {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .dashboard-masthead {
    grid-template-columns: 1fr;
  }

  .masthead-side {
    flex-direction: row;
    align-items: center;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    border-left: 0;
  }

  .coverage-chip {
    align-self: auto;
  }

  .dashboard-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .kpi-card-primary {
    grid-column: 1 / -1;
  }

  .stats-export-panel {
    grid-template-columns: 1fr;
  }

  .export-panel-heading {
    grid-row: auto;
  }

  .project-overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .dashboard-stage {
    padding: 14px;
  }

  .masthead-copy,
  .masthead-side {
    padding: 20px;
  }

  .masthead-copy h1 {
    font-size: clamp(34px, 12vw, 48px);
  }

  .masthead-side,
  .dashboard-actions,
  .chart-heading,
  .overview-panel-header {
    flex-direction: column;
    align-items: stretch;
  }

  .coverage-chip {
    width: 100%;
  }

  .dashboard-actions .el-button {
    width: 100%;
    margin-left: 0;
  }

  .dashboard-kpis,
  .project-bars,
  .project-overview-grid {
    grid-template-columns: 1fr;
  }

  .kpi-card-primary {
    grid-column: auto;
  }

  .chart-heading-actions {
    width: 100%;
    align-items: flex-start;
  }

  .monthly-project-select,
  .export-row label {
    width: 100%;
  }

  .monthly-chart-shell {
    min-width: 620px;
  }

  .overview-total {
    align-self: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dashboard-masthead,
  .kpi-card,
  .chart-card,
  .overview-panel,
  .monthly-line,
  .project-bar-total,
  .coverage-pulse,
  .coverage-loader,
  .button-icon.is-spinning {
    animation: none;
  }

  .dashboard-button,
  .kpi-card,
  .project-bar-row,
  .project-overview-card,
  .project-overview-line {
    transition-duration: 0.01ms;
  }
}
</style>
