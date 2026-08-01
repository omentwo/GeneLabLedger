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
import { onMounted } from "vue";
import { RouterLink, RouterView } from "vue-router";

import { useAppStore } from "@/stores/app";

const appStore = useAppStore();

const navigation = [
  { to: "/dashboard", label: "统计面板", icon: DataAnalysis },
  { to: "/ledger", label: "台账", icon: Notebook },
  { to: "/experiments", label: "实验编排", icon: Calendar },
  { to: "/auto-export", label: "自动导出", icon: Clock },
  { to: "/reports", label: "报告模板", icon: Document },
  { to: "/audit", label: "日志审计", icon: List },
  { to: "/settings", label: "数据与设置", icon: Setting },
];

onMounted(() => {
  void appStore.bootstrap();
});
</script>

<template>
  <div class="grid min-h-screen grid-cols-[180px_minmax(0,1fr)] bg-slate-50 text-slate-900">
    <aside
      class="sticky top-0 flex h-screen flex-col border-r border-slate-200 bg-white px-2.5 py-3 shadow-[1px_0_0_rgba(15,23,42,0.02)]"
    >
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
</template>
