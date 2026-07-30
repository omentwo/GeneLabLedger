<script setup lang="ts">
import {
  Calendar,
  Clock,
  DataAnalysis,
  Document,
  List,
  Notebook,
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
];

const currentTitle = computed(() =>
  typeof route.meta.title === "string" ? route.meta.title : "基因检测台账管理系统",
);

onMounted(() => {
  void appStore.bootstrap();
});
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="brand">
        <div class="brand-mark">🧬</div>
        <div>
          <div class="brand-title">基因检测台账</div>
          <div class="brand-subtitle">本机管理系统</div>
        </div>
      </div>

      <nav class="side-nav" aria-label="主导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="side-nav-item"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <span
          class="connection-dot"
          :class="{ online: appStore.backendOnline }"
          aria-hidden="true"
        />
        <span>{{ appStore.backendOnline ? "本机后端已连接" : "正在连接后端" }}</span>
      </div>
    </aside>

    <main class="app-main">
      <header class="app-topbar">
        <div>
          <h1>{{ currentTitle }}</h1>
          <p>所有业务数据以本机数据库为准</p>
        </div>
      </header>

      <section class="app-content">
        <RouterView />
      </section>
    </main>
  </div>
</template>
