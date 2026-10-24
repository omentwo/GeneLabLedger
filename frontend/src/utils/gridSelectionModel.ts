/**
 * 台账网格选区的纯函数模型层。
 *
 * 这里只放不接触 Vue 响应式状态的网格坐标运算与单元格键编解码：
 * 越界钳制、Tab 步进、范围归一化、`rowId\u0000fieldId` 键的拆装。
 * 尺寸与行列列表一律作为参数传入，使每个函数都可以独立单测；
 * LedgerView 里的同名薄封装负责把 `tableRows`/`fields` 注入进来。
 */

export type GridCellPosition = { rowIndex: number; columnIndex: number };
export type GridCellRange = { anchor: GridCellPosition; focus: GridCellPosition };
export type NormalizedGridRange = {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
};
export type GridSize = { rowCount: number; columnCount: number };
export type GridCellSelectionSnapshot = {
  active: GridCellPosition | null;
  anchor: GridCellPosition | null;
  range: GridCellRange | null;
  selectedKeys: Set<string>;
};

/** 单元格键的分隔符；行/列 id 本身是系统生成的 UUID，不会包含该字符。 */
export const GRID_CELL_KEY_SEPARATOR = "\u0000";

export function clampGridCell(position: GridCellPosition, size: GridSize): GridCellPosition {
  return {
    rowIndex: Math.max(0, Math.min(size.rowCount - 1, position.rowIndex)),
    columnIndex: Math.max(0, Math.min(size.columnCount - 1, position.columnIndex)),
  };
}

export function moveGridCell(
  position: GridCellPosition,
  rowDelta: number,
  columnDelta: number,
  size: GridSize,
): GridCellPosition {
  return clampGridCell(
    {
      rowIndex: position.rowIndex + rowDelta,
      columnIndex: position.columnIndex + columnDelta,
    },
    size,
  );
}

export function moveGridCellByTab(
  position: GridCellPosition,
  backwards: boolean,
  size: GridSize,
): GridCellPosition {
  const { rowCount, columnCount } = size;
  if (!columnCount || !rowCount) return clampGridCell(position, size);
  const lastIndex = rowCount * columnCount - 1;
  const currentIndex = position.rowIndex * columnCount + position.columnIndex;
  const nextIndex = Math.max(0, Math.min(lastIndex, currentIndex + (backwards ? -1 : 1)));
  return {
    rowIndex: Math.floor(nextIndex / columnCount),
    columnIndex: nextIndex % columnCount,
  };
}

export function normalizedGridRange(range: GridCellRange): NormalizedGridRange {
  return {
    rowStart: Math.min(range.anchor.rowIndex, range.focus.rowIndex),
    rowEnd: Math.max(range.anchor.rowIndex, range.focus.rowIndex),
    columnStart: Math.min(range.anchor.columnIndex, range.focus.columnIndex),
    columnEnd: Math.max(range.anchor.columnIndex, range.focus.columnIndex),
  };
}

export function gridCellKey(
  position: GridCellPosition,
  rows: ReadonlyArray<{ id: string }>,
  fields: ReadonlyArray<{ id: string }>,
): string {
  const row = rows[position.rowIndex];
  const field = fields[position.columnIndex];
  return row && field ? `${row.id}${GRID_CELL_KEY_SEPARATOR}${field.id}` : "";
}

export function gridCellPositionsForRange(
  range: GridCellRange,
  rows: ReadonlyArray<{ id: string }>,
  fields: ReadonlyArray<{ id: string }>,
): GridCellPosition[] {
  const normalized = normalizedGridRange(range);
  const positions: GridCellPosition[] = [];
  for (let rowIndex = normalized.rowStart; rowIndex <= normalized.rowEnd; rowIndex += 1) {
    for (
      let columnIndex = normalized.columnStart;
      columnIndex <= normalized.columnEnd;
      columnIndex += 1
    ) {
      if (gridCellKey({ rowIndex, columnIndex }, rows, fields)) positions.push({ rowIndex, columnIndex });
    }
  }
  return positions;
}

export function splitGridCellKey(key: string): [rowId: string, fieldId: string] | null {
  const separatorIndex = key.indexOf(GRID_CELL_KEY_SEPARATOR);
  if (separatorIndex < 0) return null;
  return [
    key.slice(0, separatorIndex),
    key.slice(separatorIndex + GRID_CELL_KEY_SEPARATOR.length),
  ];
}

export function sameGridCell(
  left: GridCellPosition | null,
  right: GridCellPosition | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.rowIndex === right.rowIndex &&
      left.columnIndex === right.columnIndex,
  );
}

/**
 * 把行/列表的 getter 绑定成视图与组合式函数共用的便捷包装，
 * 消除两处各自维护 `clampGridCell`/`gridCellKey` 薄封装的重复。
 */
export function makeGridCellHelpers(
  rows: () => ReadonlyArray<{ id: string }>,
  fields: () => ReadonlyArray<{ id: string }>,
): {
  size: () => GridSize;
  clamp: (position: GridCellPosition) => GridCellPosition;
  key: (position: GridCellPosition) => string;
  positionsForRange: (range: GridCellRange) => GridCellPosition[];
} {
  const size = (): GridSize => ({ rowCount: rows().length, columnCount: fields().length });
  return {
    size,
    clamp: (position) => clampGridCell(position, size()),
    key: (position) => gridCellKey(position, rows(), fields()),
    positionsForRange: (range) => gridCellPositionsForRange(range, rows(), fields()),
  };
}
