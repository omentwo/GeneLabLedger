import { createApp, computed, type App, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLedgerGridScrollFocus } from "@/composables/useLedgerGridScrollFocus";
import { getSetting } from "@/api/system";
import type { TableV2Instance } from "element-plus";
import type { FieldDefinition, Project, ProjectRecord, RecordComplexQuery } from "@/types/api";
import LedgerView from "@/views/LedgerView.vue";

/** 单测只需要 scrollToRow 能力面，按 TableV2Instance 结构收窄。 */
function asTableInstance(scrollToRow: (rowIndex: number, strategy?: string) => void): TableV2Instance {
  return { scrollToRow } as unknown as TableV2Instance;
}

/**
 * 台账滚动视口焦点保持 / 粘贴回位回归。
 *
 * 病灶：虚拟滚动把持焦单元格卸载出 DOM，焦点落回 body，keydown/paste
 * 的传播路径脱离表格卡片，剪贴板/快捷键监听全部收不到事件——目标格
 * 滚出视野后 Ctrl+V/Ctrl+D 静默失效。这里钉住两件事：
 * 1. 滚动时焦点被收回卡片（tabindex="-1" 编程式焦点），且每帧早退；
 * 2. 卡片持焦后 Ctrl+D / Ctrl+V 走 activeGridCell 回退仍能落到正确目标，
 *    屏外粘贴完成后视图回位并瞬时高亮，可视区内粘贴保持视口不动。
 */

const ROW_HEIGHT = 40;

/** 构造带 .el-table-v2__body 滚动容器的卡片，clientHeight 模拟 5 行视口。 */
function buildCardDom(): { card: HTMLElement; body: HTMLElement } {
  const card = document.createElement("div");
  card.tabIndex = -1;
  const main = document.createElement("div");
  main.className = "el-table-v2__main";
  const body = document.createElement("div");
  body.className = "el-table-v2__body";
  main.append(body);
  card.append(main);
  document.body.append(card);
  Object.defineProperty(body, "scrollTop", { value: 0, writable: true, configurable: true });
  Object.defineProperty(body, "clientHeight", { value: ROW_HEIGHT * 5, configurable: true });
  return { card, body };
}

function bodyOf(card: HTMLElement): HTMLElement {
  const body = card.querySelector<HTMLElement>(".el-table-v2__main .el-table-v2__body");
  if (!body) throw new Error("测试卡片缺少 .el-table-v2__body 滚动容器");
  return body;
}

