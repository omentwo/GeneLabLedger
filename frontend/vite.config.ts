import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

/**
 * echarts 的堆叠柱入场动画自 v6 重写起缺失整列自基线生长
 * （upstream apache/echarts#20862 的 BarView 部分未生效，每段柱子会
 * 在各自最终位置原地生长，视觉上分段悬浮）。barGrid 已经把
 * valueAxisStart 存入 itemLayout，这里在打包时把 BarView 读取它的
 * 动画逻辑补回。逻辑与上游 diff 一致，且为幂等设置，升级 echarts
 * 后重复注入无副作用。
 */
function echartsStackedBarWholeColumnAnimation(): Plugin {
  const target = "rectShape[animateProperty] = 0;";
  const addition = [
    "rectShape[animateProperty] = 0;",
    "var isStacked = seriesModel.get('stack') != null;",
    "if (isStacked) {",
    "  var stackAnimateProperty = isHorizontal ? 'y' : 'x';",
    "  var stackedLayout = data.getItemLayout(newIndex);",
    "  var valueAxisStart = stackedLayout.valueAxisStart;",
    "  var barCoordSys = seriesModel.coordinateSystem;",
    "  var barValueAxis = barCoordSys.getOtherAxis(barCoordSys.getBaseAxis());",
    "  var barExtentStart = barValueAxis.getGlobalExtent()[0];",
    "  var barCmp = barValueAxis.inverse === isHorizontal ? Math.max : Math.min;",
    "  rectShape[stackAnimateProperty] = barCmp(valueAxisStart, barExtentStart);",
    "}",
  ].join("\n");
  return {
    name: "echarts-stacked-bar-whole-column-animation",
    transform(code, id) {
      if (!id.includes("echarts") || !id.includes("BarView") || !code.includes(target)) return null;
      return { code: code.replace(target, addition), map: null };
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [vue(), tailwindcss(), echartsStackedBarWholeColumnAnimation()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
