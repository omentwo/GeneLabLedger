import { createApp, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldDefinition, Project, ProjectRecord, RecordCellChange, RecordComplexQuery } from "@/types/api";
import type { ClipboardFollowContext, ClipboardFollowEvent } from "@/types/electron";
import type { ClipboardFollowSession } from "@/utils/clipboardFollow";
import type { QuickEntryProjectSettings } from "@/utils/quickEntry";
import QuickEntryView from "@/views/QuickEntryView.vue";

const mocks = vi.hoisted(() => ({
  store: { projects: [] as Project[], bootstrap: vi.fn(async () => undefined),
    reloadProjects: vi.fn(async () => undefined),
    projectById: (id: string): Project | undefined => mocks.store.projects.find((project) => project.id === id) },
  bridge: { windowKind: "quick-entry", clipboardFollowAvailable: true,
    startClipboardFollow: vi.fn(async (_context: ClipboardFollowContext) => ({ sequence: 10 })),
    stopClipboardFollow: vi.fn(async () => undefined), acceptCurrentClipboard: vi.fn(async () => undefined),
    writeInternalClipboard: vi.fn(async () => undefined),
    onClipboardFollowEvent: vi.fn((listener: (event: ClipboardFollowEvent) => void) => {
      mocks.listener = listener; return () => { mocks.listener = undefined; };
    }),
    onQuickEntryOpenRequested: vi.fn(() => () => undefined), onQuickEntryFieldsChanged: vi.fn(() => () => undefined),
    quickEntryReady: vi.fn(async () => undefined), notifyQuickEntryChanged: vi.fn(async () => undefined),
  },
  listener: undefined as ((event: ClipboardFollowEvent) => void) | undefined,
  listRecords: vi.fn(), queryRecords: vi.fn(), quickCreateRecord: vi.fn(),
  previewCellBatch: vi.fn(), commitCellBatch: vi.fn(), getSetting: vi.fn(), putSetting: vi.fn(),
  confirm: vi.fn(async () => undefined),
  message: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@/stores/app", () => ({ useAppStore: () => mocks.store }));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: { project: "p" } }),
  useRouter: () => ({ replace: vi.fn(async () => undefined), push: vi.fn() }) }));
vi.mock("element-plus", () => ({ ElMessage: mocks.message, ElMessageBox: { confirm: mocks.confirm, alert: vi.fn() } }));
vi.mock("@/utils/desktop", () => ({ desktopBridge: () => mocks.bridge }));
vi.mock("@/api/system", () => ({ getSetting: mocks.getSetting, putSetting: mocks.putSetting }));
vi.mock("@/api/records", () => ({ listRecords: mocks.listRecords, queryRecords: mocks.queryRecords,
  quickCreateRecord: mocks.quickCreateRecord, previewCellBatch: mocks.previewCellBatch,
  commitCellBatch: mocks.commitCellBatch, validateNewRecord: vi.fn(async () => ({ issues: [] })) }));

function field(id: string, extra: Partial<FieldDefinition> = {}): FieldDefinition {
  return { id, project_id: "p", key: id, label: id, data_type: "text", system_key: null,
    is_core: false, hidden: false, sort_order: 0, width: 120, options: [], ...extra };
}
function record(id: string, pathology = id, block = "1"): ProjectRecord {
  return { id, project_id: "p", project_name: "p", position: id === "r1" ? 1 : 2,
    pathology_number: pathology, block_number: block, status: "待实验", experiment_date: null,
    experiment_number: null, report_generated: false, locked: false, highlight_color: null,
    values: { name: "", unit: "" }, created_at: "", updated_at: "" };
}
interface QuickState {
  activeRecord: ProjectRecord | null; activeRecordUnavailable: boolean; activeProjectId: string;
  entryValues: Record<string, string>; combinedPathologyInput: string;
  clipboardSession: ClipboardFollowSession; clipboardEnabled: boolean; matchingRecords: ProjectRecord[];
  matchDialogVisible: boolean; fieldSettings: QuickEntryProjectSettings; clipboardFieldDraft: string[];
  bindClipboardRecord: (record: ProjectRecord) => Promise<void>;
  beginClipboardFollow: (resume?: boolean) => Promise<boolean>;
  saveEntry: () => Promise<void>; selectRecord: (record: ProjectRecord) => Promise<void>;
  overwriteClipboardField: () => Promise<void>; undoClipboardField: () => void;
  openFieldSettings: () => void; saveFieldSettings: () => Promise<void>;
  handleCombinedPathologyKeydown: (event: KeyboardEvent) => void;
  loadUnreportedRecords: (projectId: string) => Promise<void>;
}
let app: App | undefined, container: HTMLDivElement;
let rows: ProjectRecord[], changes: RecordCellChange[];
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  rows = [record("r1", "P1"), record("r2", "P2")];
  changes = [];
  mocks.store.projects = [reactive({ id: "p", name: "p", sort_order: 0, fields: [
    field("path", { system_key: "pathology_number", is_core: true }),
    field("block", { system_key: "block_number", is_core: true }), field("name"), field("unit"),
  ] } as Project)];
  mocks.bridge.startClipboardFollow.mockResolvedValue({ sequence: 10 });
  mocks.confirm.mockResolvedValue(undefined);
  mocks.getSetting.mockResolvedValue({ value: { version: 5, projects: { p: {
    selectedFieldIds: ["path", "block", "name", "unit"], clipboardFieldIds: ["name", "unit"], clipboardEnabled: true,
  } } } });
  mocks.putSetting.mockImplementation(async (_key, value) => ({ value }));
  mocks.listRecords.mockImplementation(async () => ({ items: rows.filter((row) => !row.locked && !row.report_generated), total: rows.length }));
  mocks.queryRecords.mockImplementation(async (query: RecordComplexQuery) => {
    const items = rows.filter((row) => query.field_filters.every((filter) =>
      (filter.field_id === "path" ? row.pathology_number : row.block_number) === filter.value));
    return { items, total: items.length };
  });
  mocks.quickCreateRecord.mockImplementation(async () => {
    const created = record("created", "NEW", "2"); rows.push(created); return created;
  });
  mocks.previewCellBatch.mockImplementation(async (_project, nextChanges: RecordCellChange[]) => {
    changes = nextChanges; return { token: "token", issues: [], skipped_locked: 0 };
  });
  mocks.commitCellBatch.mockImplementation(async () => {
    changes.forEach((change) => { rows.find((row) => row.id === change.record_id)!.values[change.field_id] = change.value; });
    return { records: rows.filter((row) => changes.some((change) => change.record_id === row.id)), skipped_locked: 0 };
  });
});
afterEach(() => {
  app?.unmount(); app = undefined; container?.remove();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); await nextTick(); }
