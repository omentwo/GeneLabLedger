import { ref, type Ref } from "vue";
import type { Router } from "vue-router";
import { ElMessage } from "element-plus";

import { applyReorderByDate, previewReorderByDate } from "@/api/records";
import type { Project, RecordReorderByDatePreview } from "@/types/api";
import type { FindReplaceMode } from "@/composables/useLedgerFindReplace";
import { shanghaiDateKey } from "@/utils/datetime";
import { desktopBridge } from "@/utils/desktop";
import { logError } from "@/utils/logger";
import type {
  LedgerRecordLocate,
  LedgerToolsChangedPayload,
  LedgerToolsOpenContext,
  LedgerToolsProjectChange,
} from "@/types/electron";

/**
 * 台账工具窗口在主窗口侧的接入层（含快速录入窗口入口）。
 *
 * 1. 入口分流：桌面端走 openQuickEntry / openLedgerTools 独立窗口；浏览器
 *    降级路径保持原弹窗行为（managerVisible / 重排弹窗 / openFindReplace）。
 * 2. ledger-tools-changed 待处理变更队列：与快速录入同一套“主进程记账 →
 *    主窗口消费 → ack”模式；fields 动作额外重载项目与列布局。
 * 3. 工具窗口“定位到主表”“项目切换”事件的消费；网格定位细节
 *    （locateRecordInGrid）留在视图层经依赖注入。
 */
export interface LedgerToolsWindowsDeps {
  getActiveProjectId: () => string;
  getCurrentProject: () => Project | undefined;
  router: Router;
  managerVisible: Ref<boolean>;
  getFindReplaceMode: () => FindReplaceMode;
  getFindReplaceVisible: () => boolean;
  openFindReplace: (mode?: FindReplaceMode, reset?: boolean) => void;
  isDisposed: () => boolean;
  isPreparingClose: () => boolean;
  hasPendingLedgerEdits: () => boolean;
  invalidateProjectRecordCache: (projectId: string) => void;
  loadRecords: (
    projectId: string,
    options?: {
      showLoading?: boolean;
      preserveHistory?: boolean;
      preserveSelection?: boolean;
      deferForPendingEdits?: boolean;
    },
  ) => Promise<boolean>;
  reloadProjects: () => Promise<void>;
  applyProjectLayout: (projectId: string) => void;
  persistProjectLayout: (projectId: string) => Promise<void>;
  selectProject: (projectId: string) => void;
  locateRecordInGrid: (payload: LedgerRecordLocate) => void;
}

