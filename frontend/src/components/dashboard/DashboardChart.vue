<script setup lang="ts">
import type { EChartsCoreOption } from "echarts/core";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

echarts.use([
  AriaComponent,
  BarChart,
  GridComponent,
  LegendComponent,
  LineChart,
  SVGRenderer,
  TooltipComponent,
]);

const props = defineProps<{
  option: EChartsCoreOption;
  label: string;
}>();
const emit = defineEmits<{
  chartClick: [params: unknown];
}>();

const chartElement = ref<HTMLDivElement | null>(null);
let chart: ReturnType<typeof echarts.init> | null = null;
let resizeObserver: ResizeObserver | null = null;

function render(): void {
  chart?.setOption(props.option, { notMerge: true });
}

onMounted(() => {
  if (!chartElement.value) return;
  chart = echarts.init(chartElement.value, undefined, { renderer: "svg" });
  chart.on("click", (params) => emit("chartClick", params));
  render();
  resizeObserver = new ResizeObserver(() => chart?.resize());
  resizeObserver.observe(chartElement.value);
});

watch(() => props.option, render, { deep: true });

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="chartElement" class="dashboard-chart" role="img" :aria-label="label" />
</template>

<style scoped>
.dashboard-chart {
  width: 100%;
  height: 100%;
  min-height: inherit;
}
</style>
