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
  writeClipboardText: vi.fn(),
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
  activeGridCell: Position | null;
  selectedGridCellKeys: Set<string>;
  gridCutInProgress: boolean;
  ledgerContextMenu: {
    x: number; y: number; submenuLeft: boolean;
    target: { kind: "cell"; rowId: string; fieldId: string };
  } | null;
  appendDraftRow: (scroll?: boolean) => void;
  selectProject: (id: string) => void;
  setValue: (record: ProjectRecord, field: FieldDefinition, value: string) => void;
  saveField: (record: LedgerRow, field: FieldDefinition) => Promise<boolean>;
  finishGridCellEdit: (commit?: boolean, focusAfter?: boolean) => Promise<boolean>;
  selectGridCell: (position: Position) => void;
  replaceGridCellSelection: (positions: Position[], active: Position) => void;
  handleGridKeydown: (event: KeyboardEvent) => void;
  handleGridCut: (event: ClipboardEvent) => void;
  handleGridPaste: (event: ClipboardEvent) => void;
  contextCut: () => Promise<void>;
  cancelValidationPanel: () => void;
  undoLedger: () => Promise<void>;
  redoLedger: () => Promise<void>;
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
  vi.unstubAllGlobals();
});

function cellTarget(state: LedgerState, position?: Position): HTMLDivElement {
  const target = document.createElement("div");
  if (position) {
    target.dataset.rowId = state.records[position.rowIndex]!.id;
    target.dataset.fieldIndex = String(position.columnIndex);
  }
  target.addEventListener("keydown", state.handleGridKeydown);
  target.addEventListener("cut", state.handleGridCut as EventListener);
  target.addEventListener("paste", state.handleGridPaste as EventListener);
  container.append(target);
  return target;
}

function cutKey(target: HTMLElement, init: KeyboardEventInit = { ctrlKey: true }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function clipboardEvent(type: "cut" | "paste", contents: Map<string, string> = new Map()) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  const setData = vi.fn((format: string, value: string) => { contents.set(format, value); });
  Object.defineProperty(event, "clipboardData", {
    value: { setData, getData: (format: string) => contents.get(format) ?? "" },
  });
  return { event, contents, setData };
}

function openCutMenu(state: LedgerState, position: Position): void {
  state.selectGridCell(position);
  state.ledgerContextMenu = {
    x: 0, y: 0, submenuLeft: false,
    target: { kind: "cell", rowId: state.records[position.rowIndex]!.id, fieldId: state.fields[position.columnIndex]!.id },
  };
}

