<script setup lang="ts">
import {
  CalendarDays as Calendar,
  Clock3 as Clock,
  ChartNoAxesCombined as DataAnalysis,
  FileText as Document,
  PanelLeftOpen as Expand,
  PanelLeftClose as Fold,
  ClipboardList as List,
  NotebookTabs as Notebook,
  Settings2 as Setting,
  Dna,
  Server,
} from "@lucide/vue";
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
const isSidebarCollapsed = ref(false);
let removeWindowStateListener: (() => void) | undefined;

const SIDEBAR_COLLAPSED_STORAGE_KEY = "gene-lab-ledger.sidebar-collapsed";

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

function restoreSidebarState(): void {
  try {
    isSidebarCollapsed.value = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    // localStorage can be unavailable in a restricted browser context.
  }
}

function toggleSidebar(): void {
  isSidebarCollapsed.value = !isSidebarCollapsed.value;
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(isSidebarCollapsed.value),
    );
  } catch {
    // The sidebar still toggles for this session when persistence is unavailable.
  }
}

onMounted(() => {
  restoreSidebarState();
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
  <div
    class="app-shell"
    :class="{ 'sidebar-collapsed': isSidebarCollapsed }"
  >
    <header class="window-titlebar" aria-label="窗口标题栏">
      <div class="window-titlebar-drag" @dblclick="toggleMaximize">
        <svg class="window-titlebar-mark" viewBox="0 0 64 64" aria-hidden="true">
          <rect x="2" y="2" width="60" height="60" rx="18" fill="var(--app-primary-soft)" stroke="var(--app-primary-border)" stroke-width="2" />
          <path d="M22 16c14 4 14 28 28 32M42 16c-14 4-14 28-28 32" fill="none" stroke="var(--app-primary)" stroke-width="4" stroke-linecap="round" />
          <path d="M24 22h16M22 32h20M24 42h16" stroke="var(--app-brand)" stroke-width="3" stroke-linecap="round" />
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
      <aside
        class="app-sidebar"
        :class="{ 'is-collapsed': isSidebarCollapsed }"
      >
        <div class="sidebar-brand">
          <span v-if="!isSidebarCollapsed" class="sidebar-brand-mark" aria-hidden="true">
            <Dna :size="24" :stroke-width="1.7" />
          </span>
          <div v-if="!isSidebarCollapsed" class="sidebar-brand-title">
            <strong>基因检测台账</strong>
            <span>实验工作空间</span>
          </div>
          <button
            class="sidebar-toggle"
            type="button"
            :aria-expanded="!isSidebarCollapsed"
            aria-controls="primary-navigation"
            :aria-label="isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
            :title="isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
            @click="toggleSidebar"
          >
            <Expand v-if="isSidebarCollapsed" :size="18" :stroke-width="1.7" aria-hidden="true" />
            <Fold v-else :size="18" :stroke-width="1.7" aria-hidden="true" />
          </button>

        </div>

        <div v-if="!isSidebarCollapsed" class="sidebar-section-label">工作导航</div>
        <nav id="primary-navigation" class="sidebar-navigation" aria-label="主导航">
          <RouterLink
            v-for="item in navigation"
            :key="item.to"
            :to="item.to"
            class="sidebar-nav-link"
            :aria-label="item.label"
            :title="isSidebarCollapsed ? item.label : undefined"
          >
            <component :is="item.icon" :size="20" :stroke-width="1.7" aria-hidden="true" />
            <span v-if="!isSidebarCollapsed">{{ item.label }}</span>
          </RouterLink>
        </nav>

        <div
          class="sidebar-status"
          role="status"
          :aria-label="appStore.backendOnline ? '本机后端已连接' : '正在连接后端'"
          :title="isSidebarCollapsed ? (appStore.backendOnline ? '本机后端已连接' : '正在连接后端') : undefined"
        >
          <Server
            :size="18"
            :stroke-width="1.7"
            :class="{ 'is-online': appStore.backendOnline }"
            aria-hidden="true"
          />
          <span v-if="!isSidebarCollapsed">{{ appStore.backendOnline ? "本机后端已连接" : "正在连接后端" }}</span>
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
  background: var(--app-bg);
  color: var(--app-text);
  --app-sidebar-expanded-width: 224px;
  --app-sidebar-collapsed-width: 72px;
  --app-sidebar-current-width: var(--app-sidebar-expanded-width);
  display: flex;
  height: 100vh;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.app-shell.sidebar-collapsed {
  --app-sidebar-current-width: var(--app-sidebar-collapsed-width);
}

.window-titlebar {
  position: sticky;
  z-index: 50;
  top: 0;
  display: flex;
  height: 36px;
  flex: 0 0 36px;
  align-items: stretch;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-bg);
  color: var(--app-muted);
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
  color: var(--app-muted);
  cursor: pointer;
  outline: none;
  padding: 0;
  -webkit-app-region: no-drag;
}

.window-control:hover,
.window-control:focus-visible {
  background: var(--app-surface-soft);
  color: var(--app-text);
}

.window-control.active {
  background: var(--app-primary-soft);
  color: var(--app-primary-text);
}

.window-control.active:hover,
.window-control.active:focus-visible {
  background: var(--app-primary-border);
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
  background: var(--app-danger);
  color: var(--app-bg);
}

.app-content {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: var(--app-sidebar-current-width) minmax(0, 1fr);
  overflow: hidden;
  transition: grid-template-columns 180ms ease;
}

.app-content > main {
  min-height: 0;
  overflow: auto;
}

.app-sidebar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-right: 1px solid var(--app-nav-line);
  background: var(--app-nav-bg);
  padding: 20px 12px 16px;
  position: sticky;
  top: 36px;
  height: calc(100vh - 36px);
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  transition: padding 180ms ease;
}

