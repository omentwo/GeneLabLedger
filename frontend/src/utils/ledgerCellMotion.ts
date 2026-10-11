import { prefersReducedMotion } from "@/utils/motion";

/** Animate only the current DOM snapshot after an explicit load/add action. */
export class LedgerCellEntryMotion {
  private readonly played = new WeakSet<HTMLElement>();
  private readonly active = new Set<Animation>();

  play(root: HTMLElement | null, rowIds?: ReadonlySet<string>): void {
    if (!root || prefersReducedMotion()) return;
    for (const cell of root.querySelectorAll<HTMLElement>(".cell-field-value")) {
      const rowId = cell.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
      if ((rowIds && (!rowId || !rowIds.has(rowId))) || this.played.has(cell)
        || typeof cell.animate !== "function") continue;
      this.played.add(cell);
      const animation = cell.animate([
        { opacity: 0.35, transform: "scale(0.96)" },
        { opacity: 1, transform: "scale(1)" },
      ], { duration: 180, easing: "ease-out" });
      this.active.add(animation);
      const remove = () => this.active.delete(animation);
      animation.onfinish = remove;
      animation.oncancel = remove;
    }
  }

  cancel(): void {
    this.active.forEach((animation) => animation.cancel());
    this.active.clear();
  }
}
