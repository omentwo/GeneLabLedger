/**
 * 输入法组合输入"首键"的判定。
 *
 * 中文/日文输入法里，一次「n → 你」的实际事件顺序是：
 *
 *   keydown(key="n", isComposing=false, keyCode=229)
 *   → compositionstart → compositionupdate("n") → … → compositionend("你")
 *
 * 也就是说 **组合输入真正开始之前，keydown 已经派发过一次**，此刻
 * `event.isComposing` 仍是 false。只看 `isComposing` 的代码会把拼音首字母
 * 当成普通英文字符处理：preventDefault 掐掉输入法、把 "n" 直接写进数据源，
 * 后续候选与组合状态全部丢失（表格类组件"只能输入第一个字母/首字母变成
 * 英文"的经典成因，Handsontable #10773、vxe-table 首字母丢失都是它）。
 *
 * Chromium / WebKit 用 `keyCode === 229`（"IME 正在处理这个按键"）标记这类
 * keydown，是唯一可靠的信号；`which` 是它的旧别名，一并兼容。
 */
export function isImeComposingKeydown(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode" | "which">,
): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.which === 229;
}

/**
 * 表格"打字即编辑"的输入法分流：这一下若是输入法首键，就只打开编辑器。
 *
 * 不能照普通字符的路径走——那条路径会 `preventDefault()`（掐掉输入法）
 * 并把 `event.key` 当内容注入（单元格里留下一个英文 "n"）。正确的做法是
 * 让组合输入落到随后获得焦点的输入框里：`beginEdit` 在微任务内完成聚焦，
 * 早于浏览器派发 compositionstart。
 *
 * 返回 true 表示已处理，调用方直接 return。
 */
export function beginEditForImeKey(
  event: KeyboardEvent,
  record: { locked: boolean } | null | undefined,
  beginEdit: () => void,
): boolean {
  if (!record || record.locked || !isImeComposingKeydown(event)) return false;
  event.stopPropagation();
  beginEdit();
  return true;
}
