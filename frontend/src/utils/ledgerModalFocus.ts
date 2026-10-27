/**
 * 台账模态浮层的焦点归属判定。
 *
 * 校验确认面板、查找替换、导出面板等 Element Plus 浮层都 `append-to-body`
 * 挂在 body 上，打开时必然把焦点从单元格里拿走。在 DOM 事件层面，这与
 * "用户点去编辑另一个格子"完全一样（都是 focusout），语义却相反：
 * 前者绝不能触发提交——否则每弹一次面板都会被自己的失焦事件再存一次，
 * 保存把面板关掉、预检查回来又重开，面板随渲染节拍反复销毁重建，
 * 焦点在表格卡片与面板之间来回抢，整页闪动且点不动（表现为"卡死"）。
 *
 * 因此"焦点是否属于网格之外的浮层"必须同时看两处：
 * 1. 状态位（面板/对话框的 visible ref）——浮层刚打开、焦点还没落位时
 *    `document.activeElement` 仍可能是 body，只看 DOM 会漏判；
 * 2. DOM 位（activeElement 是否落在浮层容器内）——浮层可能由子组件自行
 *    打开，状态位不在本视图手里。
 */
export const LEDGER_MODAL_FOCUS_SELECTOR =
  ".el-overlay, .el-dialog, .el-message-box, [role='dialog'], [role='alertdialog']";

/** 该元素是否落在模态浮层（overlay / 对话框）内部。 */
export function focusOwnedByModalOverlay(element: Element | null | undefined): boolean {
  if (!element || typeof element.closest !== "function") return false;
  return element.closest(LEDGER_MODAL_FOCUS_SELECTOR) !== null;
}

/** 浮层是否持有焦点：状态位或 DOM 位任一成立即视为让路。 */
export function modalOverlayOwnsFocus(
  overlayOpen: boolean,
  activeElement: Element | null | undefined,
): boolean {
  return overlayOpen || focusOwnedByModalOverlay(activeElement);
}
