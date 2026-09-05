<script setup lang="ts">
import {
  ArrowUpRight,
  CalendarRange,
  ChevronDown,
  CircleAlert,
  FlaskConical,
  Layers3,
  Radar,
} from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";

import { listRecords } from "@/api/records";
import { useAppStore } from "@/stores/app";
import type { ProjectRecord } from "@/types/api";
import { shanghaiDateKey, shiftDateKey, shiftMonthKey } from "@/utils/datetime";

const appStore = useAppStore();
const records = ref<ProjectRecord[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const monthlyProjectId = ref("");
const monthlyHoverIndex = ref<number | null>(null);
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
    </header>

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
  --dashboard-ink: var(--app-text);
  --dashboard-ink-soft: var(--app-muted);
  --dashboard-paper: var(--app-bg);
  --dashboard-line: var(--app-border);
  --dashboard-accent: var(--app-primary-text);
  --dashboard-aqua: var(--app-chart-primary);
  --dashboard-blue: var(--app-chart-secondary);
  position: relative;
  isolation: isolate;
  min-height: calc(100vh - 60px);
  margin: -12px -12px -20px;
  padding: clamp(18px, 2.5vw, 34px);
  overflow: hidden;
  background:
    radial-gradient(circle at 92% 4%, var(--app-primary-soft), transparent 25rem),
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
  border: 1px solid rgba(198, 87, 70, 0.2);
  border-radius: 14px;
  background: var(--app-danger-soft);
  color: var(--app-danger);
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 12px 30px rgba(180, 35, 24, 0.08);
}

.dashboard-masthead {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 148px;
  overflow: hidden;
  border: 1px solid var(--dashboard-line);
  border-radius: 26px;
  background:
    radial-gradient(circle at 96% 0%, var(--app-accent-soft), transparent 36%),
    radial-gradient(circle at 70% 100%, var(--app-primary-soft), transparent 32%),
    var(--app-bg);
  box-shadow: 0 6px 24px rgba(45, 42, 38, 0.04);
  animation: dashboard-rise 700ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.dashboard-masthead::before {
  content: none;
}

.masthead-copy {
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
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.masthead-kicker {
  color: var(--dashboard-accent);
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

.overview-panel-header p {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.55;
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
  background: var(--app-card);
  padding: 18px;
  box-shadow: 0 6px 22px rgba(45, 42, 38, 0.05);
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
  box-shadow: 0 6px 22px rgba(45, 42, 38, 0.05);
  transform: translateY(-2px);
}

.kpi-card:hover::after {
  transform: scale(1.2) translate(-5px, -5px);
}

.kpi-card-primary {
  background: linear-gradient(115deg, var(--app-bg) 55%, var(--app-hover));
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
  background: var(--app-surface-soft);
  color: var(--dashboard-ink);
}

.kpi-card-primary .kpi-icon {
  background: var(--app-primary-soft);
  color: var(--dashboard-accent);
}

.kpi-index {
  color: var(--app-muted);
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
  color: var(--app-muted);
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
  background: var(--app-card);
  box-shadow: 0 6px 22px rgba(45, 42, 38, 0.05);
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
  color: var(--app-muted);
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
  background: linear-gradient(180deg, var(--app-bg) 70%, var(--app-surface-soft));
  color: var(--dashboard-ink);
}

.monthly-card .section-eyebrow {
  color: var(--dashboard-accent);
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
  box-shadow: 0 0 0 5px rgb(var(--app-primary-rgb) / 0.1);
}

.monthly-project-select {
  width: 220px;
}

.monthly-project-select :deep(.el-select__wrapper) {
  min-height: 38px;
  border-radius: 12px;
  background: var(--app-bg);
  box-shadow: 0 0 0 1px var(--app-border-strong) inset;
}

.monthly-project-select :deep(.el-select__wrapper:hover),
.monthly-project-select :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px rgb(var(--app-primary-rgb) / 0.48) inset;
}

.monthly-project-select :deep(.el-select__selected-item),
.monthly-project-select :deep(.el-select__placeholder),
.monthly-project-select :deep(.el-select__caret) {
  color: var(--dashboard-ink);
}

.monthly-chart-scroll {
  margin: 20px -4px -4px;
  overflow-x: auto;
  scrollbar-color: rgb(var(--app-primary-rgb) / 0.28) transparent;
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
  stop-color: var(--dashboard-accent);
  stop-opacity: 0.16;
}

.monthly-gradient-end {
  stop-color: var(--dashboard-blue);
  stop-opacity: 0.015;
}

.monthly-grid-lines line {
  stroke: var(--app-border);
  stroke-dasharray: 3 7;
  stroke-width: 1;
}

.monthly-grid-lines line:last-of-type {
  stroke: var(--app-border-strong);
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
  fill: var(--app-bg);
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
  fill: var(--app-muted);
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 12px;
}

.monthly-tooltip {
  position: absolute;
  top: 8px;
  z-index: 2;
  width: 220px;
  padding: 13px 14px;
  border: 1px solid var(--app-border-strong);
  border-radius: 13px;
  background: var(--app-bg);
  box-shadow: 0 8px 26px rgba(45, 42, 38, 0.12);
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
  background: var(--app-surface-soft);
  color: var(--app-muted);
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
  background: var(--app-hover);
  outline: none;
  transform: translateX(2px);
}


.project-bar-row:nth-child(5n + 2) { --project-color: var(--app-chart-secondary); }
.project-bar-row:nth-child(5n + 3) { --project-color: var(--app-chart-third); }
.project-bar-row:nth-child(5n + 4) { --project-color: var(--app-chart-fourth); }
.project-bar-row:nth-child(5n + 5) { --project-color: var(--app-chart-fifth); }

.project-bar-heading {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 8px;
}

.project-bar-rank {
  color: var(--app-muted);
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
  color: var(--app-muted);
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
  background: var(--app-surface-soft);
}

.project-bar-total {
  display: block;
  height: 100%;
  min-width: 0;
  border-radius: inherit;
  background: var(--project-color, var(--app-chart-primary));
  transform: scaleX(1);
  transform-origin: left;
  animation: project-bar-reveal 650ms 160ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

.project-bar-row small {
  color: var(--app-muted);
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
  background: var(--app-surface-soft);
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
  background: var(--app-bg);
  box-shadow: 0 6px 22px rgba(45, 42, 38, 0.05);
  outline: none;
  transform: translateY(-2px);
}

.project-overview-line {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 3px;
  background: var(--dashboard-accent);
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
  color: var(--app-muted);
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
  color: var(--app-muted);
  font-size: 12px;
}

.dashboard-empty-state {
  display: flex;
  min-height: 150px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: var(--app-muted);
  font-size: 13px;
}

.dashboard-empty-overview {
  grid-column: 1 / -1;
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

@media (max-width: 1180px) {
  .analytics-grid {
    grid-template-columns: 1fr;
  }

  .project-bars {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .dashboard-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .kpi-card-primary {
    grid-column: 1 / -1;
  }

  .project-overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .dashboard-stage {
    padding: 14px;
  }

  .masthead-copy {
    padding: 20px;
  }

  .masthead-copy h1 {
    font-size: clamp(34px, 12vw, 48px);
  }

  .chart-heading,
  .overview-panel-header {
    flex-direction: column;
    align-items: stretch;
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

  .monthly-project-select {
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
  .kpi-card,
  .project-bar-row,
  .project-overview-card,
  .project-overview-line {
    transition-duration: 0.01ms;
  }
}
</style>
