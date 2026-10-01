import { createApp, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldDefinition, Project, ProjectRecord, RecordCellChange } from "@/types/api";
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
    stopClipboardFollow: vi.fn(async () => undefined),
    acceptCurrentClipboard: vi.fn(async () => undefined),
    writeInternalClipboard: vi.fn(async () => undefined),
    onClipboardFollowEvent: vi.fn((listener: (event: ClipboardFollowEvent) => void) => {
      mocks.listener = listener; return () => { mocks.listener = undefined; };
    }),
    onQuickEntryOpenRequested: vi.fn(() => () => undefined), onQuickEntryFieldsChanged: vi.fn(() => () => undefined),
    quickEntryReady: vi.fn(async () => undefined), notifyQuickEntryChanged: vi.fn(async () => undefined),
  },
  listener: undefined as ((event: ClipboardFollowEvent) => void) | undefined,
  listRecords: vi.fn(), quickCreateRecord: vi.fn(),
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
vi.mock("@/api/records", () => ({ listRecords: mocks.listRecords,
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
  entryFields: FieldDefinition[];
  clipboardSession: ClipboardFollowSession; clipboardEnabled: boolean;
  fieldSettings: QuickEntryProjectSettings; selectedFieldDraft: string[]; clipboardFieldDraft: string[];
  beginClipboardFollow: (resume?: boolean) => Promise<boolean>;
  saveEntry: () => Promise<void>; selectRecord: (record: ProjectRecord) => Promise<void>;
  acceptCurrentClipboard: () => Promise<void>;
  overwriteClipboardField: () => Promise<void>; undoClipboardField: () => void;
  moveSelectedFieldTo: (fieldId: string, targetIndex: number) => void;
  moveClipboardFieldTo: (fieldId: string, targetIndex: number) => void;
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
    field("block", { system_key: "block_number", is_core: true }), field("name"), field("unit"), field("extra"),
  ] } as Project)];
  mocks.bridge.startClipboardFollow.mockResolvedValue({ sequence: 10 });
  mocks.confirm.mockResolvedValue(undefined);
  mocks.getSetting.mockResolvedValue({ value: { version: 5, projects: { p: {
    selectedFieldIds: ["path", "block", "name", "unit"], clipboardFieldIds: ["name", "unit"], clipboardEnabled: true,
  } } } });
  mocks.putSetting.mockImplementation(async (_key, value) => ({ value }));
  mocks.listRecords.mockImplementation(async () => ({ items: rows.filter((row) => !row.locked && !row.report_generated), total: rows.length }));
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
async function selectAndBegin(state: QuickState, selected: ProjectRecord): Promise<void> {
  await state.selectRecord(selected);
  await state.beginClipboardFollow();
}

