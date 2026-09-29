import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FieldDefinition,
  Project,
  ProjectRecord,
  RecordBatchNewRecord,
  RecordCellBatchCommitResult,
  RecordCellBatchPreview,
  RecordCellChange,
  RecordComplexQuery,
} from "@/types/api";
import type { LedgerRow } from "@/utils/ledgerTableView";
import LedgerView from "@/views/LedgerView.vue";

const mocks = vi.hoisted(() => ({
  store: {
    projects: [] as Project[],
    bootstrap: vi.fn(async () => undefined),
    projectById: (id: string): Project | undefined => mocks.store.projects.find((project) => project.id === id),
  },
  queryRecords: vi.fn(),
  previewCellBatch: vi.fn(),
  commitCellBatch: vi.fn(),
  createRecord: vi.fn(),
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
  previewCellBatch: mocks.previewCellBatch,
  commitCellBatch: mocks.commitCellBatch,
  createRecord: mocks.createRecord,
  validateNewRecord: vi.fn(async () => ({ issues: [] })),
}));
vi.mock("@/api/system", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/system")>(),
  getSetting: vi.fn(async () => ({ value: null })),
}));
vi.mock("@/api/preview", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/preview")>(),
  getPreviewCapabilities: vi.fn(async () => ({ native_preview: false })),
}));
vi.mock("@/utils/desktop", () => ({ desktopBridge: () => undefined }));

type Position = { rowIndex: number; columnIndex: number };
interface LedgerState {
  activeProjectId: string;
  records: ProjectRecord[];
  draftRows: LedgerRow[];
  fields: FieldDefinition[];
  loading: boolean;
  recordTotal: number;
  validationPanel: unknown;
  cellSaveStates: Map<string, { status: string }>;
  editingGridCell: Position | null;
  editingGridSnapshot: { rowId: string; fieldId: string; value: string } | null;
  appendDraftRow: (scroll?: boolean) => void;
  selectProject: (id: string) => void;
  setValue: (record: ProjectRecord, field: FieldDefinition, value: string) => void;
  saveField: (record: LedgerRow, field: FieldDefinition) => Promise<boolean>;
  finishGridCellEdit: (commit?: boolean, focusAfter?: boolean) => Promise<boolean>;
  pasteGrid: (
    event: null, row: number, column: number,
    cells: Array<{ rowOffset: number; columnOffset: number; value: string }>,
  ) => Promise<Position[]>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function clone(record: ProjectRecord): ProjectRecord {
  return { ...record, values: { ...record.values } };
}

function field(projectId: string, key: string, systemKey: string | null): FieldDefinition {
  return {
    id: `${projectId}-${key}`, project_id: projectId, key, label: key,
    data_type: "text", system_key: systemKey, is_core: systemKey !== null,
    hidden: false, sort_order: 0, width: 120, options: [],
  };
}

function record(projectId: string, id: string): ProjectRecord {
  return {
    id, project_id: projectId, project_name: projectId, position: 1,
    pathology_number: id, block_number: null, status: "待实验", experiment_date: null,
    experiment_number: null, report_generated: false, locked: false,
    highlight_color: null, values: {}, created_at: "", updated_at: "",
  };
}

let app: App | undefined;
let container: HTMLDivElement;
let database: Map<string, ProjectRecord[]>;
let previews: Map<string, { projectId: string; changes: RecordCellChange[]; newRecords: RecordBatchNewRecord[] }>;
let previewSequence: number;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.store.projects = ["A", "B"].map((id) => ({
    id, name: id, sort_order: 0, experiment_enabled: true,
    duplicate_pathology_warning_enabled: true,
    fields: [field(id, "pathology", "pathology_number"), field(id, "block", "block_number"), field(id, "note", null)],
  }));
  database = new Map([["A", []], ["B", [record("B", "record-B")]]]);
  previews = new Map();
  previewSequence = 0;
  mocks.queryRecords.mockImplementation(async (query: RecordComplexQuery) => {
    const items = (database.get(query.project_id ?? "") ?? []).map(clone);
    return { items, total: items.length, limit: query.limit, offset: 0 };
  });
  mocks.previewCellBatch.mockImplementation(async (
    projectId: string, changes: RecordCellChange[], newRecords: RecordBatchNewRecord[] = [],
  ): Promise<RecordCellBatchPreview> => {
    const token = String(++previewSequence);
    previews.set(token, {
      projectId,
      changes: changes.map((change) => ({ ...change })),
      newRecords: newRecords.map((item) => ({ ...item, values: { ...item.values } })),
    });
    return { token, affected_count: changes.length + newRecords.length, skipped_locked: 0, issues: [], expires_at: "" };
  });
  mocks.commitCellBatch.mockImplementation(async (token: string): Promise<RecordCellBatchCommitResult> => {
    const preview = previews.get(token)!;
    const rows = database.get(preview.projectId)!;
    const before = preview.changes.map((change) => clone(rows.find((row) => row.id === change.record_id)!));
    const created = preview.newRecords.map((item, index) => ({
      ...record(preview.projectId, `created-${token}-${index}`), ...item,
      values: { ...item.values },
    }));
    rows.push(...created);
    for (const change of preview.changes) {
      const row = rows.find((item) => item.id === change.record_id)!;
      const definition = mocks.store.projectById(preview.projectId)!.fields.find((item) => item.id === change.field_id)!;
      if (definition.system_key === "pathology_number") row.pathology_number = change.value;
      else if (definition.system_key === "block_number") row.block_number = change.value || null;
      else row.values[change.field_id] = change.value;
    }
    const changedIds = new Set([...preview.changes.map((change) => change.record_id), ...created.map((row) => row.id)]);
    const after = rows.filter((row) => changedIds.has(row.id)).map(clone);
    return {
      records: after, created_record_ids: created.map((row) => row.id),
      skipped_locked: 0,
      changes: preview.changes.map((change) => ({ ...change, before: change.expected_value ?? "", after: change.value })),
      before, after,
    };
  });
  mocks.createRecord.mockImplementation(async () => record("A", "unexpected-create"));
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container?.remove();
});

