import { defineStore } from "pinia";

import { getHealth } from "@/api/system";
import { listProjects } from "@/api/projects";
import type { HealthStatus, Project } from "@/types/api";

let bootstrapPromise: Promise<void> | null = null;

interface AppState {
  projects: Project[];
  health: HealthStatus | null;
  bootstrapping: boolean;
  bootstrapError: string;
}

export const useAppStore = defineStore("app", {
  state: (): AppState => ({
    projects: [],
    health: null,
    bootstrapping: false,
    bootstrapError: "",
  }),
  getters: {
    backendOnline: (state): boolean => state.health?.status === "ok",
    projectById: (state) => (projectId: string): Project | undefined =>
      state.projects.find((project) => project.id === projectId),
  },
  actions: {
    async bootstrap(): Promise<void> {
      if (bootstrapPromise) {
        await bootstrapPromise;
        return;
      }
      const bootstrap = async (): Promise<void> => {
        this.bootstrapping = true;
        try {
          const [health, projects] = await Promise.allSettled([getHealth(), listProjects()]);
          this.health = health.status === "fulfilled" ? health.value : null;
          if (projects.status === "rejected") {
            const error = projects.reason instanceof Error
              ? projects.reason
              : new Error("项目列表读取失败");
            this.bootstrapError = error.message;
            throw error;
          }
          this.projects = projects.value.slice().sort((a, b) => a.sort_order - b.sort_order);
          this.bootstrapError = "";
        } finally {
          this.bootstrapping = false;
        }
      };
      bootstrapPromise = bootstrap();
      try {
        await bootstrapPromise;
      } finally {
        bootstrapPromise = null;
      }
    },
    async refreshHealth(): Promise<void> {
      this.health = await getHealth().catch(() => null);
    },
    async reloadProjects(): Promise<void> {
      this.projects = (await listProjects()).slice().sort((a, b) => a.sort_order - b.sort_order);
    },
  },
});