describe("ledger cut", () => {
  beforeEach(() => {
    const source = record("A", "cut-source");
    source.values["A-note"] = "source note";
    source.block_number = "source block";
    const target = record("A", "cut-target");
    target.position = 2;
    target.values["A-note"] = "target note";
    target.block_number = "target block";
    database.set("A", [source, target]);
    database.get("B")![0]!.values["B-note"] = "project B note";
    mocks.writeClipboardText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText: mocks.writeClipboardText },
      userAgent: navigator.userAgent, platform: navigator.platform,
    });
    vi.stubGlobal("ClipboardItem", undefined);
  });

  it.each([
    { name: "Ctrl+X", init: { ctrlKey: true } },
    { name: "Cmd+X", init: { metaKey: true } },
    { name: "the physical X key with another keyboard layout", init: { key: "ч", code: "KeyX", ctrlKey: true } },
  ])("cuts and supports undo/redo with $name", async ({ init }) => {
    const state = await mountLedger();
    const position = { rowIndex: 0, columnIndex: 2 };
    state.selectGridCell(position);
    expect(cutKey(cellTarget(state, position), init).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(database.get("A")![0]!.values["A-note"]).toBe(""));
    expect(mocks.writeClipboardText).toHaveBeenCalledWith("source note");
    expect(state.records[0]!.values["A-note"]).toBe("");
    await state.undoLedger();
    expect(database.get("A")![0]!.values["A-note"]).toBe("source note");
    await state.redoLedger();
    expect(database.get("A")![0]!.values["A-note"]).toBe("");
  });

  it("uses the native cut event and preserves sparse selection clipboard data", async () => {
    const state = await mountLedger();
    const positions = [{ rowIndex: 0, columnIndex: 2 }, { rowIndex: 1, columnIndex: 1 }];
    state.replaceGridCellSelection(positions, positions[0]!);
    const { event, contents } = clipboardEvent("cut");
    cellTarget(state, positions[0]).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(database.get("A")![0]!.values["A-note"]).toBe(""));
    expect(contents.get("text/plain")).toBe("\tsource note\ntarget block\t");
    expect(JSON.parse(contents.get("application/x-gene-lab-ledger-cells")!)).toEqual({
      version: 1, cells: [
        { rowOffset: 0, columnOffset: 1, value: "source note" },
        { rowOffset: 1, columnOffset: 0, value: "target block" },
      ],
    });
    expect(database.get("A")![1]!.block_number).toBeNull();
    expect(database.get("A")![1]!.values["A-note"]).toBe("target note");
    expect(mocks.writeClipboardText).not.toHaveBeenCalled();
  });

  it("cuts the original cells if selection changes while the clipboard write is pending", async () => {
    const state = await mountLedger();
    const pending = deferred<void>();
    mocks.writeClipboardText.mockImplementationOnce(() => pending.promise);
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    const cut = state.contextCut();
    state.selectGridCell({ rowIndex: 1, columnIndex: 2 });
    pending.resolve();
    await cut;
    expect(database.get("A")![0]!.values["A-note"]).toBe("");
    expect(database.get("A")![1]!.values["A-note"]).toBe("target note");
    expect(state.activeGridCell).toEqual({ rowIndex: 1, columnIndex: 2 });
  });

  it("cancels clearing after a project switch during the clipboard write", async () => {
    const state = await mountLedger();
    const pending = deferred<void>();
    mocks.writeClipboardText.mockImplementationOnce(() => pending.promise);
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    const cut = state.contextCut();
    state.selectProject("B");
    await vi.waitFor(() => expect(state.records[0]?.id).toBe("record-B"));
    state.selectGridCell({ rowIndex: 0, columnIndex: 2 });
    pending.resolve();
    await cut;
    expect(database.get("A")![0]!.values["A-note"]).toBe("source note");
    expect(database.get("B")![0]!.values["B-note"]).toBe("project B note");
    expect(mocks.previewCellBatch).not.toHaveBeenCalled();
  });

  it("keeps edits made to the source while the clipboard write is pending", async () => {
    const state = await mountLedger();
    const pending = deferred<void>();
    mocks.writeClipboardText.mockImplementationOnce(() => pending.promise);
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    const cut = state.contextCut();
    state.setValue(state.records[0]!, state.fields[2]!, "later edit");
    pending.resolve();
    await cut;
    expect(state.records[0]!.values["A-note"]).toBe("later edit");
    expect(database.get("A")![0]!.values["A-note"]).toBe("source note");
    expect(mocks.previewCellBatch).not.toHaveBeenCalled();
  });

  it("keeps native text cutting inside an active cell editor", async () => {
    const state = await mountLedger();
    const position = { rowIndex: 0, columnIndex: 2 };
    state.selectGridCell(position);
    state.editingGridCell = position;
    state.editingGridSnapshot = { rowId: "cut-source", fieldId: "A-note", value: "source note" };
    const target = cellTarget(state, position);
    const input = document.createElement("textarea");
    target.append(input);
    expect(cutKey(input).defaultPrevented).toBe(false);
    const { event } = clipboardEvent("cut");
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(mocks.writeClipboardText).not.toHaveBeenCalled();
    expect(mocks.previewCellBatch).not.toHaveBeenCalled();
    expect(state.records[0]!.values["A-note"]).toBe("source note");
  });

  it("cuts a selected range when focus is on the table rather than a cell", async () => {
    const state = await mountLedger();
    state.selectGridCell({ rowIndex: 0, columnIndex: 2 });
    expect(cutKey(cellTarget(state)).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(database.get("A")![0]!.values["A-note"]).toBe(""));
  });

  it("preserves source values when clipboard permission is denied", async () => {
    const state = await mountLedger();
    mocks.writeClipboardText.mockRejectedValueOnce(new Error("denied"));
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    await state.contextCut();
    expect(database.get("A")![0]!.values["A-note"]).toBe("source note");
    expect(state.records[0]!.values["A-note"]).toBe("source note");
    expect(mocks.previewCellBatch).not.toHaveBeenCalled();
    expect(mocks.message.warning).toHaveBeenCalledWith(expect.stringContaining("原内容已保留"));
    expect(state.gridCutInProgress).toBe(false);
  });

  it("falls back to plain text when custom clipboard MIME is unsupported", async () => {
    const state = await mountLedger();
    const write = vi.fn(async () => { throw new Error("unsupported MIME"); });
    vi.stubGlobal("ClipboardItem", class { constructor(public readonly data: Record<string, Blob>) {} });
    vi.stubGlobal("navigator", { clipboard: { write, writeText: mocks.writeClipboardText } });
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    await state.contextCut();
    expect(write).toHaveBeenCalledOnce();
    expect(mocks.writeClipboardText).toHaveBeenCalledWith("source note");
    expect(database.get("A")![0]!.values["A-note"]).toBe("");
  });

  it("keeps the source when writing the native cut clipboard fails", async () => {
    const state = await mountLedger();
    const position = { rowIndex: 0, columnIndex: 2 };
    state.selectGridCell(position);
    const { event, setData } = clipboardEvent("cut");
    setData.mockImplementation(() => { throw new Error("clipboard failure"); });
    cellTarget(state, position).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(database.get("A")![0]!.values["A-note"]).toBe("source note");
    expect(mocks.previewCellBatch).not.toHaveBeenCalled();
    expect(mocks.message.warning).toHaveBeenCalledWith(expect.stringContaining("原内容已保留"));
  });

  it("preserves locked cells, pathology numbers and status in a mixed selection", async () => {
    database.get("A")![1]!.locked = true;
    mocks.store.projectById("A")!.fields.push(field("A", "status", "status"));
    const state = await mountLedger();
    const noteColumn = state.fields.findIndex((item) => item.id === "A-note");
    const positions = [...state.fields.map((_, columnIndex) => ({ rowIndex: 0, columnIndex })),
      { rowIndex: 1, columnIndex: noteColumn }];
    state.replaceGridCellSelection(positions, positions[0]!);
    cutKey(cellTarget(state, positions[0]));
    await vi.waitFor(() => expect(state.gridCutInProgress).toBe(false));
    const [source, locked] = database.get("A")!;
    expect(source!.pathology_number).toBe("cut-source");
    expect(source!.status).toBe("待实验");
    expect(source!.block_number).toBeNull();
    expect(source!.values["A-note"]).toBe("");
    expect(locked!.values["A-note"]).toBe("target note");
    const changes = mocks.previewCellBatch.mock.calls[0]![1] as RecordCellChange[];
    expect(changes.map((change) => change.field_id)).toEqual(["A-block", "A-note"]);
    expect(mocks.message.info).toHaveBeenCalledWith(expect.stringContaining("锁定"));
    expect(mocks.message.info).toHaveBeenCalledWith(expect.stringContaining("病理号或状态"));
  });

  it("allows cut content to be pasted to another cell using the existing paste handler", async () => {
    const state = await mountLedger();
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    await state.contextCut();
    const position = { rowIndex: 1, columnIndex: 2 };
    state.selectGridCell(position);
    const { event } = clipboardEvent("paste", new Map([["text/plain", "source note"]]));
    cellTarget(state, position).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(database.get("A")![1]!.values["A-note"]).toBe("source note"));
    expect(database.get("A")![0]!.values["A-note"]).toBe("");
  });

  it("does not repeat a cut while its clipboard request is pending or the X key is held", async () => {
    const state = await mountLedger();
    const pending = deferred<void>();
    mocks.writeClipboardText.mockImplementationOnce(() => pending.promise);
    const position = { rowIndex: 0, columnIndex: 2 };
    state.selectGridCell(position);
    const target = cellTarget(state, position);
    cutKey(target);
    cutKey(target);
    cutKey(target, { ctrlKey: true, repeat: true });
    expect(mocks.writeClipboardText).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.waitFor(() => expect(state.gridCutInProgress).toBe(false));
    cutKey(target, { ctrlKey: true, repeat: true });
    expect(mocks.writeClipboardText).toHaveBeenCalledOnce();
    expect(mocks.commitCellBatch).toHaveBeenCalledOnce();
  });

  it.each(["preview", "commit"])("keeps project B's selection intact after project A's cut %s finishes", async (phase) => {
    const state = await mountLedger();
    const pending = pauseRequest(phase === "preview" ? mocks.previewCellBatch : mocks.commitCellBatch);
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    const cut = state.contextCut();
    await vi.waitFor(() => expect(phase === "preview" ? mocks.previewCellBatch : mocks.commitCellBatch).toHaveBeenCalled());
    state.selectProject("B");
    await vi.waitFor(() => expect(state.records[0]?.id).toBe("record-B"));
    const position = { rowIndex: 0, columnIndex: 1 };
    state.selectGridCell(position);
    pending.resolve();
    await cut;
    expect(state.activeGridCell).toEqual(position);
    expect([...state.selectedGridCellKeys]).toEqual(["record-B\u0000B-block"]);
    expect(state.records[0]!.values["B-note"]).toBe("project B note");
  });

  it("restores the source if a cut warning is cancelled", async () => {
    const state = await mountLedger();
    const perform = mocks.previewCellBatch.getMockImplementation()!;
    mocks.previewCellBatch.mockImplementationOnce(async (...args: unknown[]) => {
      const preview = await perform(...args) as RecordCellBatchPreview;
      return { ...preview, issues: [{ record_id: "cut-source", field_id: "A-note", severity: "warning", message: "warning" }] };
    });
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    await state.contextCut();
    expect(state.validationPanel).toMatchObject({ projectId: "A", label: "剪切台账数据" });
    state.cancelValidationPanel();
    expect(state.records[0]!.values["A-note"]).toBe("source note");
    expect(database.get("A")![0]!.values["A-note"]).toBe("source note");
    expect(mocks.commitCellBatch).not.toHaveBeenCalled();
  });

  it("restores the source after a failed cut commit", async () => {
    const state = await mountLedger();
    mocks.commitCellBatch.mockRejectedValueOnce(new Error("save failed"));
    openCutMenu(state, { rowIndex: 0, columnIndex: 2 });
    await state.contextCut();
    expect(state.records[0]!.values["A-note"]).toBe("source note");
    expect(database.get("A")![0]!.values["A-note"]).toBe("source note");
    expect(state.gridCutInProgress).toBe(false);
    expect(mocks.message.error).toHaveBeenCalledWith("save failed");
  });
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