describe("useLedgerGridScrollFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function buildDeps(overrides: Partial<Parameters<typeof useLedgerGridScrollFocus>[0]> = {}) {
    const { card, body } = buildCardDom();
    const focusSpy = vi.spyOn(card, "focus");
    return {
      deps: {
        cardRef: ref<HTMLElement | null>(card),
        tableRef: ref(null),
        rowHeight: computed(() => ROW_HEIGHT),
        bodyScrollElement: (element: HTMLElement) =>
          element.querySelector<HTMLElement>(".el-table-v2__main .el-table-v2__body"),
        activeGridCell: ref<{ rowIndex: number; columnIndex: number } | null>({
          rowIndex: 0, columnIndex: 0,
        }),
        selectionDragging: ref(false),
        editingCell: ref<{ rowIndex: number; columnIndex: number } | null>(null),
        commitActiveEdit: vi.fn(async () => true),
        isDisposed: () => false,
        flashRecord: vi.fn(),
        ...overrides,
      },
      card,
      body,
      focusSpy,
    };
  }

  it("焦点落在 body 时滚动把焦点收回卡片，且带 preventScroll", () => {
    const { deps, card, focusSpy } = buildDeps();
    const { keepGridFocusOnScroll } = useLedgerGridScrollFocus(deps);
    expect(document.activeElement).toBe(document.body);

    keepGridFocusOnScroll();

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(card);
  });

  it("焦点已在卡片上时后续滚动帧全部早退", () => {
    const { deps, focusSpy } = buildDeps();
    const { keepGridFocusOnScroll } = useLedgerGridScrollFocus(deps);
    keepGridFocusOnScroll();
    expect(focusSpy).toHaveBeenCalledTimes(1);

    focusSpy.mockClear();
    keepGridFocusOnScroll();
    keepGridFocusOnScroll();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("焦点在其他交互元素上时不抢焦", () => {
    const { deps, focusSpy } = buildDeps();
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const { keepGridFocusOnScroll } = useLedgerGridScrollFocus(deps);

    keepGridFocusOnScroll();

    expect(document.activeElement).toBe(button);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("拖拽自动滚动、无活动单元格、已销毁时跳过", () => {
    const dragging = buildDeps({ selectionDragging: ref(true) });
    useLedgerGridScrollFocus(dragging.deps).keepGridFocusOnScroll();
    expect(dragging.focusSpy).not.toHaveBeenCalled();

    const empty = buildDeps({ activeGridCell: ref(null) });
    useLedgerGridScrollFocus(empty.deps).keepGridFocusOnScroll();
    expect(empty.focusSpy).not.toHaveBeenCalled();

    const disposed = buildDeps({ isDisposed: () => true });
    useLedgerGridScrollFocus(disposed.deps).keepGridFocusOnScroll();
    expect(disposed.focusSpy).not.toHaveBeenCalled();
  });

  it("编辑态单元格滚出视野时先提交编辑再补焦", () => {
    const { deps, focusSpy } = buildDeps({
      editingCell: ref<{ rowIndex: number; columnIndex: number } | null>({ rowIndex: 3, columnIndex: 0 }),
    });
    const { keepGridFocusOnScroll } = useLedgerGridScrollFocus(deps);

    keepGridFocusOnScroll();

    expect(deps.commitActiveEdit).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("屏外粘贴回位并瞬时高亮，可视区内粘贴保持视口不动", () => {
    const scrollToRow = vi.fn();
    const flashRecord = vi.fn();
    const { card, body } = buildCardDom();
    const deps = {
      cardRef: ref<HTMLElement | null>(card),
      tableRef: ref(asTableInstance(scrollToRow)),
      rowHeight: computed(() => ROW_HEIGHT),
      bodyScrollElement: (element: HTMLElement) => bodyOf(element),
      activeGridCell: ref({ rowIndex: 0, columnIndex: 0 }),
      selectionDragging: ref(false),
      editingCell: ref<{ rowIndex: number; columnIndex: number } | null>(null),
      commitActiveEdit: vi.fn(async () => true),
      isDisposed: () => false,
      flashRecord,
    };
    const { revealGridPasteTarget } = useLedgerGridScrollFocus(deps);

    // 起始行在 5 行视口内：不回位。
    revealGridPasteTarget(2, "r2");
    expect(scrollToRow).not.toHaveBeenCalled();
    expect(flashRecord).not.toHaveBeenCalled();

    // 起始行远在可视窗口之外（视口已滚到 100 行开外）：回位居中 + 高亮。
    Object.defineProperty(body, "scrollTop", {
      value: ROW_HEIGHT * 100, writable: true, configurable: true,
    });
    revealGridPasteTarget(0, "r0");
    expect(scrollToRow).toHaveBeenCalledWith(0, "center");
    expect(flashRecord).toHaveBeenCalledWith("r0");

    // 已销毁：不做任何视口操作。
    scrollToRow.mockClear();
    const disposedDeps = { ...deps, isDisposed: () => true };
    useLedgerGridScrollFocus(disposedDeps).revealGridPasteTarget(0, "r0");
    expect(scrollToRow).not.toHaveBeenCalled();
  });
});

const mocks = vi.hoisted(() => ({
  store: {
    projects: [] as Project[],
    bootstrap: vi.fn(async () => undefined),
    projectById: (id: string): Project | undefined => mocks.store.projects.find((project) => project.id === id),
  },
  queryRecords: vi.fn(),
  previewCellBatch: vi.fn(),
  commitCellBatch: vi.fn(),
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

interface LedgerGridHarness {
  selectGridCell: (position: { rowIndex: number; columnIndex: number }) => void;
  handleGridClick: (event: MouseEvent) => void;
  handleGridKeydown: (event: KeyboardEvent) => void;
  handleGridPaste: (event: ClipboardEvent) => void;
  handleLedgerTableScroll: (position: { scrollLeft?: number; scrollTop?: number }) => void;
  tableRows: Array<{ id: string }>;
  focusRecordId: string;
  ledgerTableCardRef: HTMLElement | null;
  tableRef: { scrollToRow: (rowIndex: number, strategy?: string) => void };
}

let app: App | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSetting).mockImplementation(async (key) => ({ key, value: null }));
  window.localStorage.clear();
  mocks.store.projects = ["A"].map((id) => ({
    id, name: id, sort_order: 0, experiment_enabled: true,
    duplicate_pathology_warning_enabled: true,
    fields: [field(id, "pathology", "pathology_number"), field(id, "note", null)],
  }));
  mocks.queryRecords.mockImplementation(async (query: RecordComplexQuery) => {
    const items = [
      record("A", "a1", "note-a1"),
      record("A", "a2", "note-a2"),
    ].map((item) => ({ ...item, values: { ...item.values } }));
    return { items, total: items.length, limit: query.limit, offset: 0 };
  });
  mocks.previewCellBatch.mockResolvedValue({
    token: "token-1", affected_count: 1, skipped_locked: 0, issues: [], expires_at: "",
  });
  mocks.commitCellBatch.mockResolvedValue({
    records: [], skipped_locked: 0, changes: [], created_record_ids: [], before: [], after: [],
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container?.remove();
  document.body.innerHTML = "";
});

async function mountLedger(): Promise<LedgerGridHarness> {
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ ...LedgerView, render: () => null });
  app.mount(container);
  const state = (app._instance as unknown as { setupState: LedgerGridHarness }).setupState;
  await vi.waitFor(() => {
    expect(state.tableRows.map((row) => row.id)).toEqual(["a1", "a2"]);
  });
  return state;
}

function pasteEvent(text: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  return event;
}

describe("ledger grid focus keep (integration)", () => {
  it("滚动丢焦后焦点被收回卡片，卡片持焦时 Ctrl+D 仍能填充", async () => {
    const state = await mountLedger();
    state.selectGridCell({ rowIndex: 0, columnIndex: 1 });

    // shift+点击第二行同列，构造两行选区（Ctrl+D 以选区首行为源向下填充）。
    const secondCell = document.createElement("div");
    secondCell.dataset.rowId = "a2";
    secondCell.dataset.fieldIndex = "1";
    document.body.append(secondCell);
    const click = new MouseEvent("click", { shiftKey: true, bubbles: true });
    secondCell.dispatchEvent(click);
    state.handleGridClick(click);

    // 模拟滚动把焦点格滚出虚拟窗口：焦点落回 body，滚动钩子把焦点收回卡片。
    const card = document.createElement("div");
    card.tabIndex = -1;
    document.body.append(card);
    state.ledgerTableCardRef = card;
    state.handleLedgerTableScroll({ scrollTop: 100, scrollLeft: 0 });
    expect(document.activeElement).toBe(card);

    // 卡片持焦：Ctrl+D 经 activeGridCell 回退命中源单元格并完成填充。
    state.handleGridKeydown(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(mocks.message.success).toHaveBeenCalledWith("已快捷填充 1 个单元格");
    });
  });

  it("屏外粘贴完成后视图回位并瞬时高亮，可视区内粘贴不回位", async () => {
    const state = await mountLedger();
    const { card, body } = buildCardDom();
    state.ledgerTableCardRef = card;
    const fakeTable = { scrollToRow: vi.fn(), scrollToLeft: vi.fn(), scrollToTop: vi.fn() };
    state.tableRef = fakeTable;
    state.selectGridCell({ rowIndex: 0, columnIndex: 1 });

    // 起始行远在可视窗口之外：粘贴完成后回位 + 瞬时高亮。
    Object.defineProperty(body, "scrollTop", {
      value: ROW_HEIGHT * 100, writable: true, configurable: true,
    });
    const offscreenPaste = pasteEvent("hello");
    card.dispatchEvent(offscreenPaste);
    await state.handleGridPaste(offscreenPaste);
    await vi.waitFor(() => {
      expect(mocks.message.success).toHaveBeenCalledWith("已粘贴 1 个单元格");
    });
    expect(fakeTable.scrollToRow).toHaveBeenCalledWith(0, "center");
    expect(state.focusRecordId).toBe("a1");

    // 起始行回到可视窗口内：粘贴后视口保持不动（pasteGrid 既有约定）。
    Object.defineProperty(body, "scrollTop", { value: 0, writable: true, configurable: true });
    const visiblePaste = pasteEvent("world");
    card.dispatchEvent(visiblePaste);
    await state.handleGridPaste(visiblePaste);
    await vi.waitFor(() => {
      expect(mocks.message.success).toHaveBeenCalledWith("已粘贴 1 个单元格");
    });
    expect(fakeTable.scrollToRow).toHaveBeenCalledTimes(1);
  });
});
