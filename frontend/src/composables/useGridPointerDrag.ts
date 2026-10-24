import { ref, type Ref } from "vue";
import type { TableV2Instance } from "element-plus";

import { gridAutoScrollVector, nextGridScrollOffset, type GridAutoScrollDirection } from "@/utils/gridAutoScroll";
import { sameGridCell, type GridCellPosition, type GridCellRange } from "@/utils/gridSelectionModel";

/**
 * 台账网格的指针拖拽机制（P1-3 指针交互层）。
 *
 * 拥有拖拽状态机、rAF 帧合并、拖拽期间滚轮合流与边缘自动滚动，
 * 以及 document 级 pointermove/up/cancel/wheel 监听的生命周期。
 * 选区状态与操作、单元格编辑、聚焦滚动都是注入的依赖——
 * 本层只负责“指针输入 → 选区变化”的时序编排。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export type GridCellDragMode = "replace" | "shift" | "add";

export type GridCellDragState = {
  pointerId: number;
  anchor: GridCellPosition;
  focus: GridCellPosition;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  mode: GridCellDragMode;
  initialSelectionKeys: Set<string>;
  tableElement: HTMLElement;
  lastAppliedFocus: GridCellPosition | null;
  horizontalScrollDirection: GridAutoScrollDirection;
  verticalScrollDirection: GridAutoScrollDirection;
};

export interface GridPointerDragDeps {
  cells: {
    clamp: (position: GridCellPosition) => GridCellPosition;
    key: (position: GridCellPosition) => string;
    positionsForRange: (range: GridCellRange) => GridCellPosition[];
  };
  selection: {
    activeGridCell: Ref<GridCellPosition | null>;
    gridCellRange: Ref<GridCellRange | null>;
    selectedGridCellKeys: Ref<Set<string>>;
    gridSelectionAnchor: Ref<GridCellPosition | null>;
    selectGridCell: (position: GridCellPosition) => void;
    materializeGridCellRangeSelection: () => void;
  };
  tableRef: Ref<TableV2Instance | null>;
  cellFromElement: (element: EventTarget | null) => GridCellPosition | null;
  bodyScrollElement: (tableElement: HTMLElement) => HTMLElement | null;
  isEditingCell: (position: GridCellPosition | null) => boolean;
  /** 拖拽开始前提交处于编辑中的单元格（如有）。 */
  commitActiveEdit: () => void;
  /** options.scroll 为 false 时不得滚动视口（松手回焦路径，指针已在视口内）。 */
  focusCell: (position: GridCellPosition, options?: { scroll?: boolean }) => void;
  dragThreshold: number;
}

