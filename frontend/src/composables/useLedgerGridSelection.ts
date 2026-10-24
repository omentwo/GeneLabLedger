import { ref, type ComputedRef, type Ref } from "vue";

import type { FieldDefinition } from "@/types/api";
import type { LedgerRow } from "@/utils/ledgerTableView";
import {
  makeGridCellHelpers,
  normalizedGridRange,
  splitGridCellKey,
  type GridCellPosition,
  type GridCellRange,
} from "@/utils/gridSelectionModel";

/**
 * 台账网格选区的状态与核心操作（P1-3 胶水层）。
 *
 * 只负责“选中了哪些单元格”这一件事：四个选区状态、替换/切换/清空、
 * 选区位置展开、跨行身份的捕获与恢复（加载记录前后保持选区）。
 * 指针拖拽（rAF/自动滚动）与键盘导航留在视图层，通过这些方法驱动。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export interface LedgerGridSelectionDeps {
  fields: ComputedRef<FieldDefinition[]>;
  tableRows: ComputedRef<LedgerRow[]>;
  tableRowIndexById: ComputedRef<Map<string, number>>;
}

export function useLedgerGridSelection(deps: LedgerGridSelectionDeps): {
  activeGridCell: Ref<GridCellPosition | null>;
  gridCellRange: Ref<GridCellRange | null>;
  selectedGridCellKeys: Ref<Set<string>>;
  gridSelectionAnchor: Ref<GridCellPosition | null>;
  captureGridIdentity: (
    position: GridCellPosition | null,
  ) => { rowId: string; fieldId: string } | null;
  restoreGridIdentity: (
    identity: { rowId: string; fieldId: string } | null,
  ) => GridCellPosition | null;
  replaceGridCellSelection: (
    positions: GridCellPosition[],
    active: GridCellPosition,
    anchor?: GridCellPosition,
    range?: GridCellRange | null,
  ) => void;
  toggleGridCell: (position: GridCellPosition) => void;
  clearGridCellSelection: () => void;
  selectedGridCellPositions: () => GridCellPosition[];
  isGridCellSelected: (position: GridCellPosition) => boolean;
  selectGridCell: (position: GridCellPosition) => void;
  materializeGridCellRangeSelection: () => void;
} {
  const cells = makeGridCellHelpers(
    () => deps.tableRows.value,
    () => deps.fields.value,
  );
  const activeGridCell = ref<GridCellPosition | null>(null);
  const gridCellRange = ref<GridCellRange | null>(null);
  const selectedGridCellKeys = ref<Set<string>>(new Set());
  const gridSelectionAnchor = ref<GridCellPosition | null>(null);

  function captureGridIdentity(
    position: GridCellPosition | null,
  ): { rowId: string; fieldId: string } | null {
    if (!position) return null;
    const row = deps.tableRows.value[position.rowIndex];
    const field = deps.fields.value[position.columnIndex];
    return row && field ? { rowId: row.id, fieldId: field.id } : null;
  }

  function restoreGridIdentity(
    identity: { rowId: string; fieldId: string } | null,
  ): GridCellPosition | null {
    if (!identity) return null;
    const rowIndex = deps.tableRowIndexById.value.get(identity.rowId) ?? -1;
    const columnIndex = deps.fields.value.findIndex((field) => field.id === identity.fieldId);
    return rowIndex >= 0 && columnIndex >= 0 ? { rowIndex, columnIndex } : null;
  }

  function replaceGridCellSelection(
    positions: GridCellPosition[],
    active: GridCellPosition,
    anchor: GridCellPosition = active,
    range: GridCellRange | null = null,
  ): void {
    const keys = new Set(positions.map(cells.key).filter(Boolean));
    selectedGridCellKeys.value = keys;
    activeGridCell.value = cells.clamp(active);
    gridSelectionAnchor.value = cells.clamp(anchor);
    gridCellRange.value = range
      ? {
          anchor: { ...range.anchor },
          focus: { ...range.focus },
        }
      : null;
  }

  function toggleGridCell(position: GridCellPosition): void {
    const nextPosition = cells.clamp(position);
    const key = cells.key(nextPosition);
    if (!key) return;
    const keys = new Set(selectedGridCellKeys.value);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    selectedGridCellKeys.value = keys;
    activeGridCell.value = nextPosition;
    if (!gridSelectionAnchor.value) gridSelectionAnchor.value = nextPosition;
    gridCellRange.value = null;
  }

  function clearGridCellSelection(): void {
    selectedGridCellKeys.value = new Set();
    gridCellRange.value = null;
    gridSelectionAnchor.value = null;
  }

  function selectedGridCellPositions(): GridCellPosition[] {
    const selectedKeys = selectedGridCellKeys.value;
    if (!selectedKeys.size) return [];
    const rowIndexById = deps.tableRowIndexById.value;
    const columnIndexByFieldId = new Map(
      deps.fields.value.map((field, index) => [field.id, index] as const),
    );
    const positions: GridCellPosition[] = [];
    for (const key of selectedKeys) {
      const parts = splitGridCellKey(key);
      if (!parts) continue;
      const rowIndex = rowIndexById.get(parts[0]);
      const columnIndex = columnIndexByFieldId.get(parts[1]);
      if (rowIndex === undefined || columnIndex === undefined) continue;
      positions.push({ rowIndex, columnIndex });
    }
    positions.sort((left, right) => left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex);
    return positions;
  }

  function isGridCellSelected(position: GridCellPosition): boolean {
    const range = gridCellRange.value;
    if (range) {
      const normalized = normalizedGridRange(range);
      return (
        position.rowIndex >= normalized.rowStart &&
        position.rowIndex <= normalized.rowEnd &&
        position.columnIndex >= normalized.columnStart &&
        position.columnIndex <= normalized.columnEnd
      );
    }
    const key = cells.key(position);
    return Boolean(key && selectedGridCellKeys.value.has(key));
  }

  function selectGridCell(position: GridCellPosition): void {
    const nextPosition = cells.clamp(position);
    replaceGridCellSelection(
      [nextPosition],
      nextPosition,
      nextPosition,
      { anchor: { ...nextPosition }, focus: { ...nextPosition } },
    );
  }

  function materializeGridCellRangeSelection(): void {
    const range = gridCellRange.value;
    if (!range) return;
    selectedGridCellKeys.value = new Set(
      cells.positionsForRange(range).map(cells.key).filter(Boolean),
    );
  }

  return {
    activeGridCell,
    gridCellRange,
    selectedGridCellKeys,
    gridSelectionAnchor,
    captureGridIdentity,
    restoreGridIdentity,
    replaceGridCellSelection,
    toggleGridCell,
    clearGridCellSelection,
    selectedGridCellPositions,
    isGridCellSelected,
    selectGridCell,
    materializeGridCellRangeSelection,
  };
}
