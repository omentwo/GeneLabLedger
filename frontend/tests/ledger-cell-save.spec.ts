import { createApp, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSetting } from "@/api/system";
import type {
  FieldDefinition,
  Project,
  ProjectRecord,
  RecordCellUpdateResult,
  RecordComplexQuery,
} from "@/types/api";
import LedgerView from "@/views/LedgerView.vue";

const mocks = vi.hoisted(() => ({
  store: {
    projects: [] as Project[],
    bootstrap: vi.fn(async () => undefined),
    projectById: (id: string): Project | undefined => mocks.store.projects.find((project) => project.id === id),
  },
  queryRecords: vi.fn(),
  updateRecordCell: vi.fn(),
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
  updateRecordCell: mocks.updateRecordCell,
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
    data_type: systemKey === "experiment_date" ? "date" : "text",
    system_key: systemKey, is_core: systemKey !== null,
    hidden: false, sort_order: 0, width: 120, options: [],
  };
}

const noteField: FieldDefinition = field("A", "note", null);
const edateField: FieldDefinition = field("A", "edate", "experiment_date");

function record(projectId: string, id: string, note: string): ProjectRecord {
  return {
    id, project_id: projectId, project_name: projectId, position: 1,
    pathology_number: id, block_number: null, status: "待实验", experiment_date: null,
    experiment_number: null, report_generated: false, locked: false,
    highlight_color: null, values: { [`${projectId}-note`]: note }, created_at: "", updated_at: "",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 模拟服务端：按载荷更新数据库里的记录并返回刷新后的记录。 */
function applyCellUpdate(recordId: string, fieldId: string, value: string): RecordCellUpdateResult {
  const list = [...database.values()].flat();
  const stored = list.find((item) => item.id === recordId);
  if (!stored) throw new Error(`unknown record ${recordId}`);
  const updated: ProjectRecord = {
    ...stored,
    experiment_date: fieldId === edateField.id ? value : stored.experiment_date,
    values: fieldId === edateField.id
      ? { ...stored.values }
      : { ...stored.values, [fieldId]: value },
  };
  stored.experiment_date = updated.experiment_date;
  stored.values = updated.values;
  return {
    record: updated,
    change: { record_id: recordId, field_id: fieldId, before: "", after: value },
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
    fields: [field(id, "pathology", "pathology_number"), field(id, "note", null), field(id, "edate", "experiment_date")],
  }));
  database = new Map([
    ["A", [record("A", "a1", "note-a1"), record("A", "a2", "note-a2")]],
    ["B", [record("B", "b1", "note-b1")]],
  ]);
  mocks.queryRecords.mockImplementation(async (query: RecordComplexQuery) => {
    const items = (database.get(query.project_id ?? "") ?? []).map((item) => ({ ...item, values: { ...item.values } }));
    return { items, total: items.length, limit: query.limit, offset: 0 };
  });
  mocks.updateRecordCell.mockImplementation(
    async (recordId: string, payload: { field_id: string; value: string }) =>
      applyCellUpdate(recordId, payload.field_id, payload.value),
  );
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container.remove();
});

interface CellSaveState {
  records: ProjectRecord[];
  savingIds: Set<string>;
  ledgerFilters: Record<string, unknown>;
  ledgerHistory: { canUndo: { value: boolean } };
  setValue: (record: ProjectRecord, field: FieldDefinition, value: string) => void;
  saveField: (record: ProjectRecord, field: FieldDefinition) => Promise<boolean>;
  hasDirtyLedgerChanges: () => boolean;
  loadRecords: (
    projectId?: string,
    options?: {
      showLoading?: boolean;
      preserveHistory?: boolean;
      deferForPendingEdits?: boolean;
      preferCache?: boolean;
    },
  ) => Promise<boolean>;
}

async function mountLedger(): Promise<CellSaveState> {
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ ...LedgerView, render: () => null });
  app.mount(container);
  const state = (app._instance as unknown as { setupState: CellSaveState }).setupState;
  await vi.waitFor(() => {
    expect(state.records.map((row) => row.id)).toEqual(["a1", "a2"]);
  });
  return state;
}

