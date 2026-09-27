import { describe, expect, it } from "vitest";

import {
  buildValidationPromptCopy,
  hasDuplicatePathologyWarning,
  isValidationSnapshotCurrent,
} from "@/utils/validationPrompt";

const duplicateWarning = {
  record_id: "record-1",
  field_id: "pathology-number",
  severity: "warning" as const,
  message: "当前项目已存在 1 条病理号“P-100”的记录，请确认是否重复录入",
};

describe("validation prompt copy", () => {
  it("makes both outcomes explicit when editing to a duplicate pathology number", () => {
    expect(buildValidationPromptCopy([duplicateWarning], {
      context: "edit",
      cancelBehavior: "discard",
      originalValue: "P-099",
    })).toEqual({
      title: "发现重复病理号",
      outcomeText: "继续将保存当前修改，不会覆盖其他记录；取消将恢复为原病理号“P-099”。",
      cancelText: "取消修改并恢复原值",
      continueText: "仍然保存重复病理号",
    });
  });

  it("explains that quick-entry cancellation returns to an unsaved form", () => {
    expect(buildValidationPromptCopy([duplicateWarning], {
      context: "create",
      cancelBehavior: "return",
    })).toMatchObject({
      title: "发现重复病理号",
      cancelText: "返回修改（不保存）",
      continueText: "仍然新增重复记录",
    });
  });

  it("uses batch-specific rollback wording", () => {
    expect(buildValidationPromptCopy([duplicateWarning], {
      context: "batch",
      cancelBehavior: "discard",
      operationLabel: "粘贴",
    })).toMatchObject({
      cancelText: "取消并恢复原值",
      continueText: "仍然保存这些数据",
      outcomeText: "继续将保存粘贴产生的更改；取消将恢复粘贴前的内容。",
    });
  });

  it("does not classify unrelated warnings as duplicate pathology warnings", () => {
    const unrelatedWarning = {
      ...duplicateWarning,
      message: "实验日期晚于今天，请确认",
    };
    expect(hasDuplicatePathologyWarning([unrelatedWarning])).toBe(false);
    expect(buildValidationPromptCopy([unrelatedWarning], {
      context: "edit",
      cancelBehavior: "discard",
      originalValue: "2026-09-26",
    }).outcomeText).toContain("恢复为原值“2026-09-26”");
  });
});

describe("validation rollback version guard", () => {
  it("restores only the snapshot that still matches the current edit", () => {
    expect(isValidationSnapshotCurrent(4, 4)).toBe(true);
    expect(isValidationSnapshotCurrent(4, 5)).toBe(false);
    expect(isValidationSnapshotCurrent(0, undefined)).toBe(true);
  });
});
