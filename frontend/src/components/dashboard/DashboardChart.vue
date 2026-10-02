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
let renderedSize = { width: 0, height: 0 };

function render(): void {
  chart?.setOption(props.option, { notMerge: true });
}

onMounted(() => {
  if (!chartElement.value) return;
  chart = echarts.init(chartElement.value, undefined, { renderer: "svg" });
  chart.on("click", (params) => emit("chartClick", params));
  render();
  renderedSize = {
    width: chartElement.value.clientWidth,
    height: chartElement.value.clientHeight,
  };
  // ResizeObserver 的首次回调与入场动画同时发生且尺寸未变，
  // 此时 resize 会打断柱子的生长动画，因此只在尺寸真正变化时 resize
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const width = Math.round(entry.contentRect.width);
    const height = Math.round(entry.contentRect.height);
    if (width <= 0 || height <= 0) return;
    if (width === renderedSize.width && height === renderedSize.height) return;
    renderedSize = { width, height };
    chart?.resize();
  });
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
