import { createApp, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSetting } from "@/api/system";
import type { FieldDefinition, Project, ProjectRecord, RecordComplexQuery } from "@/types/api";
import { GRID_CELL_KEY_SEPARATOR } from "@/utils/gridSelectionModel";
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

type Position = { rowIndex: number; columnIndex: number };

interface DragState {
  activeProjectId: string;
  loading: boolean;
  records: ProjectRecord[];
  fields: FieldDefinition[];
  activeGridCell: Position | null;
  gridCellRange: { anchor: Position; focus: Position } | null;
  selectedGridCellKeys: Set<string>;
  gridSelectionDragging: boolean;
  suppressGridClick: boolean;
  handleGridPointerDown: (event: PointerEvent) => void;
  handleGridPointerUp: (event: PointerEvent) => void;

  replaceGridCellSelection: (
    positions: Position[],
    active: Position,
    anchor?: Position,
    range?: { anchor: Position; focus: Position } | null,
  ) => void;
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSetting).mockImplementation(async (key) => ({ key, value: null }));
  window.localStorage.clear();
  document.elementFromPoint = vi.fn(() => null);
  mocks.store.projects = [{
    id: "A", name: "A", sort_order: 0, experiment_enabled: true,
    duplicate_pathology_warning_enabled: true,
    fields: [field("A", "pathology", "pathology_number"), field("A", "block", "block_number"), field("A", "note", null)],
  }];
  const database = new Map([["A", ["r1", "r2", "r3"].map((id) => record("A", id))]]);
  mocks.queryRecords.mockImplementation(async (query: RecordComplexQuery) => {
    const items = (database.get(query.project_id ?? "") ?? []).map((item) => ({ ...item, values: { ...item.values } }));
    return { items, total: items.length, limit: query.limit, offset: 0 };
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container.remove();
  vi.restoreAllMocks();
});

async function mountLedger(): Promise<DragState> {
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ ...LedgerView, render: () => null });
  app.mount(container);
  const state = (app._instance as unknown as { setupState: DragState }).setupState;
  await vi.waitFor(() => {
    expect(state.activeProjectId).toBe("A");
    expect(state.loading).toBe(false);
  });
  return state;
}

/** 构造 pointerdown 命中的单元格：data-row-id / data-field-index 齐全，并挂在表格根上。 */
function makeCell(rowId: string, columnIndex: number): HTMLElement {
  const table = document.createElement("div");
  table.className = "el-table-v2";
  table.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800);
  const cell = document.createElement("div");
  cell.dataset.rowId = rowId;
  cell.dataset.fieldIndex = String(columnIndex);
  table.append(cell);
  return cell;
}

function pointerEvent(type: string, init: PointerEventInit & { target?: EventTarget }): PointerEvent {
  const event = new MouseEvent(type, init) as PointerEvent;
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  if (init.target !== undefined) {
    // MouseEvent 构造器不接受 target；直接调用 handler 时手动注入。
    Object.defineProperty(event, "target", { value: init.target });
  }
  return event;
}

function key(rowId: string, fieldId: string): string {
  return `${rowId}${GRID_CELL_KEY_SEPARATOR}${fieldId}`;
}

/** 等待拖拽帧合并的 requestAnimationFrame 真正落地。 */
async function nextDragFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