export function useGridPointerDrag(deps: GridPointerDragDeps): {
  gridSelectionDragging: Ref<boolean>;
  /** 拖拽后吞掉紧随的 click；在下一个宏任务自动复位。 */
  suppressGridClick: Ref<boolean>;
  stopGridCellDrag: (resetClickSuppression?: boolean) => void;
  flushGridCellDragFrame: () => void;
  gridCellAtPoint: (x: number, y: number) => GridCellPosition | null;
  handleGridPointerDown: (event: PointerEvent) => void;
} {
  const { cells, selection } = deps;
  const gridSelectionDragging = ref(false);
  const suppressGridClick = ref(false);
  let dragState: GridCellDragState | null = null;
  let dragFrame: number | null = null;
  let pendingCell: GridCellPosition | null = null;
  let autoScrollFrame: number | null = null;
  let autoScrollTimestamp: number | null = null;
  let wheelUpdateTimer: number | null = null;

  function clearAutoScroll(): void {
    if (autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame);
    }
    autoScrollFrame = null;
    autoScrollTimestamp = null;
  }

  function clearWheelUpdate(): void {
    if (wheelUpdateTimer === null) return;
    window.clearTimeout(wheelUpdateTimer);
    wheelUpdateTimer = null;
  }

  function clearDragFrame(): void {
    if (dragFrame !== null) window.cancelAnimationFrame(dragFrame);
    dragFrame = null;
    pendingCell = null;
  }

  function updateDrag(cell: GridCellPosition): void {
    const state = dragState;
    if (!state) return;
    const focus = cells.clamp(cell);
    if (sameGridCell(state.lastAppliedFocus, focus)) return;
    state.lastAppliedFocus = focus;
    state.focus = focus;
    selection.activeGridCell.value = state.focus;
    const range = {
      anchor: { ...state.anchor },
      focus: { ...state.focus },
    };
    if (state.mode === "add") {
      const keys = new Set(state.initialSelectionKeys);
      cells.positionsForRange(range).forEach((position) => keys.add(cells.key(position)));
      selection.selectedGridCellKeys.value = keys;
      selection.gridCellRange.value = null;
    } else {
      selection.activeGridCell.value = state.focus;
      selection.gridSelectionAnchor.value = state.anchor;
      selection.gridCellRange.value = range;
    }
  }

  function flushDragFrame(): void {
    if (dragFrame !== null) window.cancelAnimationFrame(dragFrame);
    dragFrame = null;
    const cell = pendingCell;
    pendingCell = null;
    if (cell) updateDrag(cell);
  }

  function scheduleDragUpdate(cell: GridCellPosition): void {
    pendingCell = cell;
    if (dragFrame !== null) return;
    dragFrame = window.requestAnimationFrame(() => {
      dragFrame = null;
      const nextCell = pendingCell;
      pendingCell = null;
      if (nextCell) updateDrag(nextCell);
    });
  }

  function cellAtPoint(x: number, y: number): GridCellPosition | null {
    const element = document.elementFromPoint?.(x, y) ?? null;
    return deps.cellFromElement(element);
  }

  function cellAtDragPoint(state: GridCellDragState): GridCellPosition | null {
    const body = deps.bodyScrollElement(state.tableElement);
    const rect = body?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return cellAtPoint(state.lastX, state.lastY);
    }
    const x = Math.max(rect.left + 1, Math.min(rect.right - 1, state.lastX));
    const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, state.lastY));
    return cellAtPoint(x, y);
  }

  function updateAutoScroll(event: PointerEvent): void {
    const state = dragState;
    if (!state || !state.dragging) return;
    const body = deps.bodyScrollElement(state.tableElement);
    const rect = body?.getBoundingClientRect() ?? state.tableElement.getBoundingClientRect();
    const edgeSize = 42;
    const direction = gridAutoScrollVector(event.clientX, event.clientY, rect, edgeSize);
    if (
      state.horizontalScrollDirection === direction.horizontal &&
      state.verticalScrollDirection === direction.vertical
    ) return;

    state.horizontalScrollDirection = direction.horizontal;
    state.verticalScrollDirection = direction.vertical;
    clearAutoScroll();
    if (direction.horizontal === 0 && direction.vertical === 0) return;

    const scrollFrame = (timestamp: number): void => {
      autoScrollFrame = null;
      const currentState = dragState;
      if (!currentState) {
        clearAutoScroll();
        return;
      }
      const horizontalDirection = currentState.horizontalScrollDirection;
      const verticalDirection = currentState.verticalScrollDirection;
      if (horizontalDirection === 0 && verticalDirection === 0) {
        clearAutoScroll();
        return;
      }
      const elapsed = autoScrollTimestamp === null
        ? 1000 / 60
        : Math.min(50, timestamp - autoScrollTimestamp);
      autoScrollTimestamp = timestamp;
      const step = 480 * elapsed / 1000;
      const currentBody = deps.bodyScrollElement(currentState.tableElement);
      const currentLeft = currentBody?.scrollLeft ?? 0;
      const currentTop = currentBody?.scrollTop ?? 0;
      const maxLeft = currentBody
        ? Math.max(0, currentBody.scrollWidth - currentBody.clientWidth)
        : 0;
      const maxTop = currentBody
        ? Math.max(0, currentBody.scrollHeight - currentBody.clientHeight)
        : 0;
      const nextLeft = nextGridScrollOffset(currentLeft, maxLeft, horizontalDirection, step);
      const nextTop = nextGridScrollOffset(currentTop, maxTop, verticalDirection, step);
      if (nextLeft === currentLeft && nextTop === currentTop) {
        currentState.horizontalScrollDirection = 0;
        currentState.verticalScrollDirection = 0;
        clearAutoScroll();
        return;
      }
      if (nextLeft !== currentLeft) {
        if (deps.tableRef.value) deps.tableRef.value.scrollToLeft(nextLeft);
        else if (currentBody) currentBody.scrollLeft = nextLeft;
      }
      if (nextTop !== currentTop) {
        if (deps.tableRef.value) deps.tableRef.value.scrollToTop(nextTop);
        else if (currentBody) currentBody.scrollTop = nextTop;
      }
      const cell = cellAtDragPoint(currentState);
      if (cell) updateDrag(cell);
      autoScrollFrame = window.requestAnimationFrame(scrollFrame);
    };
    autoScrollFrame = window.requestAnimationFrame(scrollFrame);
  }

  function handleWheelDuringDrag(event: WheelEvent): void {
    const state = dragState;
    if (!state?.dragging) return;
    if (event.clientX || event.clientY) {
      state.lastX = event.clientX;
      state.lastY = event.clientY;
    }
    if (wheelUpdateTimer !== null) return;
    wheelUpdateTimer = window.setTimeout(() => {
      wheelUpdateTimer = null;
      const currentState = dragState;
      if (!currentState?.dragging) return;
      const cell = cellAtDragPoint(currentState);
      if (cell) updateDrag(cell);
    }, 0);
  }

  function stopGridCellDrag(resetClickSuppression = true): void {
    clearAutoScroll();
    clearDragFrame();
    clearWheelUpdate();
    document.removeEventListener("pointermove", handlePointerMove);
    document.removeEventListener("pointerup", handlePointerUp, true);
    document.removeEventListener("pointercancel", handlePointerCancel, true);
    document.removeEventListener("wheel", handleWheelDuringDrag);
    dragState = null;
    gridSelectionDragging.value = false;
    if (resetClickSuppression) {
      window.setTimeout(() => {
        suppressGridClick.value = false;
      }, 0);
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    const state = dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) !== 1) {
      stopGridCellDrag();
      return;
    }
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (!state.dragging) {
      const movedX = event.clientX - state.startX;
      const movedY = event.clientY - state.startY;
      if (Math.hypot(movedX, movedY) < deps.dragThreshold) return;
      state.dragging = true;
      gridSelectionDragging.value = true;
      suppressGridClick.value = true;
      event.preventDefault();
    } else {
      event.preventDefault();
    }
    const cell = cellAtPoint(event.clientX, event.clientY);
    if (cell) scheduleDragUpdate(cell);
    updateAutoScroll(event);
  }

  function handlePointerUp(event: PointerEvent): void {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (dragState.dragging) {
      event.preventDefault();
      flushDragFrame();
      if (dragState.mode !== "add") selection.materializeGridCellRangeSelection();
      // 自动滚动可能把焦点行滚出虚拟窗口，DOM 焦点已落回 body；
      // 必须把焦点放回选区端点，否则网格快捷键（Ctrl+D/C/V、方向键）全部失效。
      // 指针此时就在视口内，不滚动——nearest 会把半裁的端点行整行拉进视口。
      const focus = selection.activeGridCell.value;
      if (focus) deps.focusCell(focus, { scroll: false });
    }
    stopGridCellDrag();
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    stopGridCellDrag();
  }

  function handleGridPointerDown(event: PointerEvent): void {
    if (event.target instanceof Element && event.target.closest(".grid-fill-handle")) return;
    if (event.button !== 0 || event.isPrimary === false) return;
    const cell = deps.cellFromElement(event.target);
    if (!cell) return;
    if (deps.isEditingCell(cell)) return;
    const tableElement =
      event.target instanceof Element ? event.target.closest<HTMLElement>(".el-table-v2") : null;
    if (!tableElement) return;
    deps.commitActiveEdit();

    stopGridCellDrag(false);
    const modifierAdd = event.ctrlKey || event.metaKey;
    const modifierShift = event.shiftKey;
    const mode: GridCellDragMode = modifierAdd ? "add" : modifierShift ? "shift" : "replace";
    const anchor = modifierShift
      ? selection.gridSelectionAnchor.value ?? selection.activeGridCell.value ?? cell
      : cell;
    if (mode === "replace") selection.selectGridCell(cell);
    else selection.activeGridCell.value = cell;
    deps.focusCell(cell);
    dragState = {
      pointerId: event.pointerId,
      anchor: { ...cell },
      focus: { ...cell },
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      dragging: false,
      mode,
      initialSelectionKeys: new Set(selection.selectedGridCellKeys.value),
      tableElement,
      lastAppliedFocus: null,
      horizontalScrollDirection: 0,
      verticalScrollDirection: 0,
    };
    if (mode === "shift") dragState.anchor = cells.clamp(anchor);
    document.addEventListener("pointermove", handlePointerMove, { passive: false });
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerCancel, true);
    document.addEventListener("wheel", handleWheelDuringDrag, { passive: true });
  }

  return {
    gridSelectionDragging,
    suppressGridClick,
    stopGridCellDrag,
    flushGridCellDragFrame: flushDragFrame,
    gridCellAtPoint: cellAtPoint,
    handleGridPointerDown,
  };
}
