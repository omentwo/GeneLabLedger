<script setup lang="ts">
import {
  Calendar,
  Clock,
  DataAnalysis,
  Document,
  List,
  Notebook,
  Setting,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";

import { useAppStore } from "@/stores/app";
import { desktopBridge } from "@/utils/desktop";

const appStore = useAppStore();
const bridge = desktopBridge();
const isDesktop = computed(() => Boolean(bridge));
const alwaysOnTop = ref(false);
const isMaximized = ref(false);
const windowControlBusy = ref(false);
let removeWindowStateListener: (() => void) | undefined;

const navigation = [
  { to: "/dashboard", label: "统计面板", icon: DataAnalysis },
  { to: "/ledger", label: "台账", icon: Notebook },
  { to: "/experiments", label: "实验编排", icon: Calendar },
  { to: "/auto-export", label: "自动导出", icon: Clock },
  { to: "/reports", label: "报告模板", icon: Document },
  { to: "/audit", label: "日志审计", icon: List },
  { to: "/settings", label: "数据与设置", icon: Setting },
];

async function syncWindowState(): Promise<void> {
  if (!bridge) return;
  try {
    const state = await bridge.getWindowState();
    alwaysOnTop.value = state.alwaysOnTop;
    isMaximized.value = state.isMaximized;
  } catch (error) {
    console.error("窗口状态读取失败", error);
  }
}

async function toggleAlwaysOnTop(): Promise<void> {
  if (!bridge || windowControlBusy.value) return;
  windowControlBusy.value = true;
  try {
    alwaysOnTop.value = await bridge.setAlwaysOnTop(!alwaysOnTop.value);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "置顶设置失败");
  } finally {
    windowControlBusy.value = false;
  }
}

async function minimizeWindow(): Promise<void> {
  if (!bridge || windowControlBusy.value) return;
  try {
    await bridge.minimizeWindow();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "窗口最小化失败");
  }
}

async function toggleMaximize(): Promise<void> {
  if (!bridge || windowControlBusy.value) return;
  windowControlBusy.value = true;
  try {
    isMaximized.value = await bridge.toggleWindowMaximize();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "窗口大小切换失败");
  } finally {
    windowControlBusy.value = false;
  }
}

async function closeWindow(): Promise<void> {
  if (!bridge || windowControlBusy.value) return;
  try {
    await bridge.closeWindow();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "窗口关闭失败");
  }
}

onMounted(() => {
  void appStore.bootstrap();
  if (!bridge) return;
  void syncWindowState();
  removeWindowStateListener = bridge.onWindowStateChanged((state) => {
    alwaysOnTop.value = state.alwaysOnTop;
    isMaximized.value = state.isMaximized;
  });
});

onBeforeUnmount(() => {
  removeWindowStateListener?.();
  removeWindowStateListener = undefined;
});
</script>

