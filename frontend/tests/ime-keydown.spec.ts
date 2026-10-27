import { describe, expect, it } from "vitest";

import { isImeComposingKeydown } from "@/utils/imeKeydown";

function keydown(init: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", init);
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: init.keyCode });
  }
  return event;
}

describe("isImeComposingKeydown", () => {
  it("识别组合输入进行中的按键（isComposing）", () => {
    expect(isImeComposingKeydown(keydown({ key: "Process", isComposing: true }))).toBe(true);
  });

  it("识别输入法首键：keydown 的 isComposing 仍是 false，只有 keyCode 229 能认出来", () => {
    const firstKey = keydown({ key: "n", keyCode: 229 });
    expect(firstKey.isComposing).toBe(false);
    expect(isImeComposingKeydown(firstKey)).toBe(true);
  });

  it("兼容 which 别名", () => {
    const event = keydown({ key: "n" });
    Object.defineProperty(event, "which", { value: 229 });
    expect(isImeComposingKeydown(event)).toBe(true);
  });

  it("普通英文字符与快捷键不算输入法按键", () => {
    expect(isImeComposingKeydown(keydown({ key: "n" }))).toBe(false);
    expect(isImeComposingKeydown(keydown({ key: "Enter" }))).toBe(false);
    expect(isImeComposingKeydown(keydown({ key: "d", ctrlKey: true }))).toBe(false);
  });
});
