import type { RecordValidationIssue } from "@/types/api";

export type ValidationPromptContext = "create" | "edit" | "batch";
export type ValidationCancelBehavior = "discard" | "return";

export interface ValidationPromptCopy {
  title: string;
  outcomeText: string;
  cancelText: string;
  continueText: string;
}

export interface ValidationPromptOptions {
  context: ValidationPromptContext;
  cancelBehavior: ValidationCancelBehavior;
  originalValue?: string;
  operationLabel?: string;
}

export function hasDuplicatePathologyWarning(
  issues: Pick<RecordValidationIssue, "severity" | "message">[],
): boolean {
  return issues.some(
    (issue) =>
      issue.severity === "warning"
      && issue.message.includes("病理号")
      && (issue.message.includes("已存在") || issue.message.includes("重复")),
  );
}

export function buildValidationPromptCopy(
  issues: Pick<RecordValidationIssue, "severity" | "message">[],
  options: ValidationPromptOptions,
): ValidationPromptCopy {
  const duplicatePathology = hasDuplicatePathologyWarning(issues);
  const title = duplicatePathology ? "发现重复病理号" : "保存前请确认";

  if (options.context === "create") {
    const returnsToEdit = options.cancelBehavior === "return";
    return {
      title,
      outcomeText: duplicatePathology
        ? returnsToEdit
          ? "继续将新增一条独立记录，不会覆盖已有记录；返回修改不会保存当前内容。"
          : "继续将新增一条独立记录，不会覆盖已有记录；取消将放弃本次新增。"
        : returnsToEdit
          ? "继续将保存当前录入；返回修改不会保存当前内容。"
          : "继续将保存当前录入；取消将放弃本次新增。",
      cancelText: returnsToEdit ? "返回修改（不保存）" : "放弃本次新增",
      continueText: duplicatePathology ? "仍然新增重复记录" : "仍然新增记录",
    };
  }

  if (options.context === "edit") {
    const returnsToEdit = options.cancelBehavior === "return";
    const restoredValue = options.originalValue?.trim()
      ? duplicatePathology
        ? `原病理号“${options.originalValue.trim()}”`
        : `原值“${options.originalValue.trim()}”`
      : "原值";
    return {
      title,
      outcomeText: duplicatePathology
        ? returnsToEdit
          ? "继续将保存当前修改，不会覆盖其他记录；返回修改不会保存当前内容。"
          : `继续将保存当前修改，不会覆盖其他记录；取消将恢复为${restoredValue}。`
        : returnsToEdit
          ? "继续将保存当前修改；返回修改不会保存当前内容。"
          : `继续将保存当前修改；取消将恢复为${restoredValue}。`,
      cancelText: returnsToEdit ? "返回修改（不保存）" : "取消修改并恢复原值",
      continueText: duplicatePathology ? "仍然保存重复病理号" : "仍然保存修改",
    };
  }

  const operationLabel = options.operationLabel?.trim() || "本次操作";
  return {
    title,
    outcomeText: `继续将保存${operationLabel}产生的更改；取消将恢复${operationLabel}前的内容。`,
    cancelText: "取消并恢复原值",
    continueText: duplicatePathology ? "仍然保存这些数据" : "仍然保存更改",
  };
}

export function isValidationSnapshotCurrent(
  snapshotVersion: number,
  currentVersion: number | undefined,
): boolean {
  return snapshotVersion === (currentVersion ?? 0);
}