export function useLedgerToolsWindows(deps: LedgerToolsWindowsDeps): {
  openQuickEntry: () => Promise<void>;
  handleManageProjectsAction: () => void;
  handleReorderAction: () => void;
  handleFindReplaceAction: (mode: FindReplaceMode) => void;
  reorderDialogVisible: Ref<boolean>;
  reorderDate: Ref<string>;
  reorderPreview: Ref<RecordReorderByDatePreview | null>;
  reorderLoading: Ref<boolean>;
  openReorderDialog: () => void;
  loadReorderPreview: () => Promise<void>;
  confirmReorderByDate: () => Promise<void>;
  handleLedgerToolsChanged: (payload: LedgerToolsChangedPayload) => void;
  handleLedgerToolsProjectSelected: (payload: { projectId: string }) => void;
  handleLedgerToolsLocateRecord: (payload: LedgerRecordLocate) => void;
  requestPendingToolChanges: () => Promise<void>;
  attachToolsWindowListeners: () => void;
  disposeToolsWindowListeners: () => void;
} {
  const RETRY_DELAY_MS = 500;
  let toolRefreshPromise: Promise<void> = Promise.resolve();
  let toolRetryTimer: number | undefined;
  const toolRetryPending = new Map<string, LedgerToolsProjectChange>();
  let removeToolChangedListener: (() => void) | undefined;
  let removeToolProjectSelectedListener: (() => void) | undefined;
  let removeToolLocateListener: (() => void) | undefined;

  async function openQuickEntry(): Promise<void> {
    const project = deps.getCurrentProject();
    if (!project) return;
    const selectedFieldIds = project.fields
      .filter((field) => field.is_core || !field.hidden)
      .sort((left, right) => left.sort_order - right.sort_order)
      .map((field) => field.id);
    const context = {
      projectId: project.id,
      selectedFieldIds,
    };
    const bridge = desktopBridge();
    if (bridge) {
      try {
        await bridge.openQuickEntry(context);
      } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : "快速录入窗口打开失败");
      }
      return;
    }
    const target = deps.router.resolve({
      name: "quick-entry",
      query: {
        project: context.projectId,
        fields: context.selectedFieldIds.join(","),
      },
    }).href;
    window.open(
      target,
      "gene-ledger-quick-entry",
      "popup=yes,width=820,height=680,resizable=yes,scrollbars=no",
    );
  }

  function openLedgerTools(context: Omit<LedgerToolsOpenContext, "projectId">): boolean {
    const bridge = desktopBridge();
    if (bridge?.windowKind !== "main") return false;
    void bridge
      .openLedgerTools({ ...context, projectId: deps.getActiveProjectId() })
      .catch((error) => {
        ElMessage.error(error instanceof Error ? error.message : "台账工具窗口打开失败");
      });
    return true;
  }

  function handleManageProjectsAction(): void {
    if (openLedgerTools({ tool: "fields" })) return;
    deps.managerVisible.value = true;
  }

  function handleReorderAction(): void {
    if (openLedgerTools({ tool: "reorder" })) return;
    openReorderDialog();
  }

  function handleFindReplaceAction(mode: FindReplaceMode): void {
    if (openLedgerTools({ tool: "find-replace", mode })) return;
    deps.openFindReplace(mode, mode !== deps.getFindReplaceMode() || !deps.getFindReplaceVisible());
  }

  // —— 按日期重排（浏览器降级弹窗；桌面端由工具窗口页签承担） ———

  const reorderDialogVisible = ref(false);
  const reorderDate = ref("");
  const reorderPreview = ref<RecordReorderByDatePreview | null>(null);
  const reorderLoading = ref(false);

  function openReorderDialog(): void {
    reorderDate.value = shanghaiDateKey(new Date());
    reorderPreview.value = null;
    reorderDialogVisible.value = true;
  }

  async function loadReorderPreview(): Promise<void> {
    if (!reorderDate.value) {
      ElMessage.warning("请选择需要重排的实验日期");
      return;
    }
    reorderLoading.value = true;
    try {
      reorderPreview.value = await previewReorderByDate(
        deps.getActiveProjectId(),
        reorderDate.value,
      );
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "重排预览失败");
    } finally {
      reorderLoading.value = false;
    }
  }

  async function confirmReorderByDate(): Promise<void> {
    const preview = reorderPreview.value;
    if (!preview) return;
    reorderLoading.value = true;
    try {
      const result = await applyReorderByDate(
        deps.getActiveProjectId(),
        preview.experiment_date,
        preview.expected_order_hash,
      );
      preview.projects.forEach((project) => deps.invalidateProjectRecordCache(project.project_id));
      reorderDialogVisible.value = false;
      await deps.loadRecords(deps.getActiveProjectId(), {
        preserveHistory: true,
        preserveSelection: true,
      });
      ElMessage.success(`重排完成，共调整 ${result.changed_records} 条记录`);
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "按日期重排失败");
      reorderPreview.value = null;
    } finally {
      reorderLoading.value = false;
    }
  }

  function normalizeToolProjectChange(
    change: { projectId?: unknown; revision?: unknown; action?: unknown },
  ): LedgerToolsProjectChange | null {
    const projectId = typeof change?.projectId === "string" ? change.projectId.trim() : "";
    const revision = Number(change.revision);
    if (!projectId) return null;
    const action = change.action === "fields" || change.action === "reorder" || change.action === "replace"
      ? change.action
      : undefined;
    return {
      projectId,
      revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 0,
      action,
    };
  }

  async function acknowledgeToolChanges(changes: LedgerToolsProjectChange[]): Promise<void> {
    const bridge = desktopBridge();
    const acknowledged = changes.filter((change) => change.revision > 0);
    if (bridge?.windowKind !== "main" || !acknowledged.length) return;
    try {
      await bridge.acknowledgeToolChanges(acknowledged);
    } catch (error) {
      logError("ledger", "台账工具变更确认失败", error);
    }
  }

  function scheduleToolRetry(changes: LedgerToolsProjectChange[] = []): void {
    changes.forEach((change) => {
      const previous = toolRetryPending.get(change.projectId);
      if (previous === undefined || change.revision > previous.revision) {
        toolRetryPending.set(change.projectId, change);
      }
    });
    if (toolRetryTimer !== undefined) return;
    toolRetryTimer = window.setTimeout(() => {
      toolRetryTimer = undefined;
      if (deps.isDisposed()) {
        toolRetryPending.clear();
        return;
      }
      if (deps.isPreparingClose()) {
        scheduleToolRetry();
        return;
      }
      const pending = [...toolRetryPending.values()];
      toolRetryPending.clear();
      queueToolChanges(pending);
    }, RETRY_DELAY_MS);
  }

  async function refreshToolChanges(changes: LedgerToolsProjectChange[]): Promise<void> {
    if (deps.isDisposed() || deps.isPreparingClose()) return;
    const latestByProject = new Map<string, LedgerToolsProjectChange>();
    changes.forEach((change) => {
      const normalized = normalizeToolProjectChange(change);
      if (!normalized) return;
      const previous = latestByProject.get(normalized.projectId);
      if (!previous || normalized.revision >= previous.revision) {
        latestByProject.set(normalized.projectId, normalized);
      }
    });
    if (!latestByProject.size) return;

    latestByProject.forEach(({ projectId }) => deps.invalidateProjectRecordCache(projectId));
    const currentChange = latestByProject.get(deps.getActiveProjectId());
    const otherChanges = [...latestByProject.values()].filter((change) => (
      change.projectId !== deps.getActiveProjectId()
    ));
    if (otherChanges.length) await acknowledgeToolChanges(otherChanges);
    if (!currentChange) return;
    if (deps.hasPendingLedgerEdits()) {
      scheduleToolRetry([currentChange]);
      return;
    }
    if (currentChange.action === "fields") {
      await deps.reloadProjects();
      deps.applyProjectLayout(deps.getActiveProjectId());
      await deps.persistProjectLayout(deps.getActiveProjectId());
    }
    const currentProjectLoaded = await deps.loadRecords(currentChange.projectId, {
      showLoading: false,
      preserveHistory: true,
      preserveSelection: true,
      deferForPendingEdits: true,
    });
    if (deps.isDisposed()) return;
    if (!currentProjectLoaded) {
      // The load was deferred (edits started while it ran) or superseded; retry
      // instead of acknowledging, otherwise the change would never re-apply.
      scheduleToolRetry([currentChange]);
      return;
    }
    await acknowledgeToolChanges([currentChange]);
  }

  function queueToolChanges(changes: LedgerToolsProjectChange[]): void {
    if (!changes.length) return;
    const task = toolRefreshPromise
      .catch(() => undefined)
      .then(async () => {
        await refreshToolChanges(changes);
      });
    toolRefreshPromise = task.catch((error) => {
      logError("ledger", "台账工具变更刷新失败", error);
    });
  }

  function handleLedgerToolsChanged(payload: LedgerToolsChangedPayload): void {
    if (deps.isPreparingClose()) return; // Main keeps unacknowledged revisions for the next refresh.
    const change = normalizeToolProjectChange(payload);
    if (change) queueToolChanges([change]);
  }

  async function requestPendingToolChanges(): Promise<void> {
    const bridge = desktopBridge();
    if (bridge?.windowKind !== "main") return;
    try {
      await toolRefreshPromise;
      const pending = await bridge.getPendingToolChanges();
      queueToolChanges(pending);
    } catch (error) {
      logError("ledger", "读取台账工具待刷新项目失败", error);
    }
  }

  function handleLedgerToolsProjectSelected(payload: { projectId: string }): void {
    if (deps.isPreparingClose()) return;
    deps.selectProject(payload.projectId);
  }

  function handleLedgerToolsLocateRecord(payload: LedgerRecordLocate): void {
    if (deps.isPreparingClose()) return;
    deps.locateRecordInGrid(payload);
  }

  function attachToolsWindowListeners(): void {
    const bridge = desktopBridge();
    if (bridge?.windowKind !== "main") return;
    removeToolChangedListener = bridge.onLedgerToolsChanged(handleLedgerToolsChanged);
    removeToolProjectSelectedListener = bridge.onLedgerToolsProjectSelected(
      handleLedgerToolsProjectSelected,
    );
    removeToolLocateListener = bridge.onLedgerToolsLocateRecord(handleLedgerToolsLocateRecord);
    void requestPendingToolChanges();
  }

  function disposeToolsWindowListeners(): void {
    if (toolRetryTimer !== undefined) window.clearTimeout(toolRetryTimer);
    toolRetryTimer = undefined;
    toolRetryPending.clear();
    removeToolChangedListener?.();
    removeToolChangedListener = undefined;
    removeToolProjectSelectedListener?.();
    removeToolProjectSelectedListener = undefined;
    removeToolLocateListener?.();
    removeToolLocateListener = undefined;
  }

  return {
    openQuickEntry,
    handleManageProjectsAction,
    handleReorderAction,
    handleFindReplaceAction,
    reorderDialogVisible,
    reorderDate,
    reorderPreview,
    reorderLoading,
    openReorderDialog,
    loadReorderPreview,
    confirmReorderByDate,
    handleLedgerToolsChanged,
    handleLedgerToolsProjectSelected,
    handleLedgerToolsLocateRecord,
    requestPendingToolChanges,
    attachToolsWindowListeners,
    disposeToolsWindowListeners,
  };
}
