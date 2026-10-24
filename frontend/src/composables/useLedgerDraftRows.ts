import { type ComputedRef, type Ref } from "vue";

import type { FieldDefinition, Project, ProjectRecord } from "@/types/api";
import { cloneLedgerRecord } from "@/composables/useLedgerHistory";
import {
  reanchorInsertedDraftGroup,
  type LedgerInsertedGroupRegistry,
  type LedgerDraftPlacement,
  type LedgerRow,
} from "@/utils/ledgerTableView";

/**
 * 台账插入草稿行生命周期（P3-a）：创建、成组插入、移除与脏判。
 *
 * `draftRows` ref 由视图创建并注入（跨区块状态：派生行、加载编排、
 * 关闭守卫都读它）；持久化三件套（persistDraft / finishPersistedDraft /
 * locatePersistedRecord）属保存编排，保留在视图。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数（setupState 契约）。
 */
export interface LedgerDraftRowsDeps {
  draftRows: Ref<LedgerRow[]>;
  fields: ComputedRef<FieldDefinition[]>;
  currentProject: ComputedRef<Project | undefined>;
  activeProjectId: Ref<string>;
  loading: Ref<boolean>;
  cellSave: {
    persistedKey: (recordId: string, fieldId: string) => string;
    clearCellSaveState: (key: string) => void;
    dropCellSaveVersion: (key: string) => void;
    dropCellSaveInFlight: (key: string) => void;
    setSaving: (recordId: string, saving: boolean) => void;
    fieldErrors: Ref<Record<string, string>>;
  };
  selection: {
    activeGridCell: Ref<unknown>;
    clearGridCellSelection: () => void;
  };
  editing: {
    editingGridSnapshot: Ref<{ rowId: string } | null>;
    clearGridCellEdit: () => void;
  };
  scrollToBottom: () => void;
}

export function useLedgerDraftRows(deps: LedgerDraftRowsDeps): {
  isDraft: (record: LedgerRow) => boolean;
  makeDraftRow: (insertion?: {
    anchorId: string;
    placement: LedgerDraftPlacement;
    groupId: string;
    order: number;
  }) => LedgerRow;
  nextInsertGroupId: () => string;
  appendDraftRow: (scrollToBottom?: boolean) => void;
  removeDraftRows: (recordIds: Set<string>) => void;
  dirtyLedgerDrafts: () => LedgerRow[];
  snapshotRecord: (record: ProjectRecord) => ProjectRecord;
  reanchorPendingInsertedDrafts: (record: LedgerRow, created: ProjectRecord) => void;
  cleanupInsertedGroupRegistry: () => void;
} {
  const insertedGroupRegistry: LedgerInsertedGroupRegistry = new Map();
  let draftSequence = 0;

  function nextInsertGroupId(): string {
    return `insert-${draftSequence + 1}`;
  }

function isDraft(record: LedgerRow): boolean {
  return record._draft === true;
}
function makeDraftRow(
  insertion?: {
    anchorId: string;
    placement: LedgerDraftPlacement;
    groupId: string;
    order: number;
  },
): LedgerRow {
  const now = new Date().toISOString();
  draftSequence += 1;
  return {
    id: `draft-${draftSequence}`,
    _draft: true,
    _insertAnchorId: insertion?.anchorId,
    _insertPlacement: insertion?.placement,
    _insertGroupId: insertion?.groupId,
    _insertGroupOrder: insertion?.order,
    _insertOriginAnchorId: insertion?.anchorId,
    _insertOriginPlacement: insertion?.placement,
    project_id: deps.activeProjectId.value,
    project_name: deps.currentProject.value?.name ?? "",
    position: 0,
    pathology_number: "",
    block_number: null,
    status: "待实验",
    experiment_date: null,
    experiment_number: null,
    report_generated: false,
    locked: false,
    highlight_color: null,
    cell_highlight_colors: {},
    values: Object.fromEntries(
      deps.fields.value
        .filter((field) => !field.is_core && field.default_value != null)
        .map((field) => [field.id, field.default_value ?? ""]),
    ),
    created_at: now,
    updated_at: now,
  };
}
function appendDraftRow(scrollToBottom = true): void {
  if (!deps.currentProject.value || deps.loading.value) return;
  const draft = makeDraftRow();
  deps.draftRows.value.push(draft);
  if (scrollToBottom) {
    deps.scrollToBottom();
  }
}
function removeDraftRows(recordIds: Set<string>): void {
  if (!recordIds.size) return;
  deps.fields.value.forEach((field) => {
    recordIds.forEach((recordId) => {
      const key = deps.cellSave.persistedKey(recordId, field.id);
      deps.cellSave.clearCellSaveState(key);
      deps.cellSave.dropCellSaveVersion(key);
      deps.cellSave.dropCellSaveInFlight(key);
      const nextErrors = { ...deps.cellSave.fieldErrors.value };
      delete nextErrors[key];
      deps.cellSave.fieldErrors.value = nextErrors;
    });
  });
  deps.draftRows.value = deps.draftRows.value.filter((record) => !recordIds.has(record.id));
  cleanupInsertedGroupRegistry();
  if (deps.editing.editingGridSnapshot.value && recordIds.has(deps.editing.editingGridSnapshot.value.rowId)) {
    deps.editing.clearGridCellEdit();
  }
  deps.selection.activeGridCell.value = null;
  deps.selection.clearGridCellSelection();
  recordIds.forEach((recordId) => deps.cellSave.setSaving(recordId, false));
}
function dirtyLedgerDrafts(): LedgerRow[] {
  return deps.draftRows.value.filter((record) =>
    Boolean(record.pathology_number.trim() || record.block_number || record.experiment_date || record.experiment_number) ||
    record.status !== "待实验" || deps.fields.value.some((field) =>
      !field.is_core && (record.values[field.id] ?? "") !== (field.default_value ?? "")));
}
function snapshotRecord(record: ProjectRecord): ProjectRecord {
  return cloneLedgerRecord(record);
}
function reanchorPendingInsertedDrafts(record: LedgerRow, created: ProjectRecord): void {
  reanchorInsertedDraftGroup(deps.draftRows.value, record, created.id, insertedGroupRegistry);
}
function cleanupInsertedGroupRegistry(): void {
  const activeGroupIds = new Set(
    deps.draftRows.value.flatMap((draft) => draft._insertGroupId ? [draft._insertGroupId] : []),
  );
  insertedGroupRegistry.forEach((_, groupId) => {
    if (!activeGroupIds.has(groupId)) insertedGroupRegistry.delete(groupId);
  });
}

  return {
    isDraft,
    makeDraftRow,
    nextInsertGroupId,
    appendDraftRow,
    removeDraftRows,
    dirtyLedgerDrafts,
    snapshotRecord,
    reanchorPendingInsertedDrafts,
    cleanupInsertedGroupRegistry,
  };
}