describe("ledger grid cell drag selection", () => {
  it("materializes a replace-drag into cell keys on pointerup", async () => {
    const state = await mountLedger();
    const startCell = makeCell("r1", 1);
    state.handleGridPointerDown(pointerEvent("pointerdown", {
      target: startCell, buttons: 1, clientX: 100, clientY: 100, bubbles: false,
    }));
    expect(state.selectedGridCellKeys).toEqual(new Set([key("r1", "A-block")]));

    const endCell = makeCell("r2", 2);
    const atPoint = vi.mocked(document.elementFromPoint).mockReturnValue(endCell);
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 420, clientY: 320 }));
    expect(state.gridSelectionDragging).toBe(true);
    await nextDragFrame();
    atPoint.mockReset(); atPoint.mockReturnValue(null);

    expect(state.gridCellRange).toEqual({
      anchor: { rowIndex: 0, columnIndex: 1 },
      focus: { rowIndex: 1, columnIndex: 2 },
    });
    expect(state.activeGridCell).toEqual({ rowIndex: 1, columnIndex: 2 });
    // 拖拽期间 range 尚未物化为键集合。
    expect(state.selectedGridCellKeys).toEqual(new Set([key("r1", "A-block")]));

    document.dispatchEvent(pointerEvent("pointerup", { buttons: 0, clientX: 420, clientY: 320 }));
    expect(state.gridSelectionDragging).toBe(false);
    expect(state.selectedGridCellKeys).toEqual(new Set([
      key("r1", "A-block"), key("r1", "A-note"),
      key("r2", "A-block"), key("r2", "A-note"),
    ]));
  });

  it("keeps a single-cell selection when the pointer never crosses the drag threshold", async () => {
    const state = await mountLedger();
    state.handleGridPointerDown(pointerEvent("pointerdown", {
      target: makeCell("r2", 1), buttons: 1, clientX: 100, clientY: 100,
    }));
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 104, clientY: 103 }));
    expect(state.gridSelectionDragging).toBe(false);
    expect(state.gridCellRange).toEqual({
      anchor: { rowIndex: 1, columnIndex: 1 },
      focus: { rowIndex: 1, columnIndex: 1 },
    });
    document.dispatchEvent(pointerEvent("pointerup", { buttons: 0, clientX: 104, clientY: 103 }));
    expect(state.selectedGridCellKeys).toEqual(new Set([key("r2", "A-block")]));
    expect(state.suppressGridClick).toBe(false);
  });

  it("merges the range into the existing selection for ctrl+drag (add mode)", async () => {
    const state = await mountLedger();
    state.replaceGridCellSelection(
      [{ rowIndex: 0, columnIndex: 1 }],
      { rowIndex: 0, columnIndex: 1 },
    );
    state.handleGridPointerDown(pointerEvent("pointerdown", {
      target: makeCell("r2", 1), buttons: 1, clientX: 100, clientY: 100, ctrlKey: true,
    }));

    const endCell = makeCell("r3", 1);
    const atPoint = vi.mocked(document.elementFromPoint).mockReturnValue(endCell);
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 300, clientY: 500 }));
    await nextDragFrame();
    atPoint.mockReset(); atPoint.mockReturnValue(null);

    // add 模式维护键集合、不维护 range。
    expect(state.gridCellRange).toBeNull();
    expect(state.selectedGridCellKeys).toEqual(new Set([
      key("r1", "A-block"), key("r2", "A-block"), key("r3", "A-block"),
    ]));

    document.dispatchEvent(pointerEvent("pointerup", { buttons: 0, clientX: 300, clientY: 500 }));
    // pointerup 对 add 模式不做二次物化，键集合保持不变。
    expect(state.selectedGridCellKeys).toEqual(new Set([
      key("r1", "A-block"), key("r2", "A-block"), key("r3", "A-block"),
    ]));
  });

  it("stops the drag when the primary button is released mid-move", async () => {
    const state = await mountLedger();
    state.handleGridPointerDown(pointerEvent("pointerdown", {
      target: makeCell("r1", 0), buttons: 1, clientX: 100, clientY: 100,
    }));
    const endCell = makeCell("r2", 0);
    const atPoint = vi.mocked(document.elementFromPoint).mockReturnValue(endCell);
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 0, clientX: 500, clientY: 500 }));
    atPoint.mockReset(); atPoint.mockReturnValue(null);
    expect(state.gridSelectionDragging).toBe(false);

    // 状态已清理：后续 move 不再产生任何选择变化。
    const before = new Set(state.selectedGridCellKeys);
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 500, clientY: 500 }));
    expect(state.selectedGridCellKeys).toEqual(before);
  });

  it("suppresses the click that follows a real drag until the next macrotask", async () => {
    const state = await mountLedger();
    state.handleGridPointerDown(pointerEvent("pointerdown", {
      target: makeCell("r1", 1), buttons: 1, clientX: 100, clientY: 100,
    }));
    const endCell = makeCell("r2", 1);
    const atPoint = vi.mocked(document.elementFromPoint).mockReturnValue(endCell);
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 400, clientY: 400 }));
    atPoint.mockReset(); atPoint.mockReturnValue(null);
    expect(state.suppressGridClick).toBe(true);

    document.dispatchEvent(pointerEvent("pointerup", { buttons: 0, clientX: 400, clientY: 400 }));
    expect(state.suppressGridClick).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(state.suppressGridClick).toBe(false);
  });
});
