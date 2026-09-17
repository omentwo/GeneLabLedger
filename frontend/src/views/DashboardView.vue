<script setup lang="ts">
import type { EChartsCoreOption } from "echarts/core";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCheck2,
  FlaskConical,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { getDashboardSummary } from "@/api/dashboard";
import DashboardChart from "@/components/dashboard/DashboardChart.vue";
import { useAppStore } from "@/stores/app";
import type { DashboardSummary } from "@/types/api";

const appStore = useAppStore();
const router = useRouter();
const summary = ref<DashboardSummary | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const selectedProjectId = ref("");
const trendMonths = ref<6 | 12>(12);
const countFormatter = new Intl.NumberFormat("zh-CN");
let requestController: AbortController | null = null;

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function cssColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[character] ?? character);
}

const activeProjectName = computed(
  () => appStore.projects.find((project) => project.id === selectedProjectId.value)?.name ?? "全部项目",
);

const monthChange = computed(() => {
  const current = summary.value?.current_month ?? 0;
  const previous = summary.value?.previous_month ?? 0;
  if (previous === 0) {
    return current === 0
      ? { label: "与上月持平", tone: "neutral" as const }
      : { label: "本月新增", tone: "up" as const };
  }
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return { label: "与上月持平", tone: "neutral" as const };
  if (Math.abs(change) > 999) {
    const difference = current - previous;
    return {
      label: `较上月 ${difference > 0 ? "+" : ""}${formatCount(difference)} 条`,
      tone: difference > 0 ? "up" as const : "down" as const,
    };
  }
  return {
    label: `较上月 ${change > 0 ? "+" : ""}${change}%`,
    tone: change > 0 ? "up" as const : "down" as const,
  };
});

const visibleMonthly = computed(() => summary.value?.monthly.slice(-trendMonths.value) ?? []);

const lineChartOption = computed<EChartsCoreOption>(() => {
  const primary = cssColor("--app-chart-primary", "#5968ca");
  const text = cssColor("--app-muted", "#606b80");
  const border = cssColor("--app-border", "#e0e4ee");
  const points = visibleMonthly.value;
  return {
    animationDuration: 450,
    aria: { enabled: true, decal: { show: true } },
    grid: { left: 16, right: 18, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: cssColor("--app-card", "#ffffff"),
      borderColor: border,
      textStyle: { color: cssColor("--app-text", "#25304a") },
      formatter: (params: unknown) => {
        const item = Array.isArray(params) ? params[0] as { axisValue?: string; value?: number } : null;
        return item
          ? `<strong>${escapeHtml(item.axisValue ?? "")}</strong><br/>实验记录&nbsp;&nbsp;<b>${formatCount(Number(item.value ?? 0))}</b>`
          : "";
      },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: points.map((point) => point.month),
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: {
        color: text,
        formatter: (value: string) => value.endsWith("-01") ? `${value.slice(0, 4)}年\n1月` : `${Number(value.slice(5))}月`,
      },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: text },
      splitLine: { lineStyle: { color: border, type: "dashed" } },
    },
    series: [{
      name: "实验记录",
      type: "line",
      smooth: 0.28,
      symbol: "circle",
      symbolSize: 7,
      showSymbol: true,
      data: points.map((point) => point.total),
      lineStyle: { width: 3, color: primary },
      itemStyle: { color: primary, borderColor: cssColor("--app-card", "#ffffff"), borderWidth: 2 },
      areaStyle: { color: primary, opacity: 0.1 },
      emphasis: { focus: "series" },
    }],
  };
});

const allProjects = computed(() =>
  [...(summary.value?.projects ?? [])].sort(
    (left, right) =>
      right.current_month - left.current_month ||
      right.previous_month - left.previous_month ||
      left.name.localeCompare(right.name),
  ),
);
const topProjects = computed(() => allProjects.value.slice(0, 7));
const topProjectMax = computed(() => Math.max(1, ...topProjects.value.map((project) => project.current_month)));
const compositionMonthly = computed(() => summary.value?.monthly.slice(-trendMonths.value) ?? []);
const compositionMonthKeys = computed(() => new Set(compositionMonthly.value.map((item) => item.month)));
const projectComposition = computed(() =>
  allProjects.value.filter((project) =>
    project.monthly.some((item) => compositionMonthKeys.value.has(item.month) && item.total > 0),
  ),
);
const workloadChartHeight = computed(() => `${Math.max(330, allProjects.value.length * 46 + 88)}px`);

