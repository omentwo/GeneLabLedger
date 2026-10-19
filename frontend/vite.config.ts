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
  // 只有真正的 BarView 实现文件才包含注入锚点。开发模式下 echarts 被
  // optimizeDeps 预打包成单一依赖块，插件不会命中；生产构建会逐个处理
  // 原始模块，因此只要求「命中 BarView 且找不到锚点」时报错。
  const barViewModule = /[/\\]chart[/\\]bar[/\\]BarView\.(?:js|mjs)$/;
  let patchedFiles = 0;
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
      if (!id.includes("echarts") || !id.includes("BarView")) return null;
      if (!code.includes(target)) {
        if (barViewModule.test(id)) {
          this.error(
            "echarts BarView 的动画锚点已变化，堆叠柱整列生长补丁未生效；" +
              "请对照 apache/echarts#20862 重新确认注入位置，或升级 echarts 后删除该插件。",
          );
        }
        return null;
      }
      patchedFiles += 1;
      return { code: code.replace(target, addition), map: null };
    },
    buildEnd() {
      if (patchedFiles === 0) {
        this.warn("echarts 堆叠柱动画补丁未命中任何 BarView 模块，可能是依赖未参与构建。");
      }
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
    // 桌面安装包不发布 sourcemap：它只会增大 asar 体积并暴露源码。
    // 需要排障时用 `vite build --sourcemap` 单独构建。
    sourcemap: false,
  },
});
