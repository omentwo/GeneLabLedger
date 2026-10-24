import { ref, type ComputedRef, type Ref } from "vue";
import { ElMessage } from "element-plus";

import type { FieldDefinition } from "@/types/api";
import type { LedgerRow } from "@/utils/ledgerTableView";
import { getRecordFieldValue as valueFor } from "@/utils/recordFieldValue";
import {
  buildLedgerGridClipboardData,
  LEDGER_GRID_CLIPBOARD_MIME,
  type LedgerGridClipboardPayload,
} from "@/utils/ledgerClipboard";
import { sameGridCell, type GridCellPosition } from "@/utils/gridSelectionModel";

/**
 * 台账网格剪贴板的读取侧（P1-4/P1-5 剪贴板层）：复制、剪切与剪切快照。
 *
 * 复制/剪切写入优先走事件 clipboardData，其次 execCommand 合成事件，
 * 最后退回异步 clipboard API；自定义 MIME 与 text/plain 同时携带。
 * 剪切在写入成功后按“项目 + 世代 + 值 + 保存版本”四重快照校验，
 * 再调用注入的 `clearCells` 清空单元格（保存管线侧）。
 * 粘贴（handleGridPaste / pasteGrid）与保存管线一体，保留在视图。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export type GridClipboardSelection = { positions: GridCellPosition[]; active: GridCellPosition };
export type GridCutSnapshot = {
  projectId: string;
  projectGeneration: number;
  cells: Array<{ rowId: string; fieldId: string; value: string; version: number }>;
};

export interface GridClipboardDeps {
  fields: ComputedRef<FieldDefinition[]>;
  tableRows: ComputedRef<LedgerRow[]>;
  tableRowIndexById: ComputedRef<Map<string, number>>;
  loading: Ref<boolean>;
  activeGridCell: Ref<GridCellPosition | null>;
  selectedGridCellPositions: () => GridCellPosition[];
  clampCell: (position: GridCellPosition) => GridCellPosition;
  cellFromElement: (element: EventTarget | null) => GridCellPosition | null;
  cellData: (position: GridCellPosition) => { record: LedgerRow; field: FieldDefinition } | null;
  isEditingCell: (position: GridCellPosition | null) => boolean;
  peekCellSaveVersion: (key: string) => number | undefined;
  persistedKey: (recordId: string, fieldId: string) => string;
  projectId: () => string;
  projectGeneration: () => number;
  isDisposed: () => boolean;
  /** 剪切快照校验通过后的清空动作（保存管线侧）。 */
  clearCells: (positions: GridCellPosition[]) => Promise<void>;
}