function projectColor(index: number): string {
  const themeColors = [
    cssColor("--app-chart-primary", "#5968ca"),
    cssColor("--app-chart-secondary", "#9180c7"),
    "#3f8f83",
    "#c7833f",
    "#b86278",
    "#5b7db8",
    "#7b68ad",
  ];
  return themeColors[index] ?? `hsl(${(index * 53 + 198) % 360} 56% 52%)`;
}

const structureChartOption = computed<EChartsCoreOption>(() => ({
  animationDuration: 450,
  aria: { enabled: true, decal: { show: true } },
  grid: { left: 8, right: 10, top: 18, bottom: 74, containLabel: true },
  tooltip: {
    trigger: "axis",
    axisPointer: { type: "shadow" },
    backgroundColor: cssColor("--app-card", "#ffffff"),
    borderColor: cssColor("--app-border", "#e0e4ee"),
    textStyle: { color: cssColor("--app-text", "#25304a") },
  },
  legend: {
    type: "scroll",
    bottom: 0,
    left: 0,
    right: 0,
    icon: "roundRect",
    itemWidth: 10,
    itemHeight: 10,
    pageIconColor: cssColor("--app-primary-text", "#5968ca"),
    pageTextStyle: { color: cssColor("--app-muted", "#606b80") },
    textStyle: { color: cssColor("--app-muted", "#606b80"), width: 76, overflow: "truncate" },
  },
  xAxis: {
    type: "category",
    data: compositionMonthly.value.map((item) => item.month),
    axisTick: { show: false },
    axisLine: { lineStyle: { color: cssColor("--app-border", "#e0e4ee") } },
    axisLabel: {
      color: cssColor("--app-text", "#25304a"),
      fontSize: 10,
      formatter: (value: string) => value.endsWith("-01") ? `${value.slice(0, 4)}年\n1月` : `${Number(value.slice(5))}月`,
    },
  },
  yAxis: {
    type: "value",
    minInterval: 1,
    axisLabel: { color: cssColor("--app-muted", "#606b80") },
    splitLine: { lineStyle: { color: cssColor("--app-border", "#e0e4ee"), type: "dashed" } },
  },
  series: projectComposition.value.map((project, index) => ({
    name: project.name,
    type: "bar",
    stack: "current-month-total",
    barMaxWidth: 42,
    emphasis: { focus: "series" },
    itemStyle: { color: projectColor(index) },
    label: {
      show: true,
      position: "inside",
      formatter: (params: unknown) => {
        const item = params as { dataIndex?: number; value?: number };
        const value = Number(item.value ?? 0);
        const monthlyTotal = compositionMonthly.value[item.dataIndex ?? -1]?.total ?? 0;
        return value > Math.max(1, monthlyTotal * 0.12) ? String(value) : "";
      },
      color: "#ffffff",
      fontWeight: 700,
    },
    data: compositionMonthly.value.map((month) => {
      const value = project.monthly.find((item) => item.month === month.month)?.total ?? 0;
      return { value, projectId: project.id };
    }),
  })),
}));

