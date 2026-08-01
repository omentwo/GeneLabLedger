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
import { computed, onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";

import { useAppStore } from "@/stores/app";

const route = useRoute();
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

const currentTitle = computed(() =>
  typeof route.meta.title === "string" ? route.meta.title : "基因检测台账管理系统",
);

onMounted(() => {
  void appStore.bootstrap();
});
</script>

<template>
  <div class="grid min-h-screen grid-cols-[220px_minmax(0,1fr)] bg-slate-50 text-slate-900">
    <aside
      class="sticky top-0 flex h-screen flex-col border-r border-slate-200 bg-white px-3 py-4 shadow-[1px_0_0_rgba(15,23,42,0.02)]"
    >
      <div class="flex min-h-16 items-center gap-3 px-3 pb-4">
        <div class="grid size-10 place-items-center rounded-xl bg-blue-50 text-xl ring-1 ring-blue-100">
          🧬
        </div>
        <div>
          <div class="font-bold tracking-tight text-slate-900">基因检测台账</div>
          <div class="mt-0.5 text-xs text-slate-500">本机实验室管理系统</div>
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
      <header
        class="sticky top-0 z-20 flex min-h-[76px] items-center justify-between border-b border-slate-200 bg-white/90 px-6 py-3 backdrop-blur"
      >
        <div>
          <h1 class="m-0 text-xl font-bold tracking-tight text-slate-900">{{ currentTitle }}</h1>
          <p class="mt-1 text-xs text-slate-500">所有业务数据以当前选定的本机数据库为准</p>
        </div>
      </header>

      <section class="px-5 pb-8 pt-4">
        <RouterView />
      </section>
    </main>
  </div>
</template>
