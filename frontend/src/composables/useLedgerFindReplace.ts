import { computed, nextTick, reactive, ref, watch, type ComputedRef, type Ref } from "vue";
import type { TableV2Instance } from "element-plus";
import { ElMessage } from "element-plus";

import { commitReplace, previewReplace } from "@/api/records";
import type { FieldDefinition, ProjectRecord, RecordReplacePreview } from "@/types/api";
import type { LedgerRow } from "@/utils/ledgerTableView";
import { getRecordFieldValue as valueFor } from "@/utils/recordFieldValue";
import type { GridCellPosition, GridCellRange, GridCellSelectionSnapshot } from "@/utils/gridSelectionModel";

/**
 * 台账查找替换（P2-3 composable 层）：状态、匹配计算、导航与两段式预览提交。
 * 对话框模板仍在视图（P2-3b 再组件化），经顶层解构绑定同名成员。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数（setupState 契约）。
 */
export type FindReplaceMode = "find" | "replace";

export interface LedgerFindReplaceDeps {
  fields: ComputedRef<FieldDefinition[]>;
  tableRows: ComputedRef<LedgerRow[]>;
  tableRowIndexById: ComputedRef<Map<string, number>>;
  records: Ref<ProjectRecord[]>;
  selection: {
    activeGridCell: Ref<GridCellPosition | null>;
    gridSelectionAnchor: Ref<GridCellPosition | null>;
    gridCellRange: Ref<GridCellRange | null>;
    selectedGridCellKeys: Ref<Set<string>>;
    selectGridCell: (position: GridCellPosition) => void;
    selectedGridCellPositions: () => GridCellPosition[];
  };
  clampCell: (position: GridCellPosition) => GridCellPosition;
  tableRef: Ref<TableV2Instance | null>;
  gridEditorRoot: (position: GridCellPosition) => HTMLElement | null;
  editingGridCell: Ref<GridCellPosition | null>;
  commitEditThen: () => Promise<boolean>;
  focusCell: (position: GridCellPosition) => void;
  isDraft: (record: LedgerRow) => boolean;
  getProjectId: () => string;
  queryRecordIds: () => Promise<{ record_ids: string[]; total: number }>;
  replaceRecord: (updated: ProjectRecord) => void;
  pushCellHistory: (
    label: string,
    changes: Array<{ record_id: string; field_id: string; before: string; after: string }>,
    projectId?: string,
  ) => void;
}

