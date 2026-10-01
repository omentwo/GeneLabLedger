import { nextTick } from "vue";

import type { GeneLedgerDesktopBridge, WindowCloseRequest, WindowCloseState } from "@/types/electron";
import { desktopBridge } from "@/utils/desktop";

export interface WindowCloseGuard {
  state: () => WindowCloseState;
  save: () => Promise<boolean>;
  prepare?: () => void;
  release?: () => void;
}

const guards = new Set<WindowCloseGuard>();

export function registerWindowCloseGuard(guard: WindowCloseGuard): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

function state(): WindowCloseState {
  const states = [...guards].map((guard) => guard.state());
  return { dirty: states.some((item) => item.dirty), busy: states.some((item) => item.busy) };
}

/** Install before mounting, so even routes without editable data can reply. */
export function initializeWindowCloseGuard(bridge: GeneLedgerDesktopBridge | undefined = desktopBridge()): () => void {
  if (!bridge?.onCloseRequested) return () => undefined;
  let lockedRoot: HTMLElement | null = null;
  let previousInert = false;
  let prepared = false;
  let requests = Promise.resolve();

  function release(): void {
    if (!prepared) return;
    prepared = false;
    if (lockedRoot) lockedRoot.inert = previousInert;
    lockedRoot = null;
    guards.forEach((guard) => guard.release?.());
  }

  async function handle(request: WindowCloseRequest): Promise<void> {
    if (request.action === "release") {
      release();
      return;
    }
    try {
      if (request.action === "inspect" && !prepared) {
        prepared = true;
        guards.forEach((guard) => guard.prepare?.());
        lockedRoot = document.getElementById("app");
        if (lockedRoot) {
          previousInert = Boolean(lockedRoot.inert);
          lockedRoot.inert = true;
        }
        // Blurring an editor may start its existing autosave. Include it in the
        // busy check rather than shutting down underneath that request.
        await nextTick();
      }
      let saved = false;
      if (request.action === "save" && prepared && !state().busy) {
        saved = true;
        for (const guard of guards) {
          if (guard.state().dirty && !(await guard.save())) {
            saved = false;
            break;
          }
        }
      }
      await bridge!.respondToCloseRequest({ requestId: request.requestId, ...state(), saved });
    } catch {
      await bridge!.respondToCloseRequest({ requestId: request.requestId, dirty: true, busy: false, saved: false });
    }
  }

  const remove = bridge.onCloseRequested((request) => {
    requests = requests.then(() => handle(request)).catch(() => { release(); });
  });
  void bridge.closeGuardReady().catch(() => undefined);
  return () => { remove(); release(); };
}
