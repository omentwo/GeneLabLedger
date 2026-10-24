import { createApp, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSetting } from "@/api/system";
import type { FieldDefinition, Project, ProjectRecord, RecordComplexQuery } from "@/types/api";
import LedgerView from "@/views/LedgerView.vue";

const mocks = vi.hoisted(() => ({
  store: {
    projects: [] as Project[],
    bootstrap: vi.fn(async () => undefined),
    projectById: (id: string): Project | undefined => mocks.store.projects.find((project) => project.id === id),
  },
  queryRecords: vi.fn(),
  message: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/stores/app", () => ({ useAppStore: () => mocks.store }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ query: { project: "A" } }),
  useRouter: () => ({ replace: vi.fn(async () => undefined), push: vi.fn() }),
}));
vi.mock("element-plus", () => ({
  ElMessage: mocks.message,
  ElMessageBox: { confirm: vi.fn() },
  TableV2FixedDir: { LEFT: "left" },
}));
vi.mock("@/api/records", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/records")>(),
  queryRecords: mocks.queryRecords,
}));
vi.mock("@/api/system", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/system")>(),
  getSetting: vi.fn(async () => ({ value: null })),
  putSetting: vi.fn(async () => undefined),
}));
vi.mock("@/api/preview", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/preview")>(),
  getPreviewCapabilities: vi.fn(async () => ({ native_preview: false })),
}));
vi.mock("@/utils/desktop", () => ({ desktopBridge: () => undefined }));

function field(projectId: string, key: string, systemKey: string | null): FieldDefinition {
  return {
    id: `${projectId}-${key}`, project_id: projectId, key, label: key,
    data_type: "text", system_key: systemKey, is_core: systemKey !== null,
    hidden: false, sort_order: 0, width: 120, options: [],
  };
}

function record(projectId: string, id: string, note: string): ProjectRecord {
  return {
    id, project_id: projectId, project_name: projectId, position: 1,
    pathology_number: id, block_number: null, status: "待实验", experiment_date: null,
    experiment_number: null, report_generated: false, locked: false,
    highlight_color: null, values: { [`${projectId}-note`]: note }, created_at: "", updated_at: "",
  };
}

let app: App | undefined;
let container: HTMLDivElement;
let database: Map<string, ProjectRecord[]>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSetting).mockImplementation(async (key) => ({ key, value: null }));
  window.localStorage.clear();
  mocks.store.projects = ["A", "B"].map((id) => ({
    id, name: id, sort_order: 0, experiment_enabled: true,
    duplicate_pathology_warning_enabled: true,
    fields: [field(id, "pathology", "pathology_number"), field(id, "note", null)],
  }));
  database = new Map([
    ["A", [record("A", "a1", "note-a1"), record("A", "a2", "note-a2")]],
    ["B", [record("B", "b1", "note-b1")]],
  ]);
  mocks.queryRecords.mockImplementation(async (query: RecordComplexQuery) => {
    const items = (database.get(query.project_id ?? "") ?? []).map((item) => ({ ...item, values: { ...item.values } }));
    return { items, total: items.length, limit: query.limit, offset: 0 };
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container.remove();
});

interface LoadState {
  activeProjectId: string;
  loading: boolean;
  records: ProjectRecord[];
  recordTotal: number;
  loadedRecordCount: number;
  selectProject: (id: string) => Promise<void> | void;
  loadRecords: (
    projectId?: string,
    options?: { showLoading?: boolean; preferCache?: boolean; preserveHistory?: boolean },
  ) => Promise<boolean>;
}

async function mountLedger(): Promise<LoadState> {
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ ...LedgerView, render: () => null });
  app.mount(container);
  const state = (app._instance as unknown as { setupState: LoadState }).setupState;
  await vi.waitFor(() => {
    expect(state.activeProjectId).toBe("A");
    expect(state.loading).toBe(false);
  });
  return state;
}

describe("ledger loadRecords caching and project switching", () => {
  it("serves a preferCache reload from the cache without hitting the API", async () => {
    const state = await mountLedger();
    const callsAfterMount = mocks.queryRecords.mock.calls.length;

    const ok = await state.loadRecords("A", { showLoading: false, preferCache: true, preserveHistory: true });
    expect(ok).toBe(true);
    expect(state.records.map((row) => row.id)).toEqual(["a1", "a2"]);
    expect(mocks.queryRecords.mock.calls.length).toBe(callsAfterMount);
  });

  it("invalidates cached records after a record mutation and refetches", async () => {
    const state = await mountLedger();
    database.get("A")![0]!.values["A-note"] = "changed server-side";

    // 没有 preferCache 的普通加载走网络,取到新值。
    await state.loadRecords("A", { showLoading: false, preserveHistory: true });
    expect(state.records[0]!.values["A-note"]).toBe("changed server-side");
  });

  it("does not leak project A's records into project B on switch", async () => {
    const state = await mountLedger();
    state.selectProject("B");
    await vi.waitFor(() => expect(state.records.map((row) => row.id)).toEqual(["b1"]));
    expect(state.recordTotal).toBe(1);

    // 切回 A:记录恢复,且 B 的行不会残留在 A 的视图里。
    state.selectProject("A");
    await vi.waitFor(() => expect(state.records.map((row) => row.id)).toEqual(["a1", "a2"]));
  });

  it("clears records and totals when loading an empty project id", async () => {
    const state = await mountLedger();
    const ok = await state.loadRecords("", { showLoading: false, preserveHistory: true });
    expect(ok).toBe(true);
    expect(state.records).toEqual([]);
    expect(state.recordTotal).toBe(0);
    expect(state.loadedRecordCount).toBe(0);
  });
});