.sidebar-brand {
  display: flex;
  min-height: 64px;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 0 0 18px;
  border-bottom: 1px solid var(--app-nav-line);
}

.sidebar-brand-mark {
  display: grid;
  place-items: center;
  flex: 0 0 36px;
  height: 40px;
  border-radius: 12px;
  background: var(--app-nav-active);
  color: var(--app-nav-active-text);
}

.sidebar-brand-title {
  display: grid;
  gap: 5px;
  min-width: 0;
  flex: 1;
  white-space: nowrap;
}

.sidebar-brand-title strong {
  color: var(--app-nav-heading);
  font-size: 14px;
  font-weight: 650;
}

.sidebar-brand-title span,
.sidebar-section-label {
  color: var(--app-nav-muted);
  font-size: 12px;
}

.sidebar-section-label {
  padding: 16px 12px 6px;
  letter-spacing: 0.08em;
}

.sidebar-navigation {
  display: grid;
  gap: 7px;
}

.sidebar-toggle {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--app-nav-text);
  cursor: pointer;
  outline: none;
  padding: 0;
  transition: background-color 150ms ease, color 150ms ease;
}

.sidebar-toggle:hover,
.sidebar-toggle:focus-visible {
  background: var(--app-nav-hover);
  color: var(--app-nav-active-text);
}

.sidebar-nav-link {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 46px;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 12px;
  padding: 10px 12px;
  color: var(--app-nav-text);
  font-size: 14px;
  font-weight: 550;
  text-decoration: none;
  transition: background-color 180ms ease, color 180ms ease, border-color 180ms ease;
}

.sidebar-nav-link > svg {
  flex: 0 0 auto;
}

.sidebar-nav-link:hover {
  background: var(--app-nav-hover);
  color: var(--app-nav-active-text);
}

.sidebar-nav-link.router-link-active {
  background: var(--app-nav-active);
  border-color: var(--app-nav-active-border);
  color: var(--app-nav-active-text);
  font-weight: 650;
}

.sidebar-nav-link:focus-visible,
.sidebar-toggle:focus-visible {
  outline: 2px solid var(--app-nav-focus);
  outline-offset: 2px;
}

.sidebar-status {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  margin-top: auto;
  border-top: 1px solid var(--app-nav-line);
  padding: 18px 10px 4px;
  color: var(--app-nav-muted);
  font-size: 12px;
}

.sidebar-status > svg {
  flex-shrink: 0;
  color: var(--app-nav-muted);
}

.sidebar-status > svg.is-online {
  color: var(--app-live);
}

.sidebar-nav-link span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-sidebar.is-collapsed .sidebar-brand {
  justify-content: center;
  padding-inline: 0;
}

.app-sidebar.is-collapsed .sidebar-brand > svg,
.app-sidebar.is-collapsed .sidebar-brand-title {
  display: none;
}

.app-sidebar.is-collapsed .sidebar-status {
  justify-content: center;
  padding-inline: 0;
}

.app-sidebar.is-collapsed .sidebar-nav-link {
  width: 44px;
  justify-self: center;
  justify-content: center;
  padding-inline: 0;
}

@media (max-width: 760px) {
  .app-shell {
    --app-sidebar-expanded-width: 200px;
  }

  .sidebar-brand-mark {
    display: none;
  }

  .window-control {
    width: 40px;
  }

  .window-titlebar-drag {
    padding-inline: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-content,
  .app-sidebar,
  .sidebar-nav-link,
  .sidebar-toggle {
    transition: none;
  }
}
</style>
