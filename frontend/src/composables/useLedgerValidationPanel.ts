import { ref, type Ref } from "vue";
import { ElMessage } from "element-plus";

import type { RecordValidationIssue } from "@/types/api";

/**
 * 台账校验确认面板（P1-5 校验层，同时是 P2-2 LedgerValidationDialog
 * 的接口契约：面板只暴露 `validationPanel` 状态与
 * `continueValidationCommit` / `cancelValidationPanel` 动作，
 * 对话框组件未来只接 props 与 emit，不反向依赖本模块）。
 *
 * 面板有两种“继续”路径：
 * 1. action 闭包（新增草稿、放弃修改回滚等调用方逻辑）；
 * 2. 批量 token 提交（两段式保存的第二段），由注入的
 *    `commitTokenPanel` 执行——提交、记录替换、状态标签与历史
 *    推送都属保存管线，留在调用方。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export type ValidationPanelState = {
  token: string;
  projectId: string;
  title: string;
  label: string;
  outcomeText: string;
  cancelText: string;
  continueText: string;
  issues: RecordValidationIssue[];
  affectedCount: number;
  skippedLocked: number;
  cellKeys: string[];
  cellVersions: Record<string, number>;
  canContinue: boolean;
};

export interface ValidationPanelHandlers {
  action?: () => Promise<void>;
  cancel?: () => void;
}

export function useLedgerValidationPanel(deps: {
  projectId: () => string;
  peekCellSaveVersion: (key: string) => number | undefined;
  commitTokenPanel: (panel: ValidationPanelState) => Promise<void>;
}): {
  validationPanel: Ref<ValidationPanelState | null>;
  validationCommitLoading: Ref<boolean>;
  openValidationPanel: (panel: ValidationPanelState, handlers?: ValidationPanelHandlers) => void;
  dismissValidationPanel: () => void;
  cancelValidationPanel: () => void;
  /** 面板是否挂有“继续”动作闭包（新增草稿确认等）。 */
  hasPendingValidationAction: () => boolean;
  continueValidationCommit: () => Promise<void>;
} {
  const validationPanel = ref<ValidationPanelState | null>(null);
  const validationCommitLoading = ref(false);
  let pendingAction: (() => Promise<void>) | null = null;
  let pendingCancel: (() => void) | null = null;

  function openValidationPanel(
    panel: ValidationPanelState,
    handlers?: ValidationPanelHandlers,
  ): void {
    pendingAction = handlers?.action ?? null;
    pendingCancel = handlers?.cancel ?? null;
    validationPanel.value = panel;
  }

  function dismissValidationPanel(): void {
    pendingAction = null;
    pendingCancel = null;
    validationPanel.value = null;
  }

  function hasPendingValidationAction(): boolean {
    return pendingAction !== null;
  }

  function cancelValidationPanel(): void {
    const cancel = pendingCancel;
    dismissValidationPanel();
    cancel?.();
  }

  async function continueValidationCommit(): Promise<void> {
    const panel = validationPanel.value;
    if (!panel?.canContinue) return;
    if (panel.projectId !== deps.projectId()) {
      dismissValidationPanel();
      ElMessage.warning("项目已切换，请重新执行该操作");
      return;
    }
    const staleCell = Object.entries(panel.cellVersions).some(
      ([key, version]) => (deps.peekCellSaveVersion(key) ?? 0) !== version,
    );
    if (staleCell) {
      dismissValidationPanel();
      ElMessage.warning("单元格内容已变化，请重新执行并预检查");
      return;
    }
    validationCommitLoading.value = true;
    try {
      if (pendingAction) {
        const action = pendingAction;
        await action();
        if (validationPanel.value === panel) dismissValidationPanel();
        return;
      }
      if (!panel.token) return;
      await deps.commitTokenPanel(panel);
      if (validationPanel.value === panel) dismissValidationPanel();
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "批量保存失败");
    } finally {
      validationCommitLoading.value = false;
    }
  }

  return {
    validationPanel,
    validationCommitLoading,
    openValidationPanel,
    dismissValidationPanel,
    cancelValidationPanel,
    hasPendingValidationAction,
    continueValidationCommit,
  };
}
