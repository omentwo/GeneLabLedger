/**
 * 台账单元格 DOM 的定位工具。
 *
 * 一个单元格在 DOM 里有两层都带 `data-row-id` / `data-field-index`：
 *
 *   <div class="el-table-v2__row-cell ledger-editor-column"
 *        data-row-id="…" data-field-index="2" role="cell">   ← cell-props 合并进来
 *     <div class="cell-field" data-row-id="…" data-field-index="2" tabindex="0">
 *       …输入框 / 文本…
 *     </div>
 *   </div>
 *
 * `querySelector` 按文档序返回第一个命中，也就是**外层包裹 div**——它没有
 * tabindex，`focus()` 是静默失败（焦点留在 body，不抛错）。于是"提交编辑后
 * 回到本格""Tab 到下一格"这类程序化聚焦全部落空，接下来的按键因为
 * `gridCellFromElement(document.activeElement)` 为 null 被整段丢弃，
 * 表现为"跳到某格之后打不了字"。所以定位必须优先取可聚焦的 `.cell-field`。
 */

/** 属性选择器引号内仅需转义反斜杠与双引号；不依赖 jsdom 未实现的 CSS.escape。 */
export function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 单元格的可聚焦根节点（`.cell-field`），结构变化时退回外层包裹层。 */
export function ledgerCellElement(
  root: ParentNode,
  rowId: string,
  fieldIndex: number,
): HTMLElement | null {
  const selector = `[data-row-id="${cssAttrValue(rowId)}"][data-field-index="${fieldIndex}"]`;
  return root.querySelector<HTMLElement>(`.cell-field${selector}`)
    ?? root.querySelector<HTMLElement>(selector);
}
