import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHealth } from "@/api/system";
import { listProjects } from "@/api/projects";
import { useAppStore } from "@/stores/app";
vi.mock("@/api/system", () => ({ getHealth: vi.fn() }));
vi.mock("@/api/projects", () => ({ listProjects: vi.fn() }));
describe("backend health", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); });
  it("does not call the backend offline when projects fail", async () => {
    vi.mocked(getHealth).mockResolvedValue({ status: "ok" } as Awaited<ReturnType<typeof getHealth>>);
    vi.mocked(listProjects).mockRejectedValue(new Error("project query failed"));
    const store = useAppStore(); await store.bootstrap();
    expect(store.backendOnline).toBe(true);
    expect(store.bootstrapError).toBe("project query failed");
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
