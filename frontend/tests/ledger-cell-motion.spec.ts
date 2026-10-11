import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerCellEntryMotion } from "@/utils/ledgerCellMotion";

afterEach(() => vi.unstubAllGlobals());

function cell(root: HTMLElement, id: string) {
  const row = document.createElement("div");
  row.dataset.rowId = id;
  const span = document.createElement("span");
  span.className = "cell-field-value";
  const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
  span.animate = vi.fn(() => animation as unknown as Animation);
  row.append(span);
  root.append(row);
  return { span, animation };
}

describe("ledger entry motion", () => {
  it("plays only the explicit DOM snapshot once and does not animate later mounts", () => {
    const root = document.createElement("div");
    const first = cell(root, "first");
    const motion = new LedgerCellEntryMotion();
    motion.play(root);
    const later = cell(root, "later");
    expect(first.span.animate).toHaveBeenCalledTimes(1);
    expect(later.span.animate).not.toHaveBeenCalled();
    motion.play(root, new Set(["first"]));
    expect(first.span.animate).toHaveBeenCalledTimes(1);
    motion.play(root, new Set(["later"]));
    expect(later.span.animate).toHaveBeenCalledTimes(1);
    motion.cancel();
    expect(first.animation.cancel).toHaveBeenCalledTimes(1);
    expect(later.animation.cancel).toHaveBeenCalledTimes(1);
  });

  it("releases completed animations and respects reduced motion", () => {
    const root = document.createElement("div");
    const first = cell(root, "first");
    const motion = new LedgerCellEntryMotion();
    motion.play(root);
    (first.animation.onfinish as unknown as () => void)();
    motion.cancel();
    expect(first.animation.cancel).not.toHaveBeenCalled();
    const later = cell(root, "later");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    motion.play(root);
    expect(later.span.animate).not.toHaveBeenCalled();
  });
});