export function useLedgerGridClipboard(deps: GridClipboardDeps): {
  gridCutInProgress: Ref<boolean>;
  gridClipboardSelection: (eventCell: GridCellPosition | null) => GridClipboardSelection | null;
  lastGridClipboardPayload: (plainText: string) => LedgerGridClipboardPayload | null;
  clearLastGridClipboard: () => void;
  handleGridCopy: (event: ClipboardEvent) => void;
  handleGridCut: (event: ClipboardEvent) => void;
  /** 目标处于编辑态时应保留浏览器原生剪贴板行为。 */
  nativeGridClipboardTarget: (target: EventTarget | null) => boolean;
  copyGridSelectionWithNativeCommand: (selection: GridClipboardSelection) => boolean;
  copyGridSelectionToClipboard: (
    selectionOverride?: GridClipboardSelection,
    showSuccess?: boolean,
    failureMessage?: string,
  ) => Promise<boolean>;
  cutGridSelectionToClipboard: (selection: GridClipboardSelection, event?: ClipboardEvent) => Promise<void>;
} {
  const gridCutInProgress = ref(false);
  let lastGridClipboard: { plainText: string; payload: LedgerGridClipboardPayload } | null = null;

  function gridClipboardSelection(eventCell: GridCellPosition | null): GridClipboardSelection | null {
    let positions = deps.selectedGridCellPositions();
    if (!positions.length && eventCell) positions = [deps.clampCell(eventCell)];
    if (!positions.length) return null;
    const firstPosition = positions[0];
    if (!firstPosition) return null;
    const activeCandidate = deps.activeGridCell.value;
    const active =
      (activeCandidate && positions.some((position) => sameGridCell(position, activeCandidate))
        ? activeCandidate
        : firstPosition);
    return { positions, active: deps.clampCell(active) };
  }

  function buildGridClipboardData(selection: GridClipboardSelection): {
    plainText: string;
    payload: LedgerGridClipboardPayload;
  } {
    return buildLedgerGridClipboardData(selection.positions, (position) => {
      const row = deps.tableRows.value[position.rowIndex];
      const field = deps.fields.value[position.columnIndex];
      return row && field ? valueFor(row, field) : "";
    });
  }

  function nativeGridClipboardTarget(target: EventTarget | null): boolean {
    if (
      target instanceof Element
      && target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")
    ) return true;
    const cell = deps.cellFromElement(target);
    return Boolean(cell && deps.isEditingCell(cell));
  }

  function writeGridClipboardEvent(event: ClipboardEvent, selection: GridClipboardSelection): boolean {
    const { plainText, payload } = buildGridClipboardData(selection);
    const clipboard = event.clipboardData;
    if (!clipboard) return false;
    try {
      clipboard.setData("text/plain", plainText);
    } catch {
      return false;
    }
    try {
      clipboard.setData(LEDGER_GRID_CLIPBOARD_MIME, JSON.stringify(payload));
    } catch {
      // Browsers may reject custom clipboard MIME types; text/plain remains usable.
    }
    lastGridClipboard = { plainText, payload };
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function copyGridSelectionWithNativeCommand(selection: GridClipboardSelection): boolean {
    if (typeof document.execCommand !== "function") return false;
    const previousClipboard = lastGridClipboard;
    let handled = false;
    let succeeded = false;
    const writeClipboard = (event: ClipboardEvent) => {
      handled = writeGridClipboardEvent(event, selection);
    };
    document.addEventListener("copy", writeClipboard, true);
    try {
      // Trigger the browser's native copy during the keyboard user gesture.
      // This also works when the async clipboard API is unavailable or denied.
      succeeded = document.execCommand("copy") && handled;
    } catch {
      // Fall back to the async clipboard API when the native command is unavailable.
    } finally {
      document.removeEventListener("copy", writeClipboard, true);
      if (!succeeded) lastGridClipboard = previousClipboard;
    }
    return succeeded;
  }

  function handleGridCopy(event: ClipboardEvent): void {
    // Editing keeps the browser's native text-copy behavior. Cell/range copy
    // is only active while the grid itself owns the selection.
    if (nativeGridClipboardTarget(event.target)) {
      lastGridClipboard = null;
      return;
    }
    const selection = gridClipboardSelection(deps.cellFromElement(event.target) ?? deps.activeGridCell.value);
    if (selection && !writeGridClipboardEvent(event, selection)) {
      event.preventDefault();
      event.stopPropagation();
      void copyGridSelectionToClipboard(selection, false, "复制失败，请检查剪贴板权限后重试");
    }
  }

  function handleGridCut(event: ClipboardEvent): void {
    if (nativeGridClipboardTarget(event.target)) {
      lastGridClipboard = null;
      return;
    }
    const selection = gridClipboardSelection(deps.cellFromElement(event.target) ?? deps.activeGridCell.value);
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    void cutGridSelectionToClipboard(selection, event);
  }

  function captureGridCutSnapshot(selection: GridClipboardSelection): GridCutSnapshot | null {
    const cells: GridCutSnapshot["cells"] = [];
    for (const position of selection.positions) {
      const data = deps.cellData(position);
      if (!data) return null;
      cells.push({
        rowId: data.record.id,
        fieldId: data.field.id,
        value: valueFor(data.record, data.field),
        version: deps.peekCellSaveVersion(deps.persistedKey(data.record.id, data.field.id)) ?? 0,
      });
    }
    return { projectId: deps.projectId(), projectGeneration: deps.projectGeneration(), cells };
  }

  function resolveGridCutPositions(snapshot: GridCutSnapshot): GridCellPosition[] | null {
    if (deps.isDisposed()) return null;
    if (snapshot.projectId !== deps.projectId() || snapshot.projectGeneration !== deps.projectGeneration()) {
      ElMessage.info("台账已切换，剪切已取消，原内容已保留");
      return null;
    }
    const fieldIndexes = new Map(deps.fields.value.map((field, index) => [field.id, index]));
    const positions: GridCellPosition[] = [];
    for (const cell of snapshot.cells) {
      const rowIndex = deps.tableRowIndexById.value.get(cell.rowId);
      if (rowIndex === undefined) return null;
      const columnIndex = fieldIndexes.get(cell.fieldId);
      const data = rowIndex >= 0 && columnIndex !== undefined
        ? deps.cellData({ rowIndex, columnIndex }) : null;
      if (
        !data || valueFor(data.record, data.field) !== cell.value
        || (deps.peekCellSaveVersion(deps.persistedKey(cell.rowId, cell.fieldId)) ?? 0) !== cell.version
      ) {
        ElMessage.warning("剪切范围的内容已变化，原内容已保留，请重新剪切");
        return null;
      }
      positions.push({ rowIndex, columnIndex: columnIndex! });
    }
    return positions;
  }

  async function cutGridSelectionToClipboard(
    selection: GridClipboardSelection,
    event?: ClipboardEvent,
  ): Promise<void> {
    if (gridCutInProgress.value || deps.loading.value || deps.isDisposed()) return;
    const snapshot = captureGridCutSnapshot(selection);
    if (!snapshot) return;
    gridCutInProgress.value = true;
    const writeFailureMessage = "剪贴板写入失败，原内容已保留，请检查剪贴板权限后重试";
    try {
      const copied = event
        ? writeGridClipboardEvent(event, selection)
        : await copyGridSelectionToClipboard(selection, false, writeFailureMessage);
      if (!copied) {
        if (event) ElMessage.warning(writeFailureMessage);
        return;
      }
      const positions = resolveGridCutPositions(snapshot);
      if (positions) await deps.clearCells(positions);
    } catch (error) {
      if (!deps.isDisposed()) ElMessage.error(error instanceof Error ? error.message : "剪切失败");
    } finally {
      gridCutInProgress.value = false;
    }
  }

  async function copyGridSelectionToClipboard(
    selectionOverride?: GridClipboardSelection,
    showSuccess = true,
    failureMessage = "浏览器未授予剪贴板权限，请使用 Ctrl/Cmd+C 复制",
  ): Promise<boolean> {
    const selection = selectionOverride ?? gridClipboardSelection(null);
    if (!selection) {
      ElMessage.warning("请先选择要复制的单元格");
      return false;
    }
    const { plainText, payload } = buildGridClipboardData(selection);
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard) throw new Error("clipboard-unavailable");
      let written = false;
      if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
        try {
          const item = new ClipboardItem({
            "text/plain": new Blob([plainText], { type: "text/plain" }),
            [LEDGER_GRID_CLIPBOARD_MIME]: new Blob([JSON.stringify(payload)], {
              type: LEDGER_GRID_CLIPBOARD_MIME,
            }),
          });
          await clipboard.write([item]);
          written = true;
        } catch {
          // Some browsers expose ClipboardItem but reject custom MIME types.
        }
      }
      if (!written) {
        await clipboard.writeText(plainText);
      }
      if (!deps.isDisposed()) lastGridClipboard = { plainText, payload };
      if (showSuccess) ElMessage.success("已复制选中单元格");
      return true;
    } catch {
      if (!deps.isDisposed()) ElMessage.warning(failureMessage);
      return false;
    }
  }

  function lastGridClipboardPayload(plainText: string): LedgerGridClipboardPayload | null {
    return lastGridClipboard?.plainText === plainText ? lastGridClipboard.payload : null;
  }

  function clearLastGridClipboard(): void {
    lastGridClipboard = null;
  }

  return {
    gridCutInProgress,
    gridClipboardSelection,
    lastGridClipboardPayload,
    clearLastGridClipboard,
    handleGridCopy,
    handleGridCut,
    nativeGridClipboardTarget,
    copyGridSelectionWithNativeCommand,
    copyGridSelectionToClipboard,
    cutGridSelectionToClipboard,
  };
}
