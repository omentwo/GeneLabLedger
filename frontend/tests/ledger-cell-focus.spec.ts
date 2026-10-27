import { describe, expect, it } from "vitest";

import { cssAttrValue, ledgerCellElement } from "@/utils/ledgerCellFocus";

/**
 * 复刻 el-table-v2 真实结构：`cell-props`（virtualCellProps）把
 * data-row-id / data-field-index 合并到外层 `.el-table-v2__row-cell`，
 * 单元格内容里的 `.cell-field` 又带一份同样的属性，且只有它带 tabindex。
 */
function buildTable(options: { withField?: boolean; rowId?: string } = {}): {
  root: HTMLElement;
  wrapper: HTMLElement;
} {
  const rowId = options.rowId ?? "record-1";
  const root = document.createElement("section");
  const wrapper = document.createElement("div");
  wrapper.className = "el-table-v2__row-cell ledger-editor-column";
  wrapper.dataset.rowId = rowId;
  wrapper.dataset.fieldIndex = "2";
  if (options.withField !== false) {
    const field = document.createElement("div");
    field.className = "cell-field";
    field.dataset.rowId = rowId;
    field.dataset.fieldIndex = "2";
    field.tabIndex = 0;
    wrapper.append(field);
  }
  root.append(wrapper);
  return { root, wrapper };
}

describe("ledgerCellElement", () => {
  it("优先返回带 tabindex 的 .cell-field，而不是 cell-props 打在外层的同名包裹层", () => {
    const { root, wrapper } = buildTable();
    const naive = root.querySelector('[data-row-id="record-1"][data-field-index="2"]');
    // 裸属性选择器按文档序命中外层 div —— 它没有 tabindex，focus() 静默失败。
    expect(naive).toBe(wrapper);
    expect(wrapper.tabIndex).toBe(-1);

    const target = ledgerCellElement(root, "record-1", 2);
    expect(target).toBe(wrapper.firstElementChild);
    expect(target?.tabIndex).toBe(0);
  });

  it("结构里没有 .cell-field 时退回外层包裹层", () => {
    const { root, wrapper } = buildTable({ withField: false });
    expect(ledgerCellElement(root, "record-1", 2)).toBe(wrapper);
  });

  it("行号或列号不匹配时返回 null", () => {
    const { root } = buildTable();
    expect(ledgerCellElement(root, "record-2", 2)).toBeNull();
    expect(ledgerCellElement(root, "record-1", 3)).toBeNull();
  });

  it("属性值里的引号与反斜杠被转义，选择器不会被打断", () => {
    expect(cssAttrValue('a"b\\c')).toBe('a\\"b\\\\c');
    const tricky = 'he said "hi" \\ ok';
    const { root, wrapper } = buildTable({ rowId: tricky });
    expect(ledgerCellElement(root, tricky, 2)).toBe(wrapper.firstElementChild);
  });
});
