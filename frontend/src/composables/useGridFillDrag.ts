import { reactive, ref, type ComputedRef, type Ref } from "vue";

import { buildGridFillEntries } from "@/utils/ledgerFill";
import { getRecordFieldValue as valueFor } from "@/utils/recordFieldValue";
import { normalizedGridRange, type GridCellPosition, type NormalizedGridRange } from "@/utils/gridSelectionModel";
import type { FieldDefinition } from "@/types/api";
import type { LedgerRow } from "@/utils/ledgerTableView";
import type { GridFillMode } from "@/utils/ledgerFill";

/**
 * 台账填充柄拖拽与实时预览（P1-4 填充交互层）。
 *
 * 拥有填充拖拽状态机、预览气泡状态（范围 / 源区域 / 预览值 / 指针位置）
 * 和 document 级监听生命周期。实际写入走注入的 `applyFill`——
 * 它最终调用 pasteGrid 保存管线，与 useLedgerCellSave 同属保存侧，
 * 因此保留在视图中（P1-5 之后再评估是否下沉）。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export type GridFillDragState = {
  pointerId: number;
  source: NormalizedGridRange;
  target: NormalizedGridRange;
  mode: GridFillMode;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  tableElement: HTMLElement;
  finishPromise: Promise<boolean>;
};

export interface GridFillDragDeps {
  fields: ComputedRef<FieldDefinition[]>;
  tableRows: ComputedRef<LedgerRow[]>;
  gridCellRange: Ref<{ anchor: GridCellPosition; focus: GridCellPosition } | null>;
  suppressGridClick: Ref<boolean>;
  cellFromElement: (element: EventTarget | null) => GridCellPosition | null;
  cellAtPoint: (x: number, y: number) => GridCellPosition | null;
  /** 编辑中的单元格先提交；返回是否可以继续填充。 */
  commitEditThen: () => Promise<boolean>;
  applyFill: (source: NormalizedGridRange, target: NormalizedGridRange, mode: GridFillMode) => Promise<void>;
  dragThreshold: number;
}