<template>
  <div class="app-shell bg-slate-50 text-slate-900">
    <header class="window-titlebar" aria-label="窗口标题栏">
      <div class="window-titlebar-drag" @dblclick="toggleMaximize">
        <svg class="window-titlebar-mark" viewBox="0 0 64 64" aria-hidden="true">
          <rect x="2" y="2" width="60" height="60" rx="18" fill="#e8f3ff" stroke="#b9d7f5" stroke-width="2" />
          <path d="M22 16c14 4 14 28 28 32M42 16c-14 4-14 28-28 32" fill="none" stroke="#1677ff" stroke-width="4" stroke-linecap="round" />
          <path d="M24 22h16M22 32h20M24 42h16" stroke="#16a36a" stroke-width="3" stroke-linecap="round" />
        </svg>
        <span>基因检测台账</span>
      </div>

      <div v-if="isDesktop" class="window-controls" aria-label="窗口控制">
        <button
          class="window-control window-pin"
          :class="{ active: alwaysOnTop }"
          type="button"
          :aria-pressed="alwaysOnTop"
          :title="alwaysOnTop ? '取消始终保持最顶层 (Ctrl+Shift+T)' : '始终保持最顶层 (Ctrl+Shift+T)'"
          :aria-label="alwaysOnTop ? '取消始终保持最顶层' : '始终保持最顶层'"
          @click="toggleAlwaysOnTop"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m8.1 3.5 7.8 2.1-1.2 3 2.7 2.7-2.2 2.2-3.1-1.2-2 2 1.4 1.4-1.3 1.3-2.8-2.8-2.8 1.4-1.3-1.3 2.1-2.1-1.2-3.1 2.2-2.2 2.7 2.7 3-1.2Z" />
            <path d="m11.1 14.5-3.8 5.1M7.3 19.6h5.4" />
          </svg>
        </button>

        <button
          class="window-control"
          type="button"
          aria-label="最小化"
          title="最小化"
          @click="minimizeWindow"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>

        <button
          class="window-control"
          type="button"
          :aria-label="isMaximized ? '还原窗口' : '最大化'"
          :title="isMaximized ? '还原窗口' : '最大化'"
          @click="toggleMaximize"
        >
          <svg v-if="!isMaximized" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v10M6 16V6h10" /></svg>
        </button>

        <button
          class="window-control window-close"
          type="button"
          aria-label="关闭"
          title="关闭"
          @click="closeWindow"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
    </header>

    <div class="app-content">
      <aside class="app-sidebar flex flex-col border-r border-slate-200 bg-white px-2.5 py-3 shadow-[1px_0_0_rgba(15,23,42,0.02)]">
        <div class="flex min-h-16 items-center gap-3 px-3 pb-4">
          <svg
            class="size-8 shrink-0"
            viewBox="0 0 64 64"
            role="img"
            aria-label="基因检测台账"
          >
            <rect x="2" y="2" width="60" height="60" rx="18" fill="#e8f3ff" stroke="#b9d7f5" stroke-width="2" />
            <path d="M22 16c14 4 14 28 28 32M42 16c-14 4-14 28-28 32" fill="none" stroke="#1677ff" stroke-width="4" stroke-linecap="round" />
            <path d="M24 22h16M22 32h20M24 42h16" stroke="#16a36a" stroke-width="3" stroke-linecap="round" />
            <circle cx="22" cy="16" r="3" fill="#f59e0b" />
            <circle cx="42" cy="16" r="3" fill="#f59e0b" />
          </svg>
          <div class="whitespace-nowrap text-[13px] font-bold leading-tight tracking-tight text-slate-900">
            基因检测台账
          </div>
        </div>

        <nav class="grid gap-1.5" aria-label="主导航">
          <RouterLink
            v-for="item in navigation"
            :key="item.to"
            :to="item.to"
            class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 [&.router-link-active]:bg-slate-900 [&.router-link-active]:text-white [&.router-link-active]:shadow-sm"
          >
            <el-icon class="text-base"><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>

        <div class="mt-auto flex items-center gap-2 px-3 pt-4 text-xs text-slate-500">
          <span
            class="size-2 rounded-full bg-slate-300"
            :class="appStore.backendOnline ? 'bg-emerald-500 ring-4 ring-emerald-50' : ''"
            aria-hidden="true"
          />
          <span>{{ appStore.backendOnline ? "本机后端已连接" : "正在连接后端" }}</span>
        </div>
      </aside>

      <main class="min-w-0">
        <section class="min-w-0 px-3 pb-5 pt-3">
          <RouterView />
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  min-height: 100vh;
  flex-direction: column;
}

.window-titlebar {
  position: sticky;
  z-index: 50;
  top: 0;
  display: flex;
  height: 36px;
  flex: 0 0 36px;
  align-items: stretch;
  border-bottom: 1px solid #e4e7ec;
  background: rgb(255 255 255 / 96%);
  color: #475467;
  user-select: none;
  -webkit-app-region: drag;
}

.window-titlebar-drag {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  -webkit-app-region: drag;
}

.window-titlebar-mark {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
}

.window-controls {
  display: flex;
  height: 36px;
  align-items: stretch;
  -webkit-app-region: no-drag;
}

.window-control {
  display: inline-flex;
  width: 46px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: #667085;
  cursor: pointer;
  outline: none;
  padding: 0;
  -webkit-app-region: no-drag;
}

.window-control:hover,
.window-control:focus-visible {
  background: #f2f4f7;
  color: #182230;
}

.window-control.active {
  background: #eaf3ff;
  color: #1677ff;
}

.window-control.active:hover,
.window-control.active:focus-visible {
  background: #dbeafe;
}

.window-control svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.window-pin svg {
  width: 17px;
  height: 17px;
}

.window-close:hover,
.window-close:focus-visible {
  background: #e81123;
  color: #fff;
}

.app-content {
  display: grid;
  min-height: calc(100vh - 36px);
  flex: 1 0 auto;
  grid-template-columns: 180px minmax(0, 1fr);
}

.app-sidebar {
  position: sticky;
  top: 36px;
  height: calc(100vh - 36px);
}

@media (max-width: 760px) {
  .window-control {
    width: 40px;
  }

  .window-titlebar-drag {
    padding-inline: 8px;
  }
}
</style>