describe("ledger single-cell save pipeline", () => {
  it("sends the normalized date as the payload while the cell shows the same value", async () => {
    const state = await mountLedger();
    state.setValue(state.records[0]!, edateField, "2026/7/5");

    const ok = await state.saveField(state.records[0]!, edateField);

    expect(ok).toBe(true);
    expect(mocks.updateRecordCell).toHaveBeenCalledTimes(1);
    expect(mocks.updateRecordCell.mock.calls[0]?.[1]).toMatchObject({
      field_id: edateField.id,
      value: "2026-07-05",
    });
    expect(state.records[0]?.experiment_date).toBe("2026-07-05");
    expect(mocks.message.error).not.toHaveBeenCalled();
  });

  it("blocks deferred reloads while a dirty row is filtered out of the view", async () => {
    const state = await mountLedger();
    state.setValue(state.records[0]!, noteField, "dirty-value");

    // 纯本地筛选：把脏行筛出视图，编辑仍在 records 中。
    state.ledgerFilters = { [noteField.id]: { kind: "text", value: "nomatch" } };
    expect(state.hasDirtyLedgerChanges()).toBe(true);

    const ok = await state.loadRecords("A", {
      showLoading: false, preserveHistory: true, deferForPendingEdits: true,
    });
    expect(ok).toBe(false);
    expect(state.records[0]?.values[noteField.id]).toBe("dirty-value");

    // 值回到原值后闸门放行，刷新正常执行。
    state.setValue(state.records[0]!, noteField, "note-a1");
    expect(state.hasDirtyLedgerChanges()).toBe(false);
    expect(await state.loadRecords("A", {
      showLoading: false, preserveHistory: true, deferForPendingEdits: true,
    })).toBe(true);
  });

  it("keeps the newer local edit when a stale save response arrives", async () => {
    const state = await mountLedger();
    const first = deferred<RecordCellUpdateResult>();
    const second = deferred<RecordCellUpdateResult>();
    mocks.updateRecordCell.mockImplementationOnce(() => first.promise);
    mocks.updateRecordCell.mockImplementationOnce(() => second.promise);

    state.setValue(state.records[0]!, noteField, "v1");
    const firstSave = state.saveField(state.records[0]!, noteField);
    state.setValue(state.records[0]!, noteField, "v2");

    first.resolve(applyCellUpdate("a1", noteField.id, "v1"));
    await firstSave;
    // 旧响应到达时不覆盖新编辑：本地仍是 v2，且自动重存带着 v2。
    expect(state.records[0]?.values[noteField.id]).toBe("v2");
    await vi.waitFor(() => expect(mocks.updateRecordCell.mock.calls.length).toBe(2));
    expect(mocks.updateRecordCell.mock.calls[1]?.[1]).toMatchObject({
      field_id: noteField.id,
      value: "v2",
    });

    second.resolve(applyCellUpdate("a1", noteField.id, "v2"));
    await vi.waitFor(() => expect(state.savingIds.has("a1")).toBe(false));
    expect(state.records[0]?.values[noteField.id]).toBe("v2");
  });

  it("keeps the record in savingIds until every queued save completes", async () => {
    const state = await mountLedger();
    const first = deferred<RecordCellUpdateResult>();
    const second = deferred<RecordCellUpdateResult>();
    mocks.updateRecordCell.mockImplementationOnce(() => first.promise);
    mocks.updateRecordCell.mockImplementationOnce(() => second.promise);

    state.setValue(state.records[0]!, noteField, "v1");
    const firstSave = state.saveField(state.records[0]!, noteField);
    state.setValue(state.records[0]!, edateField, "2026-07-05");
    const secondSave = state.saveField(state.records[0]!, edateField);
    expect(state.savingIds.has("a1")).toBe(true);

    first.resolve(applyCellUpdate("a1", noteField.id, "v1"));
    await firstSave;
    // 第一格保存完成时第二格仍在途：saving 标记必须保留（引用计数）。
    expect(state.savingIds.has("a1")).toBe(true);

    second.resolve(applyCellUpdate("a1", edateField.id, "2026-07-05"));
    await secondSave;
    expect(state.savingIds.has("a1")).toBe(false);
  });

  it("still records undo history when a save completes after a reload", async () => {
    const state = await mountLedger();
    const first = deferred<RecordCellUpdateResult>();
    mocks.updateRecordCell.mockImplementationOnce(() => first.promise);

    state.setValue(state.records[0]!, noteField, "v1");
    const firstSave = state.saveField(state.records[0]!, noteField);
    await state.loadRecords("A", { showLoading: false, preserveHistory: true });
    expect(state.ledgerHistory.canUndo.value).toBe(false);

    first.resolve(applyCellUpdate("a1", noteField.id, "v1"));
    await firstSave;
    // 重载清空了保存状态，但在途保存的版本必须保留，否则完成路径
    // 判定过期而跳过撤销历史（服务端已写入而撤销栈缺失）。
    await vi.waitFor(() => expect(state.ledgerHistory.canUndo.value).toBe(true));
    expect(state.records[0]?.values[noteField.id]).toBe("v1");
  });

  it("serves the updated value from cache after a single-cell save", async () => {
    const state = await mountLedger();
    const callsBefore = mocks.queryRecords.mock.calls.length;

    state.setValue(state.records[0]!, noteField, "cached-value");
    await state.saveField(state.records[0]!, noteField);

    const ok = await state.loadRecords("A", {
      showLoading: false, preferCache: true, preserveHistory: true,
    });
    expect(ok).toBe(true);
    expect(state.records[0]?.values[noteField.id]).toBe("cached-value");
    expect(mocks.queryRecords.mock.calls.length).toBe(callsBefore);
  });
});