async function mount(): Promise<QuickState> {
  container = document.createElement("div"); document.body.append(container);
  app = createApp(QuickEntryView); app.config.warnHandler = () => undefined; app.mount(container);
  await flush();
  return (app._instance as unknown as { setupState: QuickState }).setupState;
}
function copy(state: QuickState, text: string, eventId = 1, context = state.clipboardSession.context!) {
  mocks.listener?.({ ...context, type: "clipboard", text, eventId, sequence: eventId + 10, manual: false });
}

describe("quick-entry clipboard integration", () => {
  it("fills the selected patient draft in order without saving or moving focus", async () => {
    const state = await mount();
    await state.bindClipboardRecord(rows[0]!);
    const focus = document.activeElement;
    copy(state, "姓名"); copy(state, "送检单位", 2);
    expect(state.entryValues.name).toBe("姓名"); expect(state.entryValues.unit).toBe("送检单位");
    expect(state.clipboardSession.status).toBe("complete");
    expect(mocks.commitCellBatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focus);
    copy(state, "额外内容", 3);
    expect(state.entryValues.unit).toBe("送检单位");
  });

  it("Enter finds an exact existing pathology instead of creating a duplicate", async () => {
    rows[0]!.pathology_number = "A-20260930";
    const state = await mount(); state.combinedPathologyInput = "A-20260930";
    await state.saveEntry();
    expect(state.activeRecord?.id).toBe("r1"); expect(state.clipboardSession.status).toBe("listening");
    expect(mocks.quickCreateRecord).not.toHaveBeenCalled();
    expect(mocks.queryRecords.mock.calls[0]?.[0].field_filters).toEqual([
      { field_id: "path", operator: "equals", value: "A-20260930" },
    ]);
  });

  it("creates a new combined number and opens that record for follow entry", async () => {
    const state = await mount(); state.combinedPathologyInput = "NEW-2";
    await state.saveEntry();
    expect(mocks.quickCreateRecord).toHaveBeenCalledWith("p", "NEW-2");
    expect(state.activeRecord?.id).toBe("created"); expect(state.clipboardSession.context?.recordId).toBe("created");
  });

  it("multiple blocks require choosing the correct record before listening", async () => {
    rows[1]!.pathology_number = "P1"; rows[1]!.block_number = "2";
    const state = await mount(); state.combinedPathologyInput = "P1";
    await state.saveEntry();
    expect(state.matchDialogVisible).toBe(true); expect(mocks.bridge.startClipboardFollow).not.toHaveBeenCalled();
    await state.bindClipboardRecord(rows[1]!);
    expect(state.clipboardSession.context?.recordId).toBe("r2");
    expect(state.activeRecord?.block_number).toBe("2");
  });

  it("prevents locked or reported records from starting", async () => {
    const state = await mount();
    await state.bindClipboardRecord({ ...rows[0]!, locked: true });
    await state.bindClipboardRecord({ ...rows[0]!, report_generated: true });
    expect(mocks.bridge.startClipboardFollow).not.toHaveBeenCalled();
  });

  it("a delayed start acknowledged after switching records is explicitly stopped", async () => {
    const state = await mount();
    let resolve!: (result: { sequence: number }) => void;
    mocks.bridge.startClipboardFollow.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = state.bindClipboardRecord(rows[0]!); await flush();
    const previous = { ...state.clipboardSession.context! };
    await state.selectRecord(rows[1]!);
    resolve({ sequence: 10 }); await pending;
    expect(mocks.bridge.stopClipboardFollow).toHaveBeenCalledWith(previous.sessionId);
    copy(state, "迟到内容", 1, previous); expect(state.entryValues.name).toBe("");
    expect(state.activeRecord?.id).toBe("r2");
  });

  it("a refresh marking the record unavailable stops reception and preserves drafts", async () => {
    const state = await mount(); await state.bindClipboardRecord(rows[0]!);
    copy(state, "保留草稿"); const previous = { ...state.clipboardSession.context! };
    rows[0]!.locked = true;
    await state.loadUnreportedRecords("p"); await flush();
    expect(state.activeRecordUnavailable).toBe(true);
    copy(state, "迟到内容", 2, previous);
    expect(state.entryValues.name).toBe("保留草稿"); expect(state.entryValues.unit).toBe("");
    expect(mocks.bridge.stopClipboardFollow).toHaveBeenCalled();
  });

  it("explicit overwrite can be undone without losing the previous value", async () => {
    rows[0]!.values.name = "原姓名";
    const state = await mount(); await state.bindClipboardRecord(rows[0]!);
    copy(state, "新姓名"); expect(state.clipboardSession.status).toBe("paused");
    expect(state.entryValues.name).toBe("原姓名");
    await state.overwriteClipboardField(); expect(state.entryValues.name).toBe("新姓名");
    state.undoClipboardField(); expect(state.entryValues.name).toBe("原姓名");
    expect(state.clipboardSession.nextFieldId).toBe("name");
  });

  it("canceling a dirty record switch pauses the old session instead of consuming new copies", async () => {
    const state = await mount(); await state.bindClipboardRecord(rows[0]!); copy(state, "姓名");
    mocks.confirm.mockRejectedValueOnce(new Error("cancel"));
    await state.selectRecord(rows[1]!);
    copy(state, "误填内容", 2);
    expect(state.activeRecord?.id).toBe("r1"); expect(state.entryValues.unit).toBe("");
    expect(state.clipboardSession.status).toBe("paused");
  });

  it("saving advances but defaults to waiting; the automatic pathology copy uses the marked service", async () => {
    const state = await mount(); await state.bindClipboardRecord(rows[0]!);
    const previous = { ...state.clipboardSession.context! }; copy(state, "姓名"); copy(state, "单位", 2);
    await state.saveEntry();
    expect(state.activeRecord?.id).toBe("r2"); expect(state.clipboardSession.status).toBe("waiting");
    expect(mocks.bridge.writeInternalClipboard).toHaveBeenCalledWith("P2");
    expect(mocks.bridge.startClipboardFollow).toHaveBeenCalledTimes(1);
    copy(state, "上一患者内容", 3, previous); expect(state.entryValues.name).toBe("");
  });

  it("optional automatic continuation binds a fresh next-record session", async () => {
    const state = await mount(); state.fieldSettings.clipboardAutoContinue = true;
    await state.bindClipboardRecord(rows[0]!); const oldContext = { ...state.clipboardSession.context! };
    copy(state, "姓名"); await state.saveEntry();
    expect(state.clipboardSession.status).toBe("listening"); expect(state.clipboardSession.context?.recordId).toBe("r2");
    copy(state, "迟到内容", 2, oldContext); expect(state.entryValues.name).toBe("");
  });

  it("save failure keeps the current patient draft and reception paused", async () => {
    const state = await mount(); await state.bindClipboardRecord(rows[0]!); copy(state, "保留姓名");
    mocks.previewCellBatch.mockRejectedValueOnce(new Error("save failed")); await state.saveEntry();
    expect(state.activeRecord?.id).toBe("r1"); expect(state.entryValues.name).toBe("保留姓名");
    expect(state.clipboardSession.status).toBe("paused"); expect(mocks.commitCellBatch).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter saves even when the patient form has no focused input", async () => {
    const state = await mount(); await state.bindClipboardRecord(rows[0]!); copy(state, "姓名");
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event); await flush();
    expect(event.defaultPrevented).toBe(true); expect(mocks.commitCellBatch).toHaveBeenCalledTimes(1);
  });

  it("stores a separate paste order using v5 and invalidates the previous session", async () => {
    const state = await mount(); await state.bindClipboardRecord(rows[0]!);
    state.openFieldSettings(); state.clipboardFieldDraft = ["unit", "name"]; await state.saveFieldSettings();
    expect(mocks.putSetting.mock.calls.at(-1)?.[1].version).toBe(5);
    expect(state.fieldSettings.clipboardFieldIds).toEqual(["unit", "name"]);
    expect(state.fieldSettings.selectedFieldIds).toEqual(["path", "block", "name", "unit"]);
    expect(state.clipboardSession.context).toBeNull();
  });
});
