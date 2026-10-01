import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeneLedgerDesktopBridge, WindowCloseRequest } from "@/types/electron";
import { initializeWindowCloseGuard, registerWindowCloseGuard } from "@/utils/windowCloseGuard";

const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).reverse().forEach((dispose) => dispose()); document.body.innerHTML = ""; });

function fixture() {
  document.body.innerHTML = '<div id="app"><input value="unsaved"></div>';
  let listener!: (request: WindowCloseRequest) => void;
  const reply = vi.fn().mockResolvedValue(undefined);
  const bridge = {
    onCloseRequested: (callback: typeof listener) => { listener = callback; return vi.fn(); },
    closeGuardReady: vi.fn().mockResolvedValue(undefined), respondToCloseRequest: reply,
  } as unknown as GeneLedgerDesktopBridge;
  disposers.push(initializeWindowCloseGuard(bridge));
  return { reply, root: document.getElementById("app")!, request: async (action: WindowCloseRequest["action"]) => {
    listener({ requestId: action, action });
    await vi.waitFor(() => {
      if (action === "release") expect(document.getElementById("app")!.inert).toBe(false);
      else expect(reply).toHaveBeenCalledWith(expect.objectContaining({ requestId: action }));
    });
  } };
}

describe("desktop draft close protection", () => {
  it("locks drafts through inspection and saving, then restores editing on cancel", async () => {
    const f = fixture();
    let dirty = true;
    const save = vi.fn(async () => { dirty = false; return true; });
    const release = vi.fn();
    disposers.push(registerWindowCloseGuard({ state: () => ({ dirty, busy: false }), save, release }));
    await f.request("inspect");
    expect(f.root.inert).toBe(true);
    expect(f.reply).toHaveBeenLastCalledWith({ requestId: "inspect", dirty: true, busy: false, saved: false });
    await f.request("save");
    expect(f.reply).toHaveBeenLastCalledWith({ requestId: "save", dirty: false, busy: false, saved: true });
    expect(f.root.inert).toBe(true);
    await f.request("release");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps failed drafts and refuses saving over an existing in-flight request", async () => {
    const f = fixture();
    let busy = true;
    const save = vi.fn(async () => false);
    disposers.push(registerWindowCloseGuard({ state: () => ({ dirty: true, busy }), save }));
    await f.request("inspect");
    await f.request("save");
    expect(save).not.toHaveBeenCalled();
    busy = false;
    f.reply.mockClear();
    await f.request("save");
    expect(f.reply).toHaveBeenLastCalledWith({ requestId: "save", dirty: true, busy: false, saved: false });
    expect(document.querySelector("input")!.value).toBe("unsaved");
    await f.request("release");
  });
});
