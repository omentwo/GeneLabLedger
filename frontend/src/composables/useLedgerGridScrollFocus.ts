import { getCurrentInstance, onUpdated, type ComputedRef, type Ref } from "vue";
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
  /** 网格自己的键盘处理（handleGridKeydown），document 级路由的落点。 */
  handleKeydown: (event: KeyboardEvent) => void;
  /** 网格自己的粘贴处理（handleGridPaste）。 */
  handlePaste: (event: ClipboardEvent) => void;
  /** 输入框/可编辑元素内让原生剪贴板行为接管。 */
  isNativeClipboardTarget: (target: EventTarget | null) => boolean;
  /** 网格之外的浮层（查找替换等）正持有输入焦点时返回 true，补偿逻辑让路。 */
  isFocusOwnedElsewhere?: () => boolean;
}

export function useLedgerGridScrollFocus(deps: GridScrollFocusDeps): {
  keepGridFocusOnScroll: () => void;
  revealGridPasteTarget: (rowIndex: number, recordId: string | null) => void;
  restoreFocusAfterRender: () => void;
  attachDocumentShortcuts: () => () => void;
} {
  let trailingKeepTimer: number | undefined;

  function restoreFocusToCard(): void {
    // 单测等环境的销毁不经过本模块：env 拆除后残留的 rAF/补偿回调可能
    // 触发到这里，document 已不可用——直接短路，绝不向 CI 抛未处理错误。
    if (typeof document === "undefined") return;
    if (deps.isDisposed() || deps.selectionDragging.value) return;
    if (!deps.activeGridCell.value) return;
    // 焦点被网格之外的浮层（查找替换等）持有时让路，绝不抢回。
    if (deps.isFocusOwnedElsewhere?.()) return;
    // 本窗口没有 OS 焦点（如台账工具窗口正在前台）时，卡片补焦没有意义，
    // 还会在用户切回窗口时平白多出一个持焦卡片。
    if (!document.hasFocus()) return;
    // 只有焦点真正落回 body/documentElement 才补焦。焦点在其他交互元素
    // （工具栏按钮、查找框）上时绝不抢焦，否则破坏它们的键盘操作。
    const current = document.activeElement;
    if (current !== document.body && current !== document.documentElement) return;
    if (deps.editingCell.value) void deps.commitActiveEdit();
    deps.cardRef.value?.focus({ preventScroll: true });
  }

  function keepGridFocusOnScroll(): void {
    restoreFocusToCard();
    // 当前滚动事件触发的虚拟列表重渲染晚于本监听：焦点格的卸载发生在
    // 检查之后。若这是最后一次滚动，没有后续事件再来兜底，焦点会永远
    // 卡在 body 上——追加一次渲染完成后的自检（Vue 渲染是微任务，
    // 必然先于该定时器执行）。
    if (trailingKeepTimer !== undefined) return;
    trailingKeepTimer = window.setTimeout(() => {
      trailingKeepTimer = undefined;
      restoreFocusToCard();
    }, 0);
  }

  // 焦点丢失并不只发生在滚动里：拖拽结束的选区物化、单元格状态变化
  // 都会整行重建 DOM，把刚聚焦的元素连同焦点一起丢回 body。这里由
  // 视图的 onUpdated 驱动做渲染后一次性补偿——重渲染的 DOM 提交完成
  // 时触发，再排一帧 rAF 覆盖 el-table-v2 下一帧的行重建。确定性地
  // 紧跟肇事渲染，没有轮询的时间窗。
  function restoreFocusAfterRender(): void {
    if (deps.isDisposed() || deps.selectionDragging.value) return;
    if (!deps.activeGridCell.value) return;
    if (deps.isFocusOwnedElsewhere?.()) return;
    if (typeof document === "undefined") return;
    const current = document.activeElement;
    if (current !== document.body && current !== document.documentElement) return;
    window.requestAnimationFrame(() => restoreFocusToCard());
  }
  if (getCurrentInstance()) onUpdated(() => restoreFocusAfterRender());

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

  // 剪贴板/填充快捷键的确定性兜底：渲染替换焦点元素后焦点可能落在
  // body 上且没有任何后续事件，卡片级监听（@keydown.capture）依赖
  // 事件传播路径经过卡片，此时全部收不到。document 级监听用状态层
  // 的活动选区路由，快捷键不再依赖焦点位置——这是确定性修复，而非
  // 焦点恢复的时序补偿。目标在卡片内时交给卡片自己的监听，避免双重
  // 处理；目标在输入框内时让原生剪贴板行为接管。
  function isGridOwnedEventTarget(target: EventTarget | null): boolean {
    if (target instanceof Element && deps.cardRef.value?.contains(target)) return false;
    return !deps.isNativeClipboardTarget(target);
  }

  function handleDocumentKeydown(event: KeyboardEvent): void {
    if (deps.isDisposed() || deps.selectionDragging.value) return;
    if (!deps.activeGridCell.value) return;
    // 浮层（查找替换等）持有焦点期间，document 级网格快捷键一律让路。
    if (deps.isFocusOwnedElsewhere?.()) return;
    if (!isGridOwnedEventTarget(event.target)) return;
    deps.handleKeydown(event);
  }

  function handleDocumentPaste(event: ClipboardEvent): void {
    if (deps.isDisposed() || deps.selectionDragging.value) return;
    if (!deps.activeGridCell.value) return;
    if (deps.isFocusOwnedElsewhere?.()) return;
    if (!isGridOwnedEventTarget(event.target)) return;
    deps.handlePaste(event);
  }

  function attachDocumentShortcuts(): () => void {
    document.addEventListener("keydown", handleDocumentKeydown, true);
    document.addEventListener("paste", handleDocumentPaste, true);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeydown, true);
      document.removeEventListener("paste", handleDocumentPaste, true);
    };
  }

  return {
    keepGridFocusOnScroll,
    revealGridPasteTarget,
    restoreFocusAfterRender,
    attachDocumentShortcuts,
  };
}
