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

type Position = { rowIndex: number; columnIndex: number };
type Range = { rowStart: number; rowEnd: number; columnStart: number; columnEnd: number };

interface FillState {
  activeProjectId: string;
  loading: boolean;
  gridCellRange: { anchor: Position; focus: Position } | null;
  gridFillPreviewRange: Range | null;
  gridFillPreviewSource: Range | null;
  gridFillPreviewValues: Map<string, string>;
  gridFillPreviewSummary: string;
  gridFillPreviewPointer: { left: number; top: number };
  suppressGridClick: boolean;
  selectGridCell: (position: Position) => void;
  replaceGridCellSelection: (
    positions: Position[],
    active: Position,
    anchor?: Position,
    range?: { anchor: Position; focus: Position } | null,
  ) => void;
  handleGridFillPointerDown: (event: PointerEvent) => void;
}

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
    highlight_color: null, values: { "A-note": note }, created_at: "", updated_at: "",
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
  const database = new Map([["A", [
    record("A", "r1", "1"), record("A", "r2", ""), record("A", "r3", ""),
  ]]]);
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

async function mountLedger(): Promise<FillState> {
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ ...LedgerView, render: () => null });
  app.mount(container);
  const state = (app._instance as unknown as { setupState: FillState }).setupState;
  await vi.waitFor(() => {
    expect(state.activeProjectId).toBe("A");
    expect(state.loading).toBe(false);
  });
  return state;
}

function fillHandleCell(rowId: string, columnIndex: number): HTMLElement {
  const table = document.createElement("div");
  table.className = "el-table-v2";
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
    Object.defineProperty(event, "target", { value: init.target });
  }
  return event;
}

describe("ledger grid fill drag", () => {
  it("shows a series preview while dragging the fill handle and clears it on cancel", async () => {
    const state = await mountLedger();
    // 选中 r1 的 note 列（含数字 1），填充柄位于选区右下角 r1/col2。
    state.selectGridCell({ rowIndex: 0, columnIndex: 2 });;
    state.handleGridFillPointerDown(pointerEvent("pointerdown", {
      target: fillHandleCell("r1", 2), buttons: 1, clientX: 200, clientY: 50,
    }));

    const overCell = fillHandleCell("r3", 2);
    vi.mocked(document.elementFromPoint).mockReturnValue(overCell);
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 200, clientY: 260 }));
    vi.mocked(document.elementFromPoint).mockReturnValue(null);

    // 拖拽期间生成了 1→3 的序列预览（r1 是源，不产生条目；r2、r3 各一条）。
    expect(state.gridFillPreviewRange).toEqual({ rowStart: 0, rowEnd: 2, columnStart: 2, columnEnd: 2 });
    expect(state.gridFillPreviewSource).toEqual({ rowStart: 0, rowEnd: 0, columnStart: 2, columnEnd: 2 });
    expect(state.gridFillPreviewValues.get("1:2")).toBe("2");
    expect(state.gridFillPreviewValues.get("2:2")).toBe("3");
    // 取消后预览清空。
    document.dispatchEvent(pointerEvent("pointercancel", { buttons: 1, clientX: 200, clientY: 260 }));
    expect(state.gridFillPreviewRange).toBeNull();
    expect(state.gridFillPreviewValues.size).toBe(0);
  });

  it("ignores pointerdown that does not start on the selection corner cell", async () => {
    const state = await mountLedger();
    state.selectGridCell({ rowIndex: 0, columnIndex: 2 });;
    // 右下角应是 r1/col2；从 r2/col2 按下不应启动填充。
    state.handleGridFillPointerDown(pointerEvent("pointerdown", {
      target: fillHandleCell("r2", 2), buttons: 1, clientX: 200, clientY: 120,
    }));
    const overCell = fillHandleCell("r3", 2);
    vi.mocked(document.elementFromPoint).mockReturnValue(overCell);
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 200, clientY: 300 }));
    vi.mocked(document.elementFromPoint).mockReturnValue(null);
    expect(state.gridFillPreviewRange).toBeNull();
    expect(state.suppressGridClick).toBe(false);
  });
});
