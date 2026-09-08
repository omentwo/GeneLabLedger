import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHealth } from "@/api/system";
import { listProjects } from "@/api/projects";
import { useAppStore } from "@/stores/app";
import type { Project } from "@/types/api";
vi.mock("@/api/system", () => ({ getHealth: vi.fn() }));
vi.mock("@/api/projects", () => ({ listProjects: vi.fn() }));
describe("backend health", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); });
  it("surfaces project failures, preserves cached projects, and retries", async () => {
    vi.mocked(getHealth).mockResolvedValue({ status: "ok" } as Awaited<ReturnType<typeof getHealth>>);
    const cached = [{
      id: "cached",
      name: "缓存项目",
      sort_order: 1,
      experiment_enabled: true,
      fields: [],
    }] satisfies Project[];
    const refreshed = [{
      id: "refreshed",
      name: "刷新项目",
      sort_order: 2,
      experiment_enabled: true,
      fields: [],
    }] satisfies Project[];
    vi.mocked(listProjects)
      .mockRejectedValueOnce(new Error("project query failed"))
      .mockResolvedValueOnce(refreshed);
    const store = useAppStore();
    store.projects = cached;
    await expect(store.bootstrap()).rejects.toThrow("project query failed");
    expect(store.backendOnline).toBe(true);
    expect(store.bootstrapError).toBe("project query failed");
    expect(store.projects).toEqual(cached);

    await expect(store.bootstrap()).resolves.toBeUndefined();
    expect(store.projects).toEqual(refreshed);
    expect(store.bootstrapError).toBe("");
  });
  it("loads projects despite a failed health check and recovers later", async () => {
    vi.mocked(getHealth).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: "ok" } as Awaited<ReturnType<typeof getHealth>>);
    vi.mocked(listProjects).mockResolvedValue([]);
    const store = useAppStore(); await store.bootstrap();
    expect(store.backendOnline).toBe(false);
    await store.refreshHealth(); expect(store.backendOnline).toBe(true);
    vi.mocked(getHealth).mockRejectedValue(new Error("offline"));
    await store.refreshHealth(); expect(store.backendOnline).toBe(false);
  });
});