async function mountLedger(): Promise<LedgerState> {
  container = document.createElement("div");
  document.body.append(container);
  // Execute the real setup, watchers and save flows without rendering the virtual table.
  app = createApp({ ...LedgerView, render: () => null });
  app.mount(container);
  const state = (app._instance as unknown as { setupState: LedgerState }).setupState;
  await vi.waitFor(() => {
    expect(state.activeProjectId).toBe("A");
    expect(mocks.queryRecords).toHaveBeenCalled();
    expect(state.loading).toBe(false);
  });
  return state;
}

function pauseRequest(mock: typeof mocks.commitCellBatch) {
  const pending = deferred<void>();
  const perform = mock.getMockImplementation()!;
  mock.mockImplementationOnce(async (...args: unknown[]) => {
    await pending.promise;
    return perform(...args);
  });
  return pending;
}

function pasteNewRecord(state: LedgerState) {
  state.appendDraftRow(false);
  return state.pasteGrid(null, 0, 0, [
    { rowOffset: 0, columnOffset: 0, value: "REVIEW-001" },
    { rowOffset: 0, columnOffset: 2, value: "old" },
  ]);
}

describe("ledger paste requests", () => {
  it.each(["preview", "commit"])("keeps project B intact when project A's %s finishes after a switch", async (phase) => {
    const state = await mountLedger();
    const pending = pauseRequest(phase === "preview" ? mocks.previewCellBatch : mocks.commitCellBatch);
    const paste = pasteNewRecord(state);
    await vi.waitFor(() => expect(phase === "preview" ? mocks.previewCellBatch : mocks.commitCellBatch).toHaveBeenCalled());
    state.selectProject("B");
    await vi.waitFor(() => expect(state.records.map((row) => row.id)).toEqual(["record-B"]));
    pending.resolve();
    await paste;
    expect(state.activeProjectId).toBe("B");
    expect(state.records.map((row) => row.id)).toEqual(["record-B"]);
    expect(state.recordTotal).toBe(1);
    expect(state.draftRows).toEqual([]);
    expect(state.validationPanel).toBeNull();
  });

  it.each(["preview", "commit"])("preserves and saves draft edits made during %s", async (phase) => {
    const state = await mountLedger();
    const pending = pauseRequest(phase === "preview" ? mocks.previewCellBatch : mocks.commitCellBatch);
    const paste = pasteNewRecord(state);
    await vi.waitFor(() => expect(phase === "preview" ? mocks.previewCellBatch : mocks.commitCellBatch).toHaveBeenCalled());
    const draft = state.draftRows[0]!;
    state.setValue(draft, state.fields[2]!, "new");
    await state.saveField(draft, state.fields[2]!);
    state.setValue(draft, state.fields[1]!, "block-2");
    await state.saveField(draft, state.fields[1]!);
    pending.resolve();
    await paste;
    await vi.waitFor(() => {
      expect(database.get("A")![0]!.values["A-note"]).toBe("new");
      expect(database.get("A")![0]!.block_number).toBe("block-2");
    });
    expect(state.records[0]!.values["A-note"]).toBe("new");
    expect(state.records[0]!.block_number).toBe("block-2");
    expect(state.draftRows).toEqual([]);
    expect(database.get("A")).toHaveLength(1);
  });

  it("keeps an active editor attached to the new UUID after preserving its draft value", async () => {
    const state = await mountLedger();
    const pending = pauseRequest(mocks.commitCellBatch);
    const paste = pasteNewRecord(state);
    await vi.waitFor(() => expect(mocks.commitCellBatch).toHaveBeenCalled());
    const draft = state.draftRows[0]!;
    state.editingGridCell = { rowIndex: 0, columnIndex: 2 };
    state.editingGridSnapshot = { rowId: draft.id, fieldId: "A-note", value: "old" };
    state.setValue(draft, state.fields[2]!, "new");
    pending.resolve();
    await paste;
    expect(state.editingGridSnapshot?.rowId).toBe(state.records[0]!.id);
    expect(state.editingGridCell).toEqual({ rowIndex: 0, columnIndex: 2 });
    expect(state.records[0]!.values["A-note"]).toBe("new");
    expect(database.get("A")![0]!.values["A-note"]).toBe("old");
    expect(await state.finishGridCellEdit(true, false)).toBe(true);
    expect(database.get("A")![0]!.values["A-note"]).toBe("new");
    expect(state.editingGridSnapshot).toBeNull();
  });

  it.each(["error", "warning"] as const)("does not show project A's %s in project B", async (severity) => {
    const state = await mountLedger();
    const pending = deferred<void>();
    const perform = mocks.previewCellBatch.getMockImplementation()!;
    mocks.previewCellBatch.mockImplementationOnce(async (...args: unknown[]) => {
      const preview = await perform(...args) as RecordCellBatchPreview;
      await pending.promise;
      return { ...preview, issues: [{ record_id: "", field_id: "A-pathology", severity, message: "validation" }] };
    });
    const paste = pasteNewRecord(state);
    state.selectProject("B");
    await vi.waitFor(() => expect(state.records[0]?.id).toBe("record-B"));
    pending.resolve();
    expect(await paste).toEqual([]);
    expect(state.validationPanel).toBeNull();
    expect(mocks.commitCellBatch).not.toHaveBeenCalled();
  });

  it.each(["error", "warning"] as const)("clears an existing %s panel when leaving its project", async (severity) => {
    const state = await mountLedger();
    mocks.previewCellBatch.mockResolvedValueOnce({
      token: "validation", affected_count: 1, skipped_locked: 0, expires_at: "",
      issues: [{ record_id: "", field_id: "A-pathology", severity, message: "validation" }],
    } satisfies RecordCellBatchPreview);
    await pasteNewRecord(state);
    expect(state.validationPanel).toMatchObject({ projectId: "A" });
    state.selectProject("B");
    await vi.waitFor(() => expect(state.records[0]?.id).toBe("record-B"));
    expect(state.validationPanel).toBeNull();
    expect(mocks.commitCellBatch).not.toHaveBeenCalled();
  });

  it("keeps a later draft edit visible when its follow-up save fails validation", async () => {
    const state = await mountLedger();
    const pending = pauseRequest(mocks.commitCellBatch);
    const paste = pasteNewRecord(state);
    await vi.waitFor(() => expect(mocks.commitCellBatch).toHaveBeenCalled());
    state.setValue(state.draftRows[0]!, state.fields[2]!, "invalid-later-value");
    mocks.previewCellBatch.mockResolvedValueOnce({
      token: "invalid", affected_count: 1, skipped_locked: 0, expires_at: "",
      issues: [{ record_id: "created-1-0", field_id: "A-note", severity: "error", message: "invalid value" }],
    } satisfies RecordCellBatchPreview);
    pending.resolve();
    await paste;
    expect(database.get("A")![0]!.values["A-note"]).toBe("old");
    expect(state.records[0]!.values["A-note"]).toBe("invalid-later-value");
    expect(state.cellSaveStates.get(`${state.records[0]!.id}:A-note`)?.status).toBe("error");
    expect(state.validationPanel).toMatchObject({ projectId: "A", title: "无法保存" });
  });

  it("does not create the draft twice when its pathology number changes during commit", async () => {
    const state = await mountLedger();
    const pending = pauseRequest(mocks.commitCellBatch);
    const paste = pasteNewRecord(state);
    await vi.waitFor(() => expect(mocks.commitCellBatch).toHaveBeenCalled());
    const draft = state.draftRows[0]!;
    state.setValue(draft, state.fields[0]!, "REVIEW-002");
    await state.saveField(draft, state.fields[0]!);
    expect(mocks.createRecord).not.toHaveBeenCalled();
    pending.resolve();
    await paste;
    await vi.waitFor(() => expect(database.get("A")![0]!.pathology_number).toBe("REVIEW-002"));
    expect(database.get("A")).toHaveLength(1);
  });

  it("does not reconcile a response into a newly loaded visit to the same project", async () => {
    const state = await mountLedger();
    const pending = pauseRequest(mocks.commitCellBatch);
    const paste = pasteNewRecord(state);
    await vi.waitFor(() => expect(mocks.commitCellBatch).toHaveBeenCalled());
    state.selectProject("B");
    await vi.waitFor(() => expect(state.records[0]?.id).toBe("record-B"));
    state.selectProject("A");
    await vi.waitFor(() => expect(state.records).toEqual([]));
    pending.resolve();
    await paste;
    expect(state.records).toEqual([]);
    expect(state.recordTotal).toBe(0);
    await nextTick();
  });
});
