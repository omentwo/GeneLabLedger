import { ElMessage } from "element-plus";
import type { ComputedRef, Ref } from "vue";

import { createRecord, validateNewRecord } from "@/api/records";
import type { useLedgerValidationPanel } from "@/composables/useLedgerValidationPanel";
import { buildValidationPromptCopy } from "@/utils/validationPrompt";
import { normalizeDateInput } from "@/utils/datetime";
import { resolveCreatedRecordRefreshPlan } from "@/utils/ledgerPersistence";
import type { FieldDefinition, Project, ProjectRecord, RecordCreateInput } from "@/types/api";
import type { LedgerRangeSettings } from "@/utils/ledgerRangeSettings";
import type { LedgerFilterMap, LedgerRow } from "@/utils/ledgerTableView";

/**
 * 台账草稿持久化三件套（P3-b）：校验创建（persistDraft）、落库后的
 * 记录替换与撤销历史（finishPersistedDraft）、持久化记录的定位
 * （locatePersistedRecord）。
 *
 * 属保存编排而非状态：滚动定位、加载与查询回调由视图注入。
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数（setupState 契约）。
 */
type PersistedRecordLocation = "focused" | "filtered-out" | "skipped" | "failed";

export interface LedgerPersistDraftDeps {
  drafts: {
    draftRows: Ref<LedgerRow[]>;
    isDraft: (record: LedgerRow) => boolean;
    removeDraftRows: (recordIds: Set<string>) => void;
    reanchorPendingInsertedDrafts: (record: LedgerRow, created: ProjectRecord) => void;
    cleanupInsertedGroupRegistry: () => void;
  };
  fields: ComputedRef<FieldDefinition[]>;
  cellSave: {
    savingIds: Ref<Set<string>>;
    fields: ComputedRef<FieldDefinition[]>;
    setFieldError: (record: LedgerRow, field: FieldDefinition, message: string) => void;
    clearFieldError: (record: LedgerRow, field: FieldDefinition) => void;
    setSaving: (recordId: string, saving: boolean) => void;
    rememberRecord: (record: ProjectRecord) => void;
  };
  panel: {
    openValidationPanel: ReturnType<typeof useLedgerValidationPanel>["openValidationPanel"];
  };
  editing: {
    editingGridSnapshot: Ref<{ rowId: string } | null>;
    clearGridCellEdit: (invalidateSession?: boolean) => void;
  };
  currentProject: ComputedRef<Project | undefined>;
  records: Ref<ProjectRecord[]>;
  loadedRecordCount: Ref<number>;
  recordTotal: Ref<number>;
  focusRecordId: Ref<string>;
  ledgerRangeSettings: Ref<LedgerRangeSettings>;
  ledgerFilters: Ref<LedgerFilterMap>;
  activeProjectId: () => string;
  invalidateProjectRecordCache: (projectId: string) => void;
  pushHistory: (label: string, before: ProjectRecord[], after: ProjectRecord[], projectId?: string) => void;
  queryRecordIds: (projectId: string) => Promise<{ record_ids: string[]; total: number }>;
  loadRecords: (projectId: string, options?: { preserveHistory?: boolean; preserveSelection?: boolean }) => Promise<boolean>;
  scrollToFocusedRecord: (shouldApply?: () => boolean) => Promise<boolean>;
}

