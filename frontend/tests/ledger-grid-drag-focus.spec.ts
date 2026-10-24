import { computed, createApp, defineComponent, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FieldDefinition } from "@/types/api";
import { useGridPointerDrag } from "@/composables/useGridPointerDrag";
import { useLedgerGridSelection } from "@/composables/useLedgerGridSelection";
import {
  makeGridCellHelpers,
  type GridCellPosition,
} from "@/utils/gridSelectionModel";
import type { LedgerRow } from "@/utils/ledgerTableView";

/**
 * useGridPointerDrag 的松手回焦单元测试（视图挂载用 render:()=>null 时
 * 无法真实聚焦，故在 composable 层注入 focusCell 桩）。
 * 必须钉住：松手回焦的目标是选区 focus 端——传 anchor 会把活动格
 * 拉回起点，多格选区的活动高亮随之塌缩。
 */

const rows = [
  { id: "r0" }, { id: "r1" }, { id: "r2" },
] as unknown as LedgerRow[];
const fields = [
  { id: "f0" }, { id: "f1" }, { id: "f2" },
] as unknown as FieldDefinition[];
const rowIndexById = new Map(rows.map((row, index) => [row.id, index] as const));

type DragComposable = ReturnType<typeof useGridPointerDrag>;
type SelectionComposable = ReturnType<typeof useLedgerGridSelection>;

let app: App | undefined;
let container: HTMLDivElement | undefined;
let dragTable: HTMLDivElement | undefined;
let harness: {
  drag: DragComposable;
  selection: SelectionComposable;
  focusCell: ReturnType<typeof vi.fn>;
} | undefined;

function mountHarness(): NonNullable<typeof harness> {
  const focusCell = vi.fn();
  let local: NonNullable<typeof harness> | undefined;
  const Probe = defineComponent({
    setup() {
      const selection = useLedgerGridSelection({
        fields: computed(() => fields),
        tableRows: computed(() => rows),
        tableRowIndexById: computed(() => rowIndexById),
      });
      const drag = useGridPointerDrag({
        cells: makeGridCellHelpers(() => rows, () => fields),
        selection: {
          activeGridCell: selection.activeGridCell,
          gridCellRange: selection.gridCellRange,
          selectedGridCellKeys: selection.selectedGridCellKeys,
          gridSelectionAnchor: selection.gridSelectionAnchor,
          selectGridCell: selection.selectGridCell,
          materializeGridCellRangeSelection: selection.materializeGridCellRangeSelection,
        },
        tableRef: ref(null),
        cellFromElement: (element) => {
          if (!(element instanceof Element)) return null;
          const editor = element.closest<HTMLElement>("[data-row-id][data-field-index]");
          if (!editor) return null;
          const rowId = editor.dataset.rowId ?? "";
          const columnIndex = Number(editor.dataset.fieldIndex);
          if (!rowId || !Number.isInteger(columnIndex) || columnIndex < 0) return null;
          const rowIndex = rowIndexById.get(rowId) ?? -1;
          if (rowIndex < 0 || columnIndex >= fields.length) return null;
          return { rowIndex, columnIndex } satisfies GridCellPosition;
        },
        bodyScrollElement: (tableElement) =>
          tableElement.querySelector<HTMLElement>(".el-table-v2__body"),
        isEditingCell: () => false,
        commitActiveEdit: () => {},
        focusCell,
        dragThreshold: 4,
      });
      local = { drag, selection, focusCell };
      return () => null;
    },
  });

  // 表格挂在 body 下、与应用容器分离：Vue mount 会清空挂载容器的既有内容。
  const table = document.createElement("div");
  table.className = "el-table-v2";
  table.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800);
  const body = document.createElement("div");
  body.className = "el-table-v2__body";
  body.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800);
  table.append(body);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const cell = document.createElement("div");
      cell.dataset.rowId = `r${r}`;
      cell.dataset.fieldIndex = String(c);
      body.append(cell);
    }
  }
  document.body.append(table);
  dragTable = table;

  container = document.createElement("div");
  document.body.append(container);

  app = createApp(Probe);
  app.mount(container);
  if (!local) throw new Error("probe setup did not run");
  return local;
}

function cellAt(row: number, column: number): HTMLElement {
  const cell = document.querySelector<HTMLElement>(
    `[data-row-id="r${row}"][data-field-index="${column}"]`,
  );
  if (!cell) throw new Error(`cell r${row}/${column} missing`);
  return cell;
}

function pointerEvent(type: string, init: PointerEventInit & { target?: EventTarget }): PointerEvent {
  const event = new MouseEvent(type, init) as PointerEvent;
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 7 });
  if (init.target !== undefined) {
    // MouseEvent 构造器不接受 target；直接调用 handler 时手动注入。
    Object.defineProperty(event, "target", { value: init.target });
  }
  return event;
}

async function nextDragFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  document.elementFromPoint = vi.fn(() => null);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container?.remove();
  container = undefined;
  dragTable?.remove();
  dragTable = undefined;
  harness = undefined;
  vi.restoreAllMocks();
});

describe("useGridPointerDrag focus restoration on pointerup", () => {
  it("restores focus to the drag focus end with scroll disabled", async () => {
    const { drag, selection, focusCell } = mountHarness();

    drag.handleGridPointerDown(pointerEvent("pointerdown", {
      target: cellAt(0, 0), buttons: 1, clientX: 100, clientY: 100,
    }));
    expect(focusCell).toHaveBeenCalledTimes(1);
    expect(focusCell.mock.calls[0]?.[0]).toEqual({ rowIndex: 0, columnIndex: 0 });

    vi.mocked(document.elementFromPoint).mockReturnValue(cellAt(2, 2));
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 500, clientY: 500 }));
    await nextDragFrame();
    vi.mocked(document.elementFromPoint).mockReset();
    vi.mocked(document.elementFromPoint).mockReturnValue(null);

    expect(selection.gridCellRange.value).toEqual({
      anchor: { rowIndex: 0, columnIndex: 0 },
      focus: { rowIndex: 2, columnIndex: 2 },
    });

    focusCell.mockClear();
    document.dispatchEvent(pointerEvent("pointerup", { buttons: 0, clientX: 500, clientY: 500 }));

    expect(focusCell).toHaveBeenCalledTimes(1);
    expect(focusCell.mock.calls[0]?.[0]).toEqual({ rowIndex: 2, columnIndex: 2 });
    expect(focusCell.mock.calls[0]?.[1]).toEqual({ scroll: false });
    expect(selection.activeGridCell.value).toEqual({ rowIndex: 2, columnIndex: 2 });
    expect(selection.selectedGridCellKeys.value.size).toBe(9);
  });

  it("does not refocus on pointerup when the pointer never crossed the threshold", () => {
    const { drag, focusCell } = mountHarness();

    drag.handleGridPointerDown(pointerEvent("pointerdown", {
      target: cellAt(1, 1), buttons: 1, clientX: 100, clientY: 100,
    }));
    document.dispatchEvent(pointerEvent("pointermove", { buttons: 1, clientX: 102, clientY: 101 }));
    document.dispatchEvent(pointerEvent("pointerup", { buttons: 0, clientX: 102, clientY: 101 }));

    expect(focusCell).toHaveBeenCalledTimes(1);
  });
});