const projectChartOption = computed<EChartsCoreOption>(() => {
  const projects = [...allProjects.value].reverse();
  const primary = cssColor("--app-chart-primary", "#5968ca");
  const secondary = cssColor("--app-chart-secondary", "#9180c7");
  const text = cssColor("--app-muted", "#606b80");
  return {
    animationDuration: 450,
    aria: { enabled: true, decal: { show: true } },
    grid: { left: 12, right: 18, top: 36, bottom: 6, containLabel: true },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: text },
      data: ["本月", "上月"],
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: cssColor("--app-card", "#ffffff"),
      borderColor: cssColor("--app-border", "#e0e4ee"),
      textStyle: { color: cssColor("--app-text", "#25304a") },
    },
    xAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: text },
      splitLine: { lineStyle: { color: cssColor("--app-border", "#e0e4ee"), type: "dashed" } },
    },
    yAxis: {
      type: "category",
      data: projects.map((project) => project.name),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: cssColor("--app-text", "#25304a"), width: 112, overflow: "truncate" },
    },
    series: [
      {
        name: "本月",
        type: "bar",
        barMaxWidth: 14,
        itemStyle: { color: primary, borderRadius: [0, 5, 5, 0] },
        data: projects.map((project) => ({ value: project.current_month, projectId: project.id })),
      },
      {
        name: "上月",
        type: "bar",
        barMaxWidth: 14,
        itemStyle: { color: secondary, borderRadius: [0, 5, 5, 0] },
        data: projects.map((project) => ({ value: project.previous_month, projectId: project.id })),
      },
    ],
  };
});