export function useGridFillDrag(deps: GridFillDragDeps): {
  gridFillPreviewRange: Ref<NormalizedGridRange | null>;
  gridFillPreviewSource: Ref<NormalizedGridRange | null>;
  gridFillPreviewValues: Ref<Map<string, string>>;
  gridFillPreviewSummary: Ref<string>;
  gridFillPreviewPointer: { left: number; top: number };
  stopGridFillDrag: () => void;
  handleGridFillPointerDown: (event: PointerEvent) => void;
} {
  const gridFillPreviewRange = ref<NormalizedGridRange | null>(null);
  const gridFillPreviewSource = ref<NormalizedGridRange | null>(null);
  const gridFillPreviewValues = ref(new Map<string, string>());
  const gridFillPreviewSummary = ref("");
  const gridFillPreviewPointer = reactive({ left: 0, top: 0 });
  let dragState: GridFillDragState | null = null;

  function gridFillTargetForCell(
    source: NormalizedGridRange,
    cell: GridCellPosition,
  ): NormalizedGridRange {
    return {
      rowStart: Math.min(source.rowStart, cell.rowIndex),
      rowEnd: Math.max(source.rowEnd, cell.rowIndex),
      columnStart: Math.min(source.columnStart, cell.columnIndex),
      columnEnd: Math.max(source.columnEnd, cell.columnIndex),
    };
  }

  function updateGridFillPreview(
    target: NormalizedGridRange,
    source: NormalizedGridRange,
    mode: GridFillMode,
    pointer?: { x: number; y: number },
    currentCell?: GridCellPosition,
  ): void {
    gridFillPreviewSource.value = { ...source };
    gridFillPreviewRange.value = { ...target };
    const entries = buildGridFillEntries(
      source,
      target,
      deps.fields.value,
      deps.tableRows.value,
      valueFor,
      mode,
    );
    const values = new Map<string, string>();
    entries.forEach((entry) => {
      values.set(
        `${source.rowStart + entry.rowOffset}:${source.columnStart + entry.columnOffset}`,
        entry.value,
      );
    });
    gridFillPreviewValues.value = values;
    const currentKey = currentCell ? `${currentCell.rowIndex}:${currentCell.columnIndex}` : "";
    const currentValue = currentKey ? values.get(currentKey) : undefined;
    gridFillPreviewSummary.value = currentValue === undefined ? "" : currentValue || "（空）";
    if (pointer) {
      gridFillPreviewPointer.left = Math.max(8, Math.min(window.innerWidth - 360, pointer.x + 14));
      gridFillPreviewPointer.top = Math.max(8, Math.min(window.innerHeight - 96, pointer.y + 14));
    }
  }

  function clearGridFillPreview(): void {
    gridFillPreviewRange.value = null;
    gridFillPreviewSource.value = null;
    gridFillPreviewValues.value = new Map();
    gridFillPreviewSummary.value = "";
  }

  function stopGridFillDrag(): void {
    document.removeEventListener("pointermove", handleGridFillPointerMove);
    document.removeEventListener("pointerup", handleGridFillPointerUp, true);
    document.removeEventListener("pointercancel", handleGridFillPointerCancel, true);
    dragState = null;
    clearGridFillPreview();
  }

  function handleGridFillPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || event.isPrimary === false) return;
    const range = deps.gridCellRange.value;
    if (!range) return;
    const source = normalizedGridRange(range);
    const cell = deps.cellFromElement(event.target);
    if (!cell || cell.rowIndex !== source.rowEnd || cell.columnIndex !== source.columnEnd) return;
    const tableElement =
      event.target instanceof Element ? event.target.closest<HTMLElement>(".el-table-v2") : null;
    if (!tableElement) return;
    const finishPromise = deps.commitEditThen();
    stopGridFillDrag();
    dragState = {
      pointerId: event.pointerId,
      source,
      target: { ...source },
      mode: event.ctrlKey ? "copy" : "series",
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      dragging: false,
      tableElement,
      finishPromise,
    };
    document.addEventListener("pointermove", handleGridFillPointerMove, { passive: false });
    document.addEventListener("pointerup", handleGridFillPointerUp, true);
    document.addEventListener("pointercancel", handleGridFillPointerCancel, true);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleGridFillPointerMove(event: PointerEvent): void {
    const state = dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (!state.dragging) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < deps.dragThreshold) {
        return;
      }
      state.dragging = true;
      deps.suppressGridClick.value = true;
    }
    const cell = deps.cellAtPoint(event.clientX, event.clientY);
    if (cell) {
      state.mode = event.ctrlKey ? "copy" : "series";
      state.target = gridFillTargetForCell(state.source, cell);
      updateGridFillPreview(
        state.target,
        state.source,
        state.mode,
        { x: event.clientX, y: event.clientY },
        cell,
      );
    }
    event.preventDefault();
  }

  async function handleGridFillPointerUp(event: PointerEvent): Promise<void> {
    const state = dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    const shouldFill = state.dragging;
    const source = state.source;
    const target = state.target;
    const mode: GridFillMode = event.ctrlKey ? "copy" : "series";
    const finishPromise = state.finishPromise;
    if (shouldFill) {
      event.preventDefault();
      deps.suppressGridClick.value = true;
    }
    stopGridFillDrag();
    if (shouldFill && (await finishPromise)) await deps.applyFill(source, target, mode);
  }

  function handleGridFillPointerCancel(event: PointerEvent): void {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    stopGridFillDrag();
  }

  return {
    gridFillPreviewRange,
    gridFillPreviewSource,
    gridFillPreviewValues,
    gridFillPreviewSummary,
    gridFillPreviewPointer,
    stopGridFillDrag,
    handleGridFillPointerDown,
  };
}