export function useLedgerPersistDraft(deps: LedgerPersistDraftDeps): {
  persistDraft: (record: LedgerRow, notify?: boolean) => Promise<boolean>;
  locatePersistedRecord: (recordId: string, projectId: string) => Promise<PersistedRecordLocation>;
  finishPersistedDraft: (record: LedgerRow, created: ProjectRecord, projectId: string, notify: boolean) => Promise<void>;
} {
async function persistDraft(record: LedgerRow, notify = true): Promise<boolean> {
  if (!deps.drafts.isDraft(record) || !deps.currentProject.value) return false;
  const pathologyNumber = record.pathology_number.trim();
  if (!pathologyNumber || deps.cellSave.savingIds.value.has(record.id)) return false;
  const projectId = deps.currentProject.value.id;
  const dateField = deps.fields.value.find((field) => field.system_key === "experiment_date");
  let experimentDate = "";

  try {
    experimentDate = normalizeDateInput(record.experiment_date ?? "");
  } catch (error) {
    if (dateField) {
      deps.cellSave.setFieldError(
        record,
        dateField,
        error instanceof Error ? error.message : "日期格式无效",
      );
    }
    return false;
  }
  if (dateField) deps.cellSave.clearFieldError(record, dateField);

  deps.cellSave.setSaving(record.id, true);
  try {
    const values: Record<string, string> = {};
    deps.fields.value.forEach((field) => {
      if (!field.is_core) values[field.id] = (record.values[field.id] ?? "").trim();
    });
    const payload: RecordCreateInput = {
      project_id: projectId,
      pathology_number: pathologyNumber,
      block_number: record.block_number?.trim() || null,
      status: record.status,
      experiment_date: experimentDate || null,
      experiment_number: record.experiment_number?.trim() || null,
      values,
      ...(record._insertAnchorId && record._insertPlacement === "before"
        ? { insert_before_record_id: record._insertAnchorId }
        : {}),
      ...(record._insertAnchorId && record._insertPlacement === "after"
        ? { insert_after_record_id: record._insertAnchorId }
        : {}),
    };
    const validation = await validateNewRecord(payload);
    const errors = validation.issues.filter((issue) => issue.severity === "error");
    const warnings = validation.issues.filter((issue) => issue.severity === "warning");
    if (errors.length || warnings.length) {
      const prompt = errors.length
        ? {
            title: "无法保存",
            outcomeText: "当前内容尚未保存，请按提示修改后重试。",
            cancelText: "返回修改",
            continueText: "",
          }
        : buildValidationPromptCopy(warnings, {
            context: "create",
            cancelBehavior: "discard",
          });
      deps.panel.openValidationPanel(
        {
          token: "",
          projectId,
          ...prompt,
          label: "新增台账记录",
          issues: validation.issues,
          affectedCount: 1,
          skippedLocked: 0,
          cellKeys: [],
          cellVersions: {},
          canContinue: !errors.length,
        },
        errors.length
          ? undefined
          : {
              action: async () => {
                const created = await createRecord(payload);
                await finishPersistedDraft(record, created, projectId, notify);
              },
              cancel: () => {
                deps.drafts.removeDraftRows(new Set([record.id]));
                ElMessage.info("已放弃本次新增，未写入台账");
              },
            },
      );
      return false;
    }
    const created = await createRecord(payload);
    await finishPersistedDraft(record, created, projectId, notify);
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "记录自动保存失败");
    return false;
  } finally {
    deps.cellSave.setSaving(record.id, false);
  }
}
function currentRecordViewHasMembershipFilters(): boolean {
  return deps.ledgerRangeSettings.value.mode !== "all" || Object.values(deps.ledgerFilters.value).some(Boolean);
}
async function locatePersistedRecord(
  recordId: string,
  projectId: string,
): Promise<PersistedRecordLocation> {
  if (deps.activeProjectId() !== projectId) {
    return "skipped";
  }
  if (!currentRecordViewHasMembershipFilters()) {
    deps.loadedRecordCount.value = deps.records.value.length;
    deps.focusRecordId.value = recordId;
    await deps.scrollToFocusedRecord(
      () => deps.activeProjectId() === projectId,
    );
    return "focused";
  }
  try {
    const result = await deps.queryRecordIds(projectId);
    if (deps.activeProjectId() !== projectId) {
      return "skipped";
    }
    deps.recordTotal.value = result.total;
    const refreshPlan = resolveCreatedRecordRefreshPlan({
      localRecordIds: deps.records.value.map((record) => record.id),
      queriedRecordIds: result.record_ids,
      createdRecordId: recordId,
    });
    if (refreshPlan === "local-filtered-out") {
      deps.records.value = deps.records.value.filter((record) => record.id !== recordId);
      deps.loadedRecordCount.value = deps.records.value.length;
      deps.focusRecordId.value = "";
      return "filtered-out";
    }
    if (refreshPlan === "local-visible") {
      deps.loadedRecordCount.value = deps.records.value.length;
      deps.focusRecordId.value = recordId;
      await deps.scrollToFocusedRecord(
        () => deps.activeProjectId() === projectId,
      );
      return "focused";
    }
    const recordIsVisible = result.record_ids.includes(recordId);
    if (!recordIsVisible) deps.focusRecordId.value = "";
    else deps.focusRecordId.value = recordId;
    const loaded = await deps.loadRecords(projectId, {
      preserveHistory: true,
      preserveSelection: true,
    });
    if (!recordIsVisible) return "filtered-out";
    if (!loaded) {
      deps.focusRecordId.value = "";
      return "failed";
    }
    return "focused";
  } catch {
    deps.focusRecordId.value = "";
    return "failed";
  }
}
async function finishPersistedDraft(
  record: LedgerRow,
  created: ProjectRecord,
  projectId: string,
  notify: boolean,
): Promise<void> {
  deps.invalidateProjectRecordCache(projectId);
  if (deps.editing.editingGridSnapshot.value?.rowId === record.id) {
    // The enclosing finish operation still owns this session. It will decide
    // whether focus/selection may be applied after the async save completes.
    deps.editing.clearGridCellEdit(false);
  }
  const draftIndex = deps.drafts.draftRows.value.findIndex((item) => item.id === record.id);
  deps.drafts.reanchorPendingInsertedDrafts(record, created);
  if (draftIndex >= 0) deps.drafts.draftRows.value.splice(draftIndex, 1);
  deps.drafts.cleanupInsertedGroupRegistry();
  if (deps.activeProjectId() === projectId) {
    if (record._insertAnchorId) {
      deps.records.value = deps.records.value.map((item) =>
        item.position >= created.position
          ? { ...item, position: item.position + 1 }
          : item,
      );
    }
    deps.records.value.push(created);
    deps.records.value.sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
    deps.recordTotal.value += 1;
    deps.cellSave.rememberRecord(created);
  }
  deps.pushHistory("新增台账记录", [], [created], projectId);
  const location = await locatePersistedRecord(created.id, projectId);
  if (notify) {
    if (location === "filtered-out") {
      ElMessage.success("病理号已保存，但该记录不符合当前筛选条件；可使用撤销删除本次新增");
    } else if (location === "failed") {
      ElMessage.warning("病理号已保存，但自动定位失败；刷新或搜索后可查看该记录");
    } else {
      ElMessage.success(
        location === "focused"
          ? "病理号已保存并定位；可使用撤销删除本次新增"
          : "病理号已保存并创建台账记录；可使用撤销删除本次新增",
      );
    }
  }
}

  return {
    persistDraft,
    locatePersistedRecord,
    finishPersistedDraft,
  };
}