async function loadDashboard(): Promise<void> {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loading.value = true;
  errorMessage.value = "";
  try {
    summary.value = await getDashboardSummary(selectedProjectId.value, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;
    errorMessage.value = error instanceof Error ? error.message : "统计数据加载失败";
  } finally {
    if (requestController === controller) loading.value = false;
  }
}

function openProjectFromChart(params: unknown): void {
  if (!params || typeof params !== "object" || !("data" in params)) return;
  const data = (params as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("projectId" in data)) return;
  const projectId = String((data as { projectId: unknown }).projectId);
  void router.push({ path: "/ledger", query: { project: projectId } });
}

watch(selectedProjectId, () => void loadDashboard());
watch(
  () => appStore.projects.map((project) => project.id),
  (projectIds) => {
    if (selectedProjectId.value && !projectIds.includes(selectedProjectId.value)) {
      selectedProjectId.value = "";
    }
  },
);

onMounted(() => void loadDashboard());
onBeforeUnmount(() => requestController?.abort());
</script>

<template>
  <main class="dashboard" :aria-busy="loading">
    <header class="dashboard-header">
      <div>
        <span class="dashboard-eyebrow">统计面板</span>
        <h1>实验数据概览</h1>
        <p>{{ activeProjectName }} · 数据口径为实验日期</p>
      </div>
      <div class="dashboard-actions">
        <el-select
          v-model="selectedProjectId"
          class="project-filter"
          filterable
          aria-label="筛选检测项目"
          placeholder="全部项目"
        >
          <el-option label="全部项目" value="" />
          <el-option v-for="project in appStore.projects" :key="project.id" :label="project.name" :value="project.id" />
        </el-select>
        <button class="refresh-button" type="button" :disabled="loading" @click="loadDashboard">
          <RefreshCw :size="16" :class="{ spinning: loading }" aria-hidden="true" />刷新
        </button>
      </div>
    </header>

    <div v-if="errorMessage" class="dashboard-alert" role="alert">
      <CircleAlert :size="18" aria-hidden="true" />
      <span>{{ errorMessage }}</span>
      <button type="button" @click="loadDashboard">重新加载</button>
    </div>

    <template v-if="loading && !summary">
      <section class="kpi-grid" aria-label="正在加载核心指标">
        <article v-for="index in 4" :key="index" class="kpi-card skeleton-card"><el-skeleton animated :rows="2" /></article>
      </section>
      <section class="loading-panel"><el-skeleton animated :rows="8" /></section>
    </template>

    <template v-else-if="summary">
      <section class="kpi-grid" aria-label="核心统计指标">
        <article class="kpi-card kpi-card-primary">
          <span class="kpi-icon"><FlaskConical :size="20" aria-hidden="true" /></span>
          <div class="kpi-content"><span class="kpi-label">实验记录总量</span><strong>{{ formatCount(summary.total_records) }}</strong><small>当前筛选范围内全部记录</small></div>
        </article>
        <article class="kpi-card">
          <span class="kpi-icon"><CalendarDays :size="20" aria-hidden="true" /></span>
          <div class="kpi-content">
            <span class="kpi-label">本月实验</span><strong>{{ formatCount(summary.current_month) }}</strong>
            <small :class="`change-${monthChange.tone}`"><TrendingUp v-if="monthChange.tone === 'up'" :size="14" aria-hidden="true" /><TrendingDown v-else-if="monthChange.tone === 'down'" :size="14" aria-hidden="true" />{{ monthChange.label }}</small>
          </div>
        </article>
        <article class="kpi-card">
          <span class="kpi-icon"><Clock3 :size="20" aria-hidden="true" /></span>
          <div class="kpi-content"><span class="kpi-label">近 30 天</span><strong>{{ formatCount(summary.recent_30_days) }}</strong><small>截至 {{ summary.as_of }}</small></div>
        </article>
        <article class="kpi-card">
          <span class="kpi-icon"><FileCheck2 :size="20" aria-hidden="true" /></span>
          <div class="kpi-content"><span class="kpi-label">报告生成率</span><strong>{{ summary.report_generated_rate.toFixed(1) }}<em>%</em></strong><small>{{ formatCount(summary.report_generated) }} 条已生成报告</small></div>
        </article>
      </section>

      <section class="analytics-grid">
        <article class="panel trend-panel">
          <header class="panel-header">
            <div><span class="panel-eyebrow">趋势</span><h2>月度实验量</h2><p>{{ activeProjectName }}的实验记录变化</p></div>
            <div class="range-switch" aria-label="趋势时间范围"><button type="button" :class="{ active: trendMonths === 6 }" @click="trendMonths = 6">近 6 月</button><button type="button" :class="{ active: trendMonths === 12 }" @click="trendMonths = 12">近 12 月</button></div>
          </header>
          <DashboardChart class="trend-chart" :option="lineChartOption" :label="`${activeProjectName}近 ${trendMonths} 个月实验量折线图`" />
        </article>

        <article class="panel structure-panel">
          <header class="panel-header">
            <div><span class="panel-eyebrow">结构</span><h2>月度项目构成</h2><p>每月柱高为当月总例数，颜色区分项目</p></div>
            <div class="range-switch" aria-label="构成时间范围"><button type="button" :class="{ active: trendMonths === 6 }" @click="trendMonths = 6">近 6 月</button><button type="button" :class="{ active: trendMonths === 12 }" @click="trendMonths = 12">近 12 月</button></div>
          </header>
          <DashboardChart v-if="projectComposition.length" class="structure-chart" :option="structureChartOption" :label="`${activeProjectName}近 ${trendMonths} 个月各项目实验量堆叠柱状图`" @chart-click="openProjectFromChart" />
          <div v-else class="panel-empty">当前周期暂无项目数据</div>
        </article>
      </section>

      <section class="workload-grid">
        <article class="panel workload-panel">
          <header class="panel-header workload-heading"><div><span class="panel-eyebrow">工作量</span><h2>全部台账月度对比</h2><p>逐一展示每个台账的本月与上月实验量</p></div><span class="panel-note">点击条形进入项目台账</span></header>
          <DashboardChart v-if="allProjects.length" class="workload-chart" :style="{ height: workloadChartHeight, minHeight: workloadChartHeight }" :option="projectChartOption" label="全部台账本月与上月实验量对比图" @chart-click="openProjectFromChart" />
          <div v-else class="panel-empty">暂无项目工作量数据</div>
        </article>

        <aside class="panel ranking-panel" aria-labelledby="ranking-title">
          <header class="panel-header"><div><span class="panel-eyebrow">排名</span><h2 id="ranking-title">本月前 7 名</h2><p>按本月实验例数排序</p></div></header>
          <ol v-if="topProjects.length" class="ranking-list">
            <li v-for="(project, index) in topProjects" :key="project.id">
              <RouterLink :to="{ path: '/ledger', query: { project: project.id } }" class="ranking-link">
                <span class="ranking-index" :class="{ leading: index < 3 }">{{ index + 1 }}</span>
                <span class="ranking-main"><strong>{{ project.name }}</strong><i><b :style="{ width: `${(project.current_month / topProjectMax) * 100}%` }" /></i></span>
                <span class="ranking-value"><strong>{{ formatCount(project.current_month) }}</strong><small>例</small></span>
              </RouterLink>
            </li>
          </ol>
          <div v-else class="panel-empty">暂无排名数据</div>
        </aside>
      </section>

      <section class="panel project-panel">
        <header class="panel-header"><div><span class="panel-eyebrow">快捷入口</span><h2>进入项目台账</h2></div><span class="project-count">{{ appStore.projects.length }} 个项目</span></header>
        <div class="project-links">
          <RouterLink v-for="project in appStore.projects" :key="project.id" :to="{ path: '/ledger', query: { project: project.id } }" class="project-link"><span><CheckCircle2 :size="16" aria-hidden="true" />{{ project.name }}</span><ArrowRight :size="16" aria-hidden="true" /></RouterLink>
          <div v-if="!appStore.projects.length" class="panel-empty">暂无可查看的项目</div>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.dashboard { display: grid; gap: 18px; color: var(--app-text); }
.dashboard-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 6px 2px 2px; }
.dashboard-eyebrow, .panel-eyebrow { display: block; margin-bottom: 5px; color: var(--app-primary-text); font-size: 11px; font-weight: 750; letter-spacing: 0.13em; text-transform: uppercase; }
.dashboard-header h1 { margin: 0; font-size: clamp(25px, 3vw, 34px); line-height: 1.2; letter-spacing: -0.035em; }
.dashboard-header p, .panel-header p { margin: 6px 0 0; color: var(--app-muted); font-size: 13px; }
.dashboard-actions { display: flex; align-items: center; gap: 10px; }
.project-filter { width: 220px; }
.refresh-button { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 13px; border: 1px solid var(--app-border-strong); border-radius: 8px; color: var(--app-text); background: var(--app-card); font: inherit; font-size: 13px; cursor: pointer; }
.refresh-button:hover:not(:disabled) { border-color: var(--app-primary); color: var(--app-primary-text); }
.refresh-button:disabled { cursor: wait; opacity: 0.65; }
.spinning { animation: spin 0.9s linear infinite; }
.dashboard-alert { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--app-danger); border-radius: 10px; color: var(--app-danger); background: var(--app-danger-soft); font-size: 13px; }
.dashboard-alert span { flex: 1; }
.dashboard-alert button { border: 0; color: inherit; background: transparent; font: inherit; font-weight: 700; cursor: pointer; }
.kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.kpi-card, .panel, .loading-panel { border: 1px solid var(--app-border); border-radius: 14px; background: var(--app-card); box-shadow: 0 1px 2px rgb(15 23 42 / 4%); }
.kpi-card { display: flex; align-items: flex-start; gap: 13px; min-width: 0; padding: 18px; }
.kpi-card-primary { border-color: var(--app-primary-border); background: linear-gradient(145deg, var(--app-card), var(--app-primary-soft)); }
.kpi-icon { display: grid; flex: 0 0 38px; width: 38px; height: 38px; place-items: center; border-radius: 10px; color: var(--app-primary-text); background: var(--app-primary-soft); }
.kpi-content { display: grid; min-width: 0; gap: 3px; }
.kpi-label { color: var(--app-muted); font-size: 12px; font-weight: 650; }
.kpi-content strong { font-size: clamp(25px, 3vw, 34px); line-height: 1.15; letter-spacing: -0.035em; }
.kpi-content strong em { margin-left: 2px; font-size: 15px; font-style: normal; color: var(--app-muted); }
.kpi-content small { display: flex; align-items: center; gap: 4px; min-height: 18px; color: var(--app-subtle); font-size: 11px; }
.kpi-content small.change-up { color: var(--app-success-text); }
.kpi-content small.change-down { color: var(--app-danger); }
.analytics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.panel { min-width: 0; padding: 18px; }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.panel-header h2 { margin: 0; font-size: 17px; line-height: 1.3; }
.range-switch { display: inline-flex; flex: 0 0 auto; padding: 3px; border: 1px solid var(--app-border); border-radius: 9px; background: var(--app-surface-soft); }
.range-switch button { padding: 5px 9px; border: 0; border-radius: 6px; color: var(--app-muted); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.range-switch button.active { color: var(--app-primary-text); background: var(--app-card); box-shadow: 0 1px 3px rgb(15 23 42 / 10%); }
.trend-chart { height: 300px; min-height: 300px; margin-top: 8px; }
.structure-chart { height: 300px; min-height: 300px; margin-top: 8px; cursor: pointer; }
.workload-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; align-items: start; gap: 14px; }
.workload-heading { align-items: center; }
.panel-note, .project-count { color: var(--app-muted); font-size: 11px; }
.workload-chart { height: 330px; min-height: 330px; margin-top: 10px; cursor: pointer; }
.ranking-list { display: grid; gap: 3px; margin: 15px 0 0; padding: 0; list-style: none; }
.ranking-link { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 9px; min-width: 0; padding: 10px 4px; border-bottom: 1px solid var(--app-border-light); color: var(--app-text); text-decoration: none; }
.ranking-list li:last-child .ranking-link { border-bottom: 0; }
.ranking-link:hover .ranking-main strong { color: var(--app-primary-text); }
.ranking-index { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 8px; color: var(--app-muted); background: var(--app-surface-soft); font-size: 11px; font-weight: 750; }
.ranking-index.leading { color: var(--app-on-primary); background: var(--app-primary); }
.ranking-main { display: grid; min-width: 0; gap: 7px; }
.ranking-main strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; transition: color 0.15s ease; }
.ranking-main i { display: block; height: 4px; overflow: hidden; border-radius: 99px; background: var(--app-border-light); }
.ranking-main i b { display: block; height: 100%; min-width: 3px; border-radius: inherit; background: var(--app-chart-primary); }
.ranking-value { display: flex; align-items: baseline; gap: 2px; }
.ranking-value strong { font-size: 15px; }
.ranking-value small { color: var(--app-muted); font-size: 10px; }
.project-links { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; margin-top: 16px; }
.project-link { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; padding: 11px 12px; border: 1px solid var(--app-border); border-radius: 9px; color: var(--app-text); background: var(--app-surface-soft); text-decoration: none; transition: border-color 0.16s ease, transform 0.16s ease, background 0.16s ease; }
.project-link span { display: flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.project-link span svg { flex: 0 0 auto; color: var(--app-primary-text); }
.project-link > svg { flex: 0 0 auto; color: var(--app-muted); }
.project-link:hover { transform: translateY(-1px); border-color: var(--app-primary); background: var(--app-primary-soft); }
.panel-empty { display: grid; min-height: 220px; place-items: center; color: var(--app-muted); font-size: 13px; }
.loading-panel { min-height: 420px; padding: 24px; }
.skeleton-card { min-height: 118px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1120px) {
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .analytics-grid { grid-template-columns: minmax(0, 1fr); }
  .structure-chart { height: 280px; min-height: 280px; }
  .workload-grid { grid-template-columns: minmax(0, 1fr); }
  .ranking-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ranking-list li:nth-child(odd):last-child { grid-column: 1 / -1; }
  .project-links { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .dashboard { gap: 12px; }
  .dashboard-header { align-items: stretch; flex-direction: column; gap: 14px; }
  .dashboard-actions { align-items: stretch; }
  .project-filter { flex: 1; width: auto; }
  .kpi-grid { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .kpi-card { padding: 15px; }
  .panel { padding: 15px; }
  .trend-chart { height: 270px; min-height: 270px; }
  .workload-heading { align-items: flex-start; }
  .panel-note { display: none; }
  .workload-chart { height: 300px; min-height: 300px; }
  .ranking-list { grid-template-columns: minmax(0, 1fr); }
  .ranking-list li:nth-child(odd):last-child { grid-column: auto; }
  .project-links { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .spinning { animation: none; }
  .project-link { transition: none; }
}
</style>