export function useLedgerFindReplace(deps: LedgerFindReplaceDeps): {
  findReplaceVisible: Ref<boolean>;
  findReplaceLoading: Ref<boolean>;
  findReplacePreview: Ref<RecordReplacePreview | null>;
  findReplaceScopeCount: Ref<number | null>;
  findReplaceScopeLabel: Ref<string>;
  findReplaceMode: Ref<FindReplaceMode>;
  findReplaceInputRef: Ref<{ focus: () => void } | null>;
  findReplaceForm: { fieldId: string; find: string; replacement: string; matchMode: "substring" | "whole"; caseSensitive: boolean };
  findMatches: ComputedRef<number[]>;
  findCurrentMatch: ComputedRef<{ rowId: string; fieldId: string } | null>;
  findMatchStatus: ComputedRef<string>;
  setFindReplaceMode: (mode: FindReplaceMode) => void;
  openFindReplace: (mode?: FindReplaceMode, reset?: boolean) => void;
  runFindReplacePreview: () => Promise<void>;
  commitFindReplace: () => Promise<void>;
  handleFindReplaceInputEnter: (event: KeyboardEvent) => void;
  navigateFindMatch: (direction: -1 | 1) => Promise<void>;
  /** 视图卸载时清理防抖定时器。 */
  cancelFindTermDebounce: () => void;
  focusFindReplaceInput: () => void;
  restoreFindReplaceGridFocus: () => void;
} {
  const { fields, tableRows, tableRowIndexById, records } = deps;
  let findReplaceGridSelectionSnapshot: GridCellSelectionSnapshot | null = null;
const findReplaceVisible = ref(false);
const findReplaceLoading = ref(false);
const findReplacePreview = ref<RecordReplacePreview | null>(null);
const findReplaceScopeCount = ref<number | null>(null);
const findReplaceScopeLabel = ref("");
const findReplaceMode = ref<FindReplaceMode>("replace");
const findReplaceInputRef = ref<{ focus: () => void } | null>(null);
const findCurrentMatchIndex = ref(-1);
const FIND_TERM_DEBOUNCE_MS = 250;
const debouncedFindTerm = ref("");
let findTermDebounceTimer: number | undefined;
const findReplaceForm = reactive({
  fieldId: "",
  find: "",
  replacement: "",
  matchMode: "substring" as "substring" | "whole",
  caseSensitive: false,
});

const findMatches = computed<number[]>(() => {
  const term = debouncedFindTerm.value;
  if (
    !findReplaceVisible.value ||
    findReplaceMode.value !== "find" ||
    !term
  ) return [];
  const query = findReplaceForm.caseSensitive
    ? term
    : term.toLocaleLowerCase();
  const searchFields = fields.value
    .map((field, columnIndex) => ({ field, columnIndex }))
    .filter(({ field }) => !findReplaceForm.fieldId || field.id === findReplaceForm.fieldId);
  const fieldCount = fields.value.length;
  if (!fieldCount) return [];
  const matches: number[] = [];
  tableRows.value.forEach((row, rowIndex) => {
    searchFields.forEach(({ field, columnIndex }) => {
      const value = valueFor(row, field);
      const candidate = findReplaceForm.caseSensitive ? value : value.toLocaleLowerCase();
      const matched = findReplaceForm.matchMode === "whole"
        ? candidate === query
        : candidate.includes(query);
      if (matched) {
        matches.push(rowIndex * fieldCount + columnIndex);
      }
    });
  });
  return matches;
});
const findCurrentMatch = computed(() => {
  const encodedMatch = findMatches.value[findCurrentMatchIndex.value];
  const fieldCount = fields.value.length;
  if (encodedMatch === undefined || !fieldCount) return null;
  const rowIndex = Math.floor(encodedMatch / fieldCount);
  const columnIndex = encodedMatch % fieldCount;
  const row = tableRows.value[rowIndex];
  const field = fields.value[columnIndex];
  return row && field
    ? { rowId: row.id, fieldId: field.id }
    : null;
});
const findMatchStatus = computed(() => {
  if (!findReplaceForm.find) return "输入内容以查找";
  const count = findMatches.value.length;
  if (!count) return "未找到匹配项";
  const currentIndex = findCurrentMatchIndex.value;
  return currentIndex >= 0 && currentIndex < count
    ? String(currentIndex + 1) + " / " + String(count)
    : "共 " + String(count) + " 个匹配项";
});
function captureFindReplaceGridSelection(): void {
  findReplaceGridSelectionSnapshot = {
    active: deps.selection.activeGridCell.value ? { ...deps.selection.activeGridCell.value } : null,
    anchor: deps.selection.gridSelectionAnchor.value ? { ...deps.selection.gridSelectionAnchor.value } : null,
    range: deps.selection.gridCellRange.value
      ? {
          anchor: { ...deps.selection.gridCellRange.value.anchor },
          focus: { ...deps.selection.gridCellRange.value.focus },
        }
      : null,
    selectedKeys: new Set(deps.selection.selectedGridCellKeys.value),
  };
}
function restoreFindReplaceGridSelection(): void {
  const snapshot = findReplaceGridSelectionSnapshot;
  if (!snapshot) return;
  deps.selection.selectedGridCellKeys.value = new Set(snapshot.selectedKeys);
  deps.selection.activeGridCell.value = snapshot.active ? deps.clampCell(snapshot.active) : null;
  deps.selection.gridSelectionAnchor.value = snapshot.anchor ? deps.clampCell(snapshot.anchor) : null;
  deps.selection.gridCellRange.value = snapshot.range
    ? {
        anchor: deps.clampCell(snapshot.range.anchor),
        focus: deps.clampCell(snapshot.range.focus),
      }
    : null;
}
function setFindReplaceMode(mode: FindReplaceMode): void {
  if (findReplaceMode.value === mode) return;
  findCurrentMatchIndex.value = -1;
  if (mode === "replace") {
    restoreFindReplaceGridSelection();
    if (!findReplaceForm.fieldId) {
      const activeField = deps.selection.activeGridCell.value
        ? fields.value[deps.selection.activeGridCell.value.columnIndex]
        : fields.value[0];
      findReplaceForm.fieldId = activeField?.id ?? "";
    }
    findReplacePreview.value = null;
    findReplaceScopeCount.value = null;
    findReplaceScopeLabel.value = deps.selection.selectedGridCellPositions().length
      ? "选中单元格所在记录"
      : "当前筛选范围全部记录";
  }
  findReplaceMode.value = mode;
  focusFindReplaceInput();
}
function selectedRecordIdsForReplace(): string[] {
  const selectedCells = deps.selection.selectedGridCellPositions();
  if (selectedCells.length) {
    return [
      ...new Set(
        selectedCells
          .filter(
            (position) => fields.value[position.columnIndex]?.id === findReplaceForm.fieldId,
          )
          .map((position) => tableRows.value[position.rowIndex])
          .filter((row): row is LedgerRow => Boolean(row && !deps.isDraft(row)))
          .map((row) => row.id),
      ),
    ];
  }
  return records.value.map((record) => record.id);
}
function focusFindReplaceInput(): void {
  void nextTick(() => {
    findReplaceInputRef.value?.focus();
    const focusedElement = document.activeElement;
    if (focusedElement instanceof HTMLInputElement) focusedElement.select();
  });
}
async function navigateFindMatch(direction: -1 | 1): Promise<void> {
  const matches = findMatches.value;
  const fieldCount = fields.value.length;
  if (findReplaceMode.value !== "find" || !matches.length || !fieldCount) return;
  let nextIndex = -1;
  if (findCurrentMatchIndex.value >= 0) {
    nextIndex = (
      findCurrentMatchIndex.value + direction + matches.length
    ) % matches.length;
  } else {
    const active = deps.selection.activeGridCell.value;
    if (active && direction > 0) {
      nextIndex = matches.findIndex((encodedMatch) => {
        const rowIndex = Math.floor(encodedMatch / fieldCount);
        const columnIndex = encodedMatch % fieldCount;
        return rowIndex > active.rowIndex ||
          (rowIndex === active.rowIndex && columnIndex > active.columnIndex);
      });
    } else if (active) {
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const encodedMatch = matches[index];
        if (encodedMatch === undefined) continue;
        const rowIndex = Math.floor(encodedMatch / fieldCount);
        const columnIndex = encodedMatch % fieldCount;
        if (
          rowIndex < active.rowIndex ||
          (rowIndex === active.rowIndex && columnIndex < active.columnIndex)
        ) {
          nextIndex = index;
          break;
        }
      }
    }
    if (nextIndex < 0) nextIndex = direction > 0 ? 0 : matches.length - 1;
  }

  const encodedTarget = matches[nextIndex];
  if (encodedTarget === undefined) return;
  findCurrentMatchIndex.value = nextIndex;
  const targetPosition = {
    rowIndex: Math.floor(encodedTarget / fieldCount),
    columnIndex: encodedTarget % fieldCount,
  };
  const targetRowId = tableRows.value[targetPosition.rowIndex]?.id;
  const targetFieldId = fields.value[targetPosition.columnIndex]?.id;
  if (!targetRowId || !targetFieldId) return;
  deps.selection.selectGridCell(targetPosition);
  deps.tableRef.value?.scrollToRow(targetPosition.rowIndex, "center");
  await nextTick();

  if (findReplaceMode.value !== "find") return;
  const currentMatches = findMatches.value;
  const currentFieldCount = fields.value.length;
  const currentRowIndex = tableRowIndexById.value.get(targetRowId);
  const currentColumnIndex = fields.value.findIndex((field) => field.id === targetFieldId);
  if (currentRowIndex === undefined || currentColumnIndex < 0 || !currentFieldCount) return;
  const currentIndex = currentMatches.findIndex(
    (encodedMatch) =>
      Math.floor(encodedMatch / currentFieldCount) === currentRowIndex &&
      encodedMatch % currentFieldCount === currentColumnIndex,
  );
  if (currentIndex < 0) return;
  const currentEncodedMatch = currentMatches[currentIndex];
  if (currentEncodedMatch === undefined) return;
  findCurrentMatchIndex.value = currentIndex;
  const currentPosition = {
    rowIndex: Math.floor(currentEncodedMatch / currentFieldCount),
    columnIndex: currentEncodedMatch % currentFieldCount,
  };
  deps.tableRef.value?.scrollToRow(currentPosition.rowIndex, "center");
  await nextTick();
  deps.gridEditorRoot(currentPosition)
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function handleFindReplaceInputEnter(event: KeyboardEvent): void {
  if (findReplaceMode.value !== "find") return;
  event.preventDefault();
  event.stopPropagation();
  void navigateFindMatch(event.shiftKey ? -1 : 1);
}
function restoreFindReplaceGridFocus(): void {
  if (findReplaceVisible.value) return;
  if (deps.selection.activeGridCell.value) void deps.focusCell(deps.selection.activeGridCell.value);
  findReplaceGridSelectionSnapshot = null;
}
function openFindReplace(
  mode: FindReplaceMode = "replace",
  reset = true,
): void {
  if (deps.editingGridCell.value) {
    void deps.commitEditThen().then((saved) => {
      if (saved) openFindReplace(mode, reset);
    });
    return;
  }
  const modeChanged = findReplaceMode.value !== mode;
  if (!reset && mode === "replace" && modeChanged) {
    restoreFindReplaceGridSelection();
  }
  const activeField = deps.selection.activeGridCell.value
    ? fields.value[deps.selection.activeGridCell.value.columnIndex]
    : fields.value[0];
  if (reset) {
    captureFindReplaceGridSelection();
    findReplaceForm.fieldId = mode === "find" ? "" : activeField?.id ?? "";
    findReplaceForm.find = "";
    findReplaceForm.replacement = "";
    findReplaceForm.matchMode = "substring";
    findReplaceForm.caseSensitive = false;
    findReplacePreview.value = null;
    findReplaceScopeCount.value = null;
    findReplaceScopeLabel.value = deps.selection.selectedGridCellPositions().length
      ? "选中单元格所在记录"
      : "当前筛选范围全部记录";
  } else if (mode === "replace") {
    if (!findReplaceForm.fieldId) findReplaceForm.fieldId = activeField?.id ?? "";
    if (modeChanged) {
      findReplacePreview.value = null;
      findReplaceScopeCount.value = null;
      findReplaceScopeLabel.value = deps.selection.selectedGridCellPositions().length
        ? "选中单元格所在记录"
        : "当前筛选范围全部记录";
    }
  }
  findReplaceMode.value = mode;
  findCurrentMatchIndex.value = -1;
  applyFindTermImmediately();
  findReplaceVisible.value = true;
  focusFindReplaceInput();
}
async function runFindReplacePreview(): Promise<void> {
  if (findReplaceLoading.value) return;
  if (!findReplaceForm.fieldId) {
    ElMessage.warning("请选择要处理的表头");
    return;
  }
  findReplaceLoading.value = true;
  findReplacePreview.value = null;
  findReplaceScopeCount.value = null;
  try {
    let recordIds = selectedRecordIdsForReplace();
    const selected = Boolean(deps.selection.selectedGridCellPositions().length);
    findReplaceScopeLabel.value = selected ? "选中单元格所在记录" : "当前筛选范围全部记录";
    if (!selected) recordIds = (await deps.queryRecordIds()).record_ids;
    recordIds = [...new Set(recordIds)];
    findReplaceScopeCount.value = recordIds.length;
    if (!recordIds.length) {
      ElMessage.warning("当前范围没有记录");
      return;
    }
    findReplacePreview.value = await previewReplace({
      project_id: deps.getProjectId(),
      field_id: findReplaceForm.fieldId,
      record_ids: recordIds,
      find: findReplaceForm.find,
      replacement: findReplaceForm.replacement,
      match_mode: findReplaceForm.matchMode,
      case_sensitive: findReplaceForm.caseSensitive,
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "查找替换预览失败");
  } finally {
    findReplaceLoading.value = false;
  }
}
async function commitFindReplace(): Promise<void> {
  const preview = findReplacePreview.value;
  if (!preview?.token) return;
  findReplaceLoading.value = true;
  try {
    const hasErrors = preview.issues.some((issue) => issue.severity === "error");
    if (hasErrors) {
      ElMessage.error("存在严格验证错误，不能提交");
      return;
    }
    const result = await commitReplace(
      preview.token,
      preview.issues.some((issue) => issue.severity === "warning"),
    );
    result.records.forEach(deps.replaceRecord);
    deps.pushCellHistory("查找替换", result.changes, deps.getProjectId());
    findReplaceVisible.value = false;
    ElMessage.success(`已替换 ${result.changes.length} 个单元格，可一次撤销`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "查找替换提交失败");
  } finally {
    findReplaceLoading.value = false;
  }
}
function cancelFindTermDebounce(): void {
  if (findTermDebounceTimer !== undefined) window.clearTimeout(findTermDebounceTimer);
  findTermDebounceTimer = undefined;
}

function applyFindTermImmediately(): void {
  if (findTermDebounceTimer !== undefined) {
    window.clearTimeout(findTermDebounceTimer);
    findTermDebounceTimer = undefined;
  }
  debouncedFindTerm.value = findReplaceForm.find;
}
watch(() => findReplaceForm.find, (term) => {
  if (findTermDebounceTimer !== undefined) window.clearTimeout(findTermDebounceTimer);
  findTermDebounceTimer = window.setTimeout(() => {
    findTermDebounceTimer = undefined;
    debouncedFindTerm.value = term;
  }, FIND_TERM_DEBOUNCE_MS);
});

watch(findReplaceForm, () => {
  findReplacePreview.value = null;
  findCurrentMatchIndex.value = -1;
}, { flush: "sync" });
watch(findMatches, () => {
  findCurrentMatchIndex.value = -1;
}, { flush: "sync" });

  return {
    findReplaceVisible,
    findReplaceLoading,
    findReplacePreview,
    findReplaceScopeCount,
    findReplaceScopeLabel,
    findReplaceMode,
    findReplaceInputRef,
    findReplaceForm,
    findMatches,
    findCurrentMatch,
    findMatchStatus,
    setFindReplaceMode,
    openFindReplace,
    runFindReplacePreview,
    commitFindReplace,
    handleFindReplaceInputEnter,
    navigateFindMatch,
    cancelFindTermDebounce,
    focusFindReplaceInput,
    restoreFindReplaceGridFocus,
  };
}
