import { ref, type Ref } from "vue";

/**
 * 台账记录显示范围的延迟刷新调度（100ms 去抖）。
 *
 * 保存成功、范围设置变更后不立即重载，而是等一个去抖窗口；
 * 窗口到期时若仍有保存/加载在进行则顺延，若用户正在编辑或
 * 存在未保存修改则放弃本次刷新。`pendingLedgerRangeApplication`
 * 标记“范围已保存但尚未应用到已加载记录”，由加载编排器消费。
 *
 * 谓词全部注入：本模块不持有台账业务状态。
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export interface LedgerRangeRefreshDeps {
  isDisposed: () => boolean;
  isRangeSaving: () => boolean;
  getActiveProjectId: () => string;
  /** 当前范围模式是否为“全部记录”（该模式下无待应用范围则无需刷新）。 */
  isAllMode: () => boolean;
  /** 是否有保存或加载正在进行（顺延一个周期）。 */
  isBusy: () => boolean;
  /** 是否被编辑态或未保存修改阻塞（放弃本次刷新）。 */
  isBlockedByEdits: () => boolean;
  refresh: (projectId: string) => void;
}

const REFRESH_DELAY_MS = 100;

export function useLedgerRangeRefresh(deps: LedgerRangeRefreshDeps): {
  pendingLedgerRangeApplication: Ref<boolean>;
  scheduleLedgerRangeRefresh: (projectId: string) => void;
  cancelLedgerRangeRefresh: () => void;
} {
  const pendingLedgerRangeApplication = ref(false);
  let refreshTimer: number | undefined;

  function shouldRun(projectId: string): boolean {
    return !deps.isDisposed()
      && !deps.isRangeSaving()
      && projectId === deps.getActiveProjectId()
      && (!deps.isAllMode() || pendingLedgerRangeApplication.value);
  }

  function scheduleLedgerRangeRefresh(projectId: string): void {
    if (!shouldRun(projectId)) return;
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      if (!shouldRun(projectId)) return;
      if (deps.isBusy()) {
        scheduleLedgerRangeRefresh(projectId);
        return;
      }
      if (deps.isBlockedByEdits()) return;
      deps.refresh(projectId);
    }, REFRESH_DELAY_MS);
  }

  function cancelLedgerRangeRefresh(): void {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  return {
    pendingLedgerRangeApplication,
    scheduleLedgerRangeRefresh,
    cancelLedgerRangeRefresh,
  };
}
