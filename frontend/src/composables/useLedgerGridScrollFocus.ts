import { type ComputedRef, type Ref } from "vue";
import type { TableV2Instance } from "element-plus";

import type { GridCellPosition } from "@/utils/gridSelectionModel";

/**
 * 台账网格滚动视口的焦点保持与粘贴落点回位。
 *
 * 虚拟滚动会把持有 DOM 焦点的单元格卸载出 DOM，焦点静默落回 body
 * （元素移除不派发 blur），keydown/paste 的传播路径随之脱离表格卡片，
 * 绑在卡片上的剪贴板/快捷键监听（LedgerView 的 @keydown.capture /
 * @paste.capture）全部收不到事件——目标格滚出视野后 Ctrl+V/Ctrl+D
 * 静默失效。keepGridFocusOnScroll 在滚动时把焦点收回卡片
 * （tabindex="-1" 的编程式焦点），事件传播路径即恢复，剪贴板与
 * 快捷键分支里已有的 activeGridCell 回退随之生效。
 * revealGridPasteTarget 在屏外粘贴提交完成后把视图带回落点并瞬时高亮。
 *
 * 性能约定：
 * 1. keepGridFocusOnScroll 挂在每帧必达的 @scroll 上，条件判断必须
 *    先于任何 DOM 读取；首次 focus 后 activeElement 变为卡片，后续
 *    滚动帧全部早退，60Hz 滚动下实际只调用一次 focus。
 * 2. focus 必须带 preventScroll——否则浏览器为露出焦点元素滚动祖先
 *    容器，与进行中的滚动逐帧互相修正，表现为视图抖动。
 * 3. 选区拖拽的自动滚动期间必须跳过（selectionDragging），否则与
 *    useGridPointerDrag 的逐帧 scrollToTop 互相覆盖。
 */
export interface GridScrollFocusDeps {
  cardRef: Ref<HTMLElement | null>;
  tableRef: Ref<TableV2Instance | null>;
  rowHeight: ComputedRef<number>;
  bodyScrollElement: (card: HTMLElement) => HTMLElement | null;
  activeGridCell: Ref<GridCellPosition | null>;
  selectionDragging: Ref<boolean>;
  editingCell: Ref<GridCellPosition | null>;
  commitActiveEdit: () => Promise<boolean>;
  isDisposed: () => boolean;
  /** 瞬时高亮一条记录（约 2s 自动清除），复用查找定位的视觉语言。 */
  flashRecord: (recordId: string) => void;
}

export function useLedgerGridScrollFocus(deps: GridScrollFocusDeps): {
  keepGridFocusOnScroll: () => void;
  revealGridPasteTarget: (rowIndex: number, recordId: string | null) => void;
} {
  function keepGridFocusOnScroll(): void {
    if (deps.isDisposed() || deps.selectionDragging.value) return;
    if (!deps.activeGridCell.value) return;
    // 只有焦点真正落回 body/documentElement 才补焦。焦点在其他交互元素
    // （工具栏按钮、查找框）上时绝不抢焦，否则破坏它们的键盘操作。
    const current = document.activeElement;
    if (current !== document.body && current !== document.documentElement) return;
    if (deps.editingCell.value) void deps.commitActiveEdit();
    deps.cardRef.value?.focus({ preventScroll: true });
  }

  function isRowVisible(rowIndex: number): boolean {
    const card = deps.cardRef.value;
    if (!card) return true;
    const body = deps.bodyScrollElement(card);
    const rowHeight = deps.rowHeight.value;
    if (!body || rowHeight <= 0) return true;
    const firstVisible = Math.floor(body.scrollTop / rowHeight);
    const lastVisible = Math.ceil((body.scrollTop + body.clientHeight) / rowHeight) - 1;
    return rowIndex >= firstVisible && rowIndex <= lastVisible;
  }

  function revealGridPasteTarget(rowIndex: number, recordId: string | null): void {
    // 仅当粘贴起点不在可视窗口内才回位：可视区内的粘贴保持视口不动，
    // 是 pasteGrid 既有约定（新增草稿行不得把视图拖到底部）。
    if (deps.isDisposed() || rowIndex < 0 || isRowVisible(rowIndex)) return;
    deps.tableRef.value?.scrollToRow(rowIndex, "center");
    if (recordId) deps.flashRecord(recordId);
  }

  return { keepGridFocusOnScroll, revealGridPasteTarget };
}