describe("quick-entry clipboard integration", () => {
  it("fills the selected patient draft in order without saving or moving focus", async () => {
    const state = await mount();
    expect(container.querySelector(".clipboard-follow-panel")).toBeNull();
    await selectAndBegin(state, rows[0]!);
    await nextTick();
    expect(container.querySelector(".clipboard-follow-panel")).not.toBeNull();
    expect(container.textContent).toContain("当前项：name");
    expect(state.entryFields.map((field) => field.id)).toEqual(["path", "block", "name", "unit"]);
    expect(container.textContent).toContain("粘贴");
    expect(container.textContent).toContain("撤回至上一项");
    expect(container.textContent).toContain("重新开始录入");
    expect(container.textContent).not.toContain("接受当前剪贴板");
    const focus = document.activeElement;
    copy(state, "姓名"); copy(state, "送检单位", 2);
    expect(state.entryValues.name).toBe("姓名"); expect(state.entryValues.unit).toBe("送检单位");
    expect(state.clipboardSession.status).toBe("complete");
    expect(mocks.commitCellBatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focus);
    copy(state, "额外内容", 3);
    expect(state.entryValues.unit).toBe("送检单位");
  });

  it("keeps new-record entry continuous even when clipboard following is enabled", async () => {
    const state = await mount(); state.combinedPathologyInput = "NEW-2";
    expect(container.querySelector(".clipboard-follow-panel")).toBeNull();
    await state.saveEntry();
    expect(mocks.quickCreateRecord).toHaveBeenCalledWith("p", "NEW-2");
    expect(state.activeRecord).toBeNull();
    expect(state.combinedPathologyInput).toBe("");
    expect(state.clipboardSession.context).toBeNull();
    expect(mocks.bridge.startClipboardFollow).not.toHaveBeenCalled();
    expect(container.querySelector(".clipboard-follow-panel")).toBeNull();
  });

  it("prevents locked or reported records from starting", async () => {
    const state = await mount();
    await selectAndBegin(state, { ...rows[0]!, locked: true });
    await selectAndBegin(state, { ...rows[0]!, report_generated: true });
    expect(mocks.bridge.startClipboardFollow).not.toHaveBeenCalled();
  });

  it("a delayed start acknowledged after switching records is explicitly stopped", async () => {
    const state = await mount();
    let resolve!: (result: { sequence: number }) => void;
    mocks.bridge.startClipboardFollow.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await state.selectRecord(rows[0]!);
    const pending = state.beginClipboardFollow(); await flush();
    const previous = { ...state.clipboardSession.context! };
    await state.selectRecord(rows[1]!);
    resolve({ sequence: 10 }); await pending;
    expect(mocks.bridge.stopClipboardFollow).toHaveBeenCalledWith(previous.sessionId);
    copy(state, "迟到内容", 1, previous); expect(state.entryValues.name).toBe("");
    expect(state.activeRecord?.id).toBe("r2");
  });

  it("a refresh marking the record unavailable stops reception and preserves drafts", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!);
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
    const state = await mount(); await selectAndBegin(state, rows[0]!);
    copy(state, "新姓名"); expect(state.clipboardSession.status).toBe("paused");
    expect(state.entryValues.name).toBe("原姓名");
    await state.overwriteClipboardField(); expect(state.entryValues.name).toBe("新姓名");
    state.undoClipboardField(); expect(state.entryValues.name).toBe("原姓名");
    expect(state.clipboardSession.nextFieldId).toBe("name");
  });

  it("pastes the current clipboard into the active item on explicit request", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!);
    const sessionId = state.clipboardSession.context!.sessionId;
    await state.acceptCurrentClipboard();
    expect(mocks.bridge.acceptCurrentClipboard).toHaveBeenCalledWith(sessionId);
  });

  it("canceling a dirty record switch pauses the old session instead of consuming new copies", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!); copy(state, "姓名");
    mocks.confirm.mockRejectedValueOnce(new Error("cancel"));
    await state.selectRecord(rows[1]!);
    copy(state, "误填内容", 2);
    expect(state.activeRecord?.id).toBe("r1"); expect(state.entryValues.unit).toBe("");
    expect(state.clipboardSession.status).toBe("paused");
  });

  it("saving advances but defaults to waiting; the automatic pathology copy uses the marked service", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!);
    const previous = { ...state.clipboardSession.context! }; copy(state, "姓名"); copy(state, "单位", 2);
    await state.saveEntry();
    expect(state.activeRecord?.id).toBe("r2"); expect(state.clipboardSession.status).toBe("waiting");
    expect(mocks.bridge.writeInternalClipboard).toHaveBeenCalledWith("P2");
    expect(mocks.message.success).toHaveBeenCalledWith("已进入下一条记录，病理号 P2 已写入剪贴板");
    expect(mocks.bridge.startClipboardFollow).toHaveBeenCalledTimes(1);
    copy(state, "上一患者内容", 3, previous); expect(state.entryValues.name).toBe("");
  });

  it("optional automatic continuation binds a fresh next-record session", async () => {
    const state = await mount(); state.fieldSettings.clipboardAutoContinue = true;
    await selectAndBegin(state, rows[0]!); const oldContext = { ...state.clipboardSession.context! };
    copy(state, "姓名"); await state.saveEntry();
    expect(state.clipboardSession.status).toBe("listening"); expect(state.clipboardSession.context?.recordId).toBe("r2");
    copy(state, "迟到内容", 2, oldContext); expect(state.entryValues.name).toBe("");
  });

  it("save failure keeps the current patient draft and reception paused", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!); copy(state, "保留姓名");
    mocks.previewCellBatch.mockRejectedValueOnce(new Error("save failed")); await state.saveEntry();
    expect(state.activeRecord?.id).toBe("r1"); expect(state.entryValues.name).toBe("保留姓名");
    expect(state.clipboardSession.status).toBe("paused"); expect(mocks.commitCellBatch).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter saves even when the patient form has no focused input", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!); copy(state, "姓名");
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event); await flush();
    expect(event.defaultPrevented).toBe(true); expect(mocks.commitCellBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the first input Ctrl+Z native and uses the second to roll back the previous item", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!); copy(state, "姓名");
    const input = document.createElement("input"); container.append(input); input.focus();
    const nativeUndo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(nativeUndo);
    expect(nativeUndo.defaultPrevented).toBe(false); expect(state.entryValues.name).toBe("姓名");
    state.entryValues.name = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
    const followUndo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(followUndo);
    expect(followUndo.defaultPrevented).toBe(true); expect(state.entryValues.name).toBe("");
    expect(state.clipboardSession.nextFieldId).toBe("name");
    expect(state.clipboardSession.history).toHaveLength(0);
  });

  it("uses one Ctrl+Z to roll back when focus is outside an input", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!); copy(state, "姓名");
    const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    expect(state.entryValues.name).toBe("");
    expect(state.clipboardSession.nextFieldId).toBe("name");
  });

  it("stores a separate paste order using v5 and invalidates the previous session", async () => {
    const state = await mount(); await selectAndBegin(state, rows[0]!);
    state.openFieldSettings(); state.clipboardFieldDraft = ["unit", "name"]; await state.saveFieldSettings();
    expect(mocks.putSetting.mock.calls.at(-1)?.[1].version).toBe(5);
    expect(state.fieldSettings.clipboardFieldIds).toEqual(["unit", "name"]);
    expect(state.fieldSettings.selectedFieldIds).toEqual(["path", "block", "name", "unit"]);
    expect(state.clipboardSession.context).toBeNull();
  });

  it("moves quick-entry and clipboard fields directly to either boundary", async () => {
    const state = await mount(); state.openFieldSettings();
    state.moveSelectedFieldTo("name", 0);
    expect(state.selectedFieldDraft).toEqual(["name", "path", "block", "unit"]);
    state.moveSelectedFieldTo("name", state.selectedFieldDraft.length - 1);
    expect(state.selectedFieldDraft).toEqual(["path", "block", "unit", "name"]);
    state.moveClipboardFieldTo("unit", 0);
    expect(state.clipboardFieldDraft).toEqual(["unit", "name"]);
    state.moveClipboardFieldTo("unit", state.clipboardFieldDraft.length - 1);
    expect(state.clipboardFieldDraft).toEqual(["name", "unit"]);
    await state.saveFieldSettings();
    expect(mocks.putSetting.mock.calls.at(-1)?.[1].projects.p.selectedFieldIds)
      .toEqual(["path", "block", "unit", "name"]);
    expect(mocks.putSetting.mock.calls.at(-1)?.[1].projects.p.clipboardFieldIds)
      .toEqual(["name", "unit"]);
  });

  it("drops both order lists directly at their top and bottom boundaries", async () => {
    const state = await mount(); state.openFieldSettings(); await nextTick();
    const fieldList = document.querySelector<HTMLElement>(".field-selector")!;
    const extraFieldRow = fieldList.querySelector<HTMLElement>('[data-order-field-id="extra"]')!;
    const nameFieldHandle = fieldList.querySelector<HTMLElement>(
      '[data-order-field-id="name"] .field-drag-handle',
    )!;
    nameFieldHandle.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    extraFieldRow.dispatchEvent(new MouseEvent("drop", {
      bubbles: true, cancelable: true, clientX: 1, clientY: 1,
    }));
    expect(state.selectedFieldDraft).toEqual(["path", "block", "unit", "name"]);

    await nextTick();
    fieldList.querySelector<HTMLElement>('[data-order-field-id="name"] .field-drag-handle')!
      .dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    fieldList.querySelector<HTMLElement>(".field-selector-head")!
      .dispatchEvent(new MouseEvent("drop", {
        bubbles: true, cancelable: true, clientX: 1, clientY: -1,
      }));
    expect(state.selectedFieldDraft).toEqual(["name", "path", "block", "unit"]);

    state.selectedFieldDraft = ["path", "block", "name", "unit", "extra"];
    await nextTick();
    const clipboardList = document.querySelector<HTMLElement>(".clipboard-order-list")!;
    clipboardList.querySelector<HTMLElement>('[data-order-field-id="name"] .field-drag-handle')!
      .dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    clipboardList.querySelector<HTMLElement>('[data-order-field-id="extra"]')!
      .dispatchEvent(new MouseEvent("drop", {
        bubbles: true, cancelable: true, clientX: 1, clientY: 1,
      }));
    expect(state.clipboardFieldDraft).toEqual(["unit", "name"]);

    await nextTick();
    clipboardList.querySelector<HTMLElement>('[data-order-field-id="name"] .field-drag-handle')!
      .dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    clipboardList.dispatchEvent(new MouseEvent("drop", {
      bubbles: true, cancelable: true, clientX: 1, clientY: -1,
    }));
    expect(state.clipboardFieldDraft).toEqual(["name", "unit"]);
  });
});
