import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { Router } from "vue-router";

import { useLedgerToolsWindows } from "@/composables/useLedgerToolsWindows";
import type {
  LedgerRecordLocate,
  LedgerToolsChangedPayload,
  LedgerToolsProjectChange,
} from "@/types/electron";

const mocks = vi.hoisted(() => ({
  bridge: null as null | {
    windowKind: "main" | "quick-entry" | "ledger-tools";
    openQuickEntry: ReturnType<typeof vi.fn>;
    openLedgerTools: ReturnType<typeof vi.fn>;
    getPendingToolChanges: ReturnType<typeof vi.fn>;
    acknowledgeToolChanges: ReturnType<typeof vi.fn>;
    onLedgerToolsChanged: ReturnType<typeof vi.fn>;
    onLedgerToolsProjectSelected: ReturnType<typeof vi.fn>;
    onLedgerToolsLocateRecord: ReturnType<typeof vi.fn>;
  },
  message: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/utils/desktop", () => ({ desktopBridge: () => mocks.bridge }));
vi.mock("element-plus", () => ({ ElMessage: mocks.message }));

function fixture(options: { activeProject?: string; pendingEdits?: () => boolean } = {}) {
  const managerVisible = ref(false);
  const calls = {
    invalidate: vi.fn(),
    loadRecords: vi.fn(async () => true),
    reloadProjects: vi.fn(async () => undefined),
    applyProjectLayout: vi.fn(),
    persistProjectLayout: vi.fn(async () => undefined),
    selectProject: vi.fn(),
    locateRecordInGrid: vi.fn(),
    openFindReplace: vi.fn(),
  };
  const api = useLedgerToolsWindows({
    getActiveProjectId: () => options.activeProject ?? "p1",
    getCurrentProject: () => undefined,
    router: {} as Router,
    managerVisible,
    getFindReplaceMode: () => "replace",
    getFindReplaceVisible: () => false,
    openFindReplace: calls.openFindReplace,
    isDisposed: () => false,
    isPreparingClose: () => false,
    hasPendingLedgerEdits: () => options.pendingEdits?.() ?? false,
    invalidateProjectRecordCache: calls.invalidate,
    loadRecords: calls.loadRecords,
    reloadProjects: calls.reloadProjects,
    applyProjectLayout: calls.applyProjectLayout,
    persistProjectLayout: calls.persistProjectLayout,
    selectProject: calls.selectProject,
    locateRecordInGrid: calls.locateRecordInGrid,
  });
  return { api, managerVisible, calls };
}

function drainQueue(api: ReturnType<typeof useLedgerToolsWindows>): Promise<void> {
  // 首次调用把 get-pending 的结果排进队列，第二次调用等待该队列清空。
  return api.requestPendingToolChanges().then(() => api.requestPendingToolChanges());
}

beforeEach(() => {
  mocks.message.success.mockClear();
  mocks.message.warning.mockClear();
  mocks.message.error.mockClear();
});

describe("ledger tools window actions", () => {
  it("routes all three entries into the desktop tool window with the active project", () => {
    const f = fixture();
    mocks.bridge = {
      windowKind: "main",
      openQuickEntry: vi.fn(async () => undefined),
      openLedgerTools: vi.fn(async () => undefined),
      getPendingToolChanges: vi.fn(async () => []),
      acknowledgeToolChanges: vi.fn(async () => undefined),
      onLedgerToolsChanged: vi.fn(() => () => undefined),
      onLedgerToolsProjectSelected: vi.fn(() => () => undefined),
      onLedgerToolsLocateRecord: vi.fn(() => () => undefined),
    };
    f.api.handleManageProjectsAction();
    f.api.handleReorderAction();
    f.api.handleFindReplaceAction("find");
    expect(mocks.bridge.openLedgerTools).toHaveBeenCalledTimes(3);
    expect(mocks.bridge.openLedgerTools).toHaveBeenNthCalledWith(1, { tool: "fields", projectId: "p1" });
    expect(mocks.bridge.openLedgerTools).toHaveBeenNthCalledWith(2, { tool: "reorder", projectId: "p1" });
    expect(mocks.bridge.openLedgerTools).toHaveBeenNthCalledWith(3, {
      tool: "find-replace",
      mode: "find",
      projectId: "p1",
    });
    expect(f.managerVisible.value).toBe(false);
    expect(f.api.reorderDialogVisible.value).toBe(false);
  });

  it("keeps the in-page dialog fallbacks when the desktop bridge is missing", () => {
    const f = fixture();
    mocks.bridge = null;
    f.api.handleManageProjectsAction();
    f.api.handleReorderAction();
    f.api.handleFindReplaceAction("find");
    expect(f.managerVisible.value).toBe(true);
    expect(f.api.reorderDialogVisible.value).toBe(true);
    expect(f.api.reorderDate.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.calls.openFindReplace).toHaveBeenCalledWith("find", true);
  });
});

describe("ledger tools change queue", () => {
  function bridgeMock() {
    mocks.bridge = {
      windowKind: "main",
      openQuickEntry: vi.fn(async () => undefined),
      openLedgerTools: vi.fn(async () => undefined),
      getPendingToolChanges: vi.fn(async () => [] as LedgerToolsProjectChange[]),
      acknowledgeToolChanges: vi.fn(async () => undefined),
      onLedgerToolsChanged: vi.fn(() => () => undefined),
      onLedgerToolsProjectSelected: vi.fn(() => () => undefined),
      onLedgerToolsLocateRecord: vi.fn(() => () => undefined),
    };
    return mocks.bridge;
  }

  it("refreshes only the affected project and acknowledges the others", async () => {
    const bridge = bridgeMock();
    const f = fixture({ activeProject: "p1" });
    f.api.handleLedgerToolsChanged({ projectId: "p2", action: "reorder", revision: 1 });
    f.api.handleLedgerToolsChanged({ projectId: "p2", action: "reorder", revision: 2 });
    await drainQueue(f.api);
    expect(f.calls.invalidate).toHaveBeenCalledWith("p2");
    expect(f.calls.loadRecords).not.toHaveBeenCalled();
    expect(bridge.acknowledgeToolChanges).toHaveBeenCalledWith([
      { projectId: "p2", revision: 2, action: "reorder" },
    ]);
  });

  it("reloads projects and layout for fields changes on the active project", async () => {
    bridgeMock();
    const f = fixture({ activeProject: "p1" });
    f.api.handleLedgerToolsChanged({ projectId: "p1", action: "fields", revision: 3 });
    await drainQueue(f.api);
    expect(f.calls.reloadProjects).toHaveBeenCalledOnce();
    expect(f.calls.applyProjectLayout).toHaveBeenCalledWith("p1");
    expect(f.calls.persistProjectLayout).toHaveBeenCalledWith("p1");
    expect(f.calls.loadRecords).toHaveBeenCalledWith("p1", expect.objectContaining({
      preserveHistory: true,
      deferForPendingEdits: true,
    }));
    expect(mocks.bridge?.acknowledgeToolChanges).toHaveBeenCalledWith([
      { projectId: "p1", revision: 3, action: "fields" },
    ]);
  });

  it("defers the refresh while ledger edits are pending and retries afterwards", async () => {
    vi.useFakeTimers();
    try {
      bridgeMock();
      let pending = true;
      const f = fixture({ activeProject: "p1", pendingEdits: () => pending });
      f.api.handleLedgerToolsChanged({ projectId: "p1", action: "replace", revision: 4 });
      await drainQueue(f.api);
      expect(f.calls.loadRecords).not.toHaveBeenCalled();
      pending = false;
      await vi.advanceTimersByTimeAsync(600);
      await drainQueue(f.api);
      expect(f.calls.loadRecords).toHaveBeenCalledWith("p1", expect.anything());
      expect(mocks.bridge?.acknowledgeToolChanges).toHaveBeenCalledWith([
        { projectId: "p1", revision: 4, action: "replace" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays unacknowledged revisions on demand", async () => {
    const bridge = bridgeMock();
    bridge.getPendingToolChanges = vi.fn(async () => [
      { projectId: "p1", revision: 9, action: "reorder" },
    ]);
    const f = fixture({ activeProject: "p1" });
    await drainQueue(f.api);
    expect(f.calls.invalidate).toHaveBeenCalledWith("p1");
    expect(f.calls.loadRecords).toHaveBeenCalledWith("p1", expect.anything());
    expect(bridge.acknowledgeToolChanges).toHaveBeenCalledWith([
      { projectId: "p1", revision: 9, action: "reorder" },
    ]);
  });
});

describe("ledger tools event forwarding", () => {
  it("subscribes on main windows only and forwards locate/project selection", async () => {
    const changedUnsubscribe = vi.fn();
    const listeners: {
      changed: (payload: LedgerToolsChangedPayload) => void;
      selected: (payload: { projectId: string }) => void;
      locate: (payload: LedgerRecordLocate) => void;
    } = {} as never;
    const bridge = {
      windowKind: "main" as const,
      openQuickEntry: vi.fn(async () => undefined),
      openLedgerTools: vi.fn(async () => undefined),
      getPendingToolChanges: vi.fn(async () => []),
      acknowledgeToolChanges: vi.fn(async () => undefined),
      onLedgerToolsChanged: vi.fn((listener: typeof listeners.changed) => {
        listeners.changed = listener;
        return changedUnsubscribe;
      }),
      onLedgerToolsProjectSelected: vi.fn((listener: typeof listeners.selected) => {
        listeners.selected = listener;
        return () => undefined;
      }),
      onLedgerToolsLocateRecord: vi.fn((listener: typeof listeners.locate) => {
        listeners.locate = listener;
        return () => undefined;
      }),
    };
    mocks.bridge = bridge;
    const f = fixture();
    f.api.attachToolsWindowListeners();
    expect(bridge.onLedgerToolsChanged).toHaveBeenCalledOnce();
    expect(bridge.onLedgerToolsProjectSelected).toHaveBeenCalledOnce();
    expect(bridge.onLedgerToolsLocateRecord).toHaveBeenCalledOnce();

    listeners.changed({ projectId: "p1", action: "replace", revision: 1 });
    listeners.selected({ projectId: "p2" });
    listeners.locate({ projectId: "p2", recordId: "r1", fieldId: "f1" });
    expect(f.calls.locateRecordInGrid).toHaveBeenCalledWith({
      projectId: "p2",
      recordId: "r1",
      fieldId: "f1",
    });
    expect(f.calls.selectProject).toHaveBeenCalledWith("p2");
    await drainQueue(f.api);
    expect(f.calls.invalidate).toHaveBeenCalledWith("p1");
    f.api.disposeToolsWindowListeners();
    expect(changedUnsubscribe).toHaveBeenCalledOnce();
  });

  it("never subscribes when the bridge is missing", () => {
    mocks.bridge = null;
    const f = fixture();
    expect(() => f.api.attachToolsWindowListeners()).not.toThrow();
  });
});
