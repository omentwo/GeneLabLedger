import { createRouter, createWebHashHistory, createWebHistory, type RouteRecordRaw } from "vue-router";

import AppLayout from "@/layouts/AppLayout.vue";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    component: AppLayout,
    children: [
      {
        path: "",
        redirect: "/dashboard",
      },
      {
        path: "dashboard",
        name: "dashboard",
        component: () => import("@/views/DashboardView.vue"),
        meta: { title: "统计面板" },
      },
      {
        path: "ledger",
        name: "ledger",
        component: () => import("@/views/LedgerView.vue"),
        meta: { title: "台账" },
      },
      {
        path: "experiments",
        name: "experiments",
        component: () => import("@/views/ExperimentsView.vue"),
        meta: { title: "实验编排" },
      },
      {
        path: "auto-export",
        name: "auto-export",
        component: () => import("@/views/AutoExportView.vue"),
        meta: { title: "自动导出" },
      },
      {
        path: "reports",
        name: "reports",
        component: () => import("@/views/ReportsView.vue"),
        meta: { title: "报告模板" },
      },
      {
        path: "audit",
        name: "audit",
        component: () => import("@/views/AuditView.vue"),
        meta: { title: "日志审计" },
      },
      {
        path: "settings",
        name: "settings",
        component: () => import("@/views/SettingsView.vue"),
        meta: { title: "数据与设置" },
      },
    ],
  },
];

const router = createRouter({
  history: window.geneLedgerDesktop ? createWebHashHistory() : createWebHistory("/"),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.afterEach((to) => {
  const pageTitle = typeof to.meta.title === "string" ? to.meta.title : "";
  document.title = pageTitle
    ? `${pageTitle} · 基因检测台账管理系统`
    : "基因检测台账管理系统";
});

export default router;
