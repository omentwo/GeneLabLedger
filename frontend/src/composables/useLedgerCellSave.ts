import { ref, type ComputedRef, type Ref } from "vue";
import { ElMessage } from "element-plus";

import { ApiError } from "@/api/client";
import { commitCellBatch, previewCellBatch, updateRecordCell } from "@/api/records";
import type { useLedgerCellSaveState, CellSaveState } from "@/composables/useLedgerCellSaveState";
import type { useLedgerValidationPanel, ValidationPanelState } from "@/composables/useLedgerValidationPanel";
import type { useLedgerHistory } from "@/composables/useLedgerHistory";
import { cloneLedgerRecord, createLedgerCellHistoryEntry } from "@/composables/useLedgerHistory";
import { normalizeDateInput } from "@/utils/datetime";
import {
  resolveLedgerCellCompletionAction,
  resolveLedgerCellEditState,
} from "@/utils/ledgerPersistence";
import { getRecordFieldValue as valueFor } from "@/utils/recordFieldValue";
import { buildValidationPromptCopy, isValidationSnapshotCurrent } from "@/utils/validationPrompt";
import type {
  FieldDefinition,
  ProjectRecord,
  RecordCellBatchCommitResult,
  RecordStatus,
  RecordValidationIssue,
} from "@/types/api";
import type { LedgerRow } from "@/utils/ledgerTableView";

/**
 * 台账单元格保存管线（P1-5 核心）：本地校验、值写入、原子保存、
 * 两段式降级、保存后完成动作与未保存修改跟踪。
 *
 * 依赖注入约定：`cellSave`（状态机）、`panel`（确认面板）、`history`
 * （撤销栈）、记录选择缓存、草稿与刷新回调都由视图提供——
 * 草稿落库（persistDraft）、粘贴（pasteGrid）、关闭前保存等编排
 * 仍是视图的消费者，经本模块的散装 API 说话。
 *
 * 与 useLedgerContext 相同的约束：返回散装 ref / 函数，
 * 调用方在 `<script setup>` 顶层解构（`_instance.setupState` 契约）。
 */
export type ValidationCellRollbackSnapshot = {
  key: string;
  recordId: string;
  fieldId: string;
  beforeValue: string;
  previousSaveState: CellSaveState | null;
  previousFieldError: string | null;
};

export interface LedgerCellSaveDeps {
  cellSave: ReturnType<typeof useLedgerCellSaveState>;
  panel: {
    validationPanel: Ref<ValidationPanelState | null>;
    openValidationPanel: ReturnType<typeof useLedgerValidationPanel>["openValidationPanel"];
    dismissValidationPanel: () => void;
    hasPendingValidationAction: () => boolean;
  };
  history: ReturnType<typeof useLedgerHistory>;
  records: Ref<ProjectRecord[]>;
  fields: ComputedRef<FieldDefinition[]>;
  tableRows: ComputedRef<LedgerRow[]>;
  fieldById: ComputedRef<Map<string, FieldDefinition>>;
  recordSelection: {
    selectedRecords: Ref<ProjectRecord[]>;
    selectedRecordIds: Ref<Set<string>>;
    selectedRecordCache: Map<string, ProjectRecord>;
  };
  activeProjectId: () => string;
  isDraft: (record: LedgerRow) => boolean;
  persistDraft: (record: LedgerRow) => Promise<boolean>;
  replaceRecord: (updated: ProjectRecord) => void;
  /** 单格保存后原地更新记录缓存（整体失效会让项目切换的 preferCache 永远落空）。 */
  updateCachedRecord: (projectId: string, record: ProjectRecord) => void;
  scheduleLedgerRangeRefresh: (projectId: string) => void;
}

export function useLedgerCellSave(deps: LedgerCellSaveDeps): {
  savingIds: Ref<Set<string>>;
  fieldErrors: Ref<Record<string, string>>;
  /** 已落库值的快照（键为 persistedKey）；粘贴比对与卸载清理也直接读它。 */
  persistedValues: Map<string, string>;
  setSaving: (recordId: string, saving: boolean) => void;
  fieldErrorFor: (record: LedgerRow, field: FieldDefinition) => string;
  setFieldError: (record: LedgerRow, field: FieldDefinition, message: string) => void;
  clearFieldError: (record: LedgerRow, field: FieldDefinition) => void;
  rememberRecord: (record: ProjectRecord) => void;
  rememberAll: () => void;
  validateCellInput: (record: ProjectRecord, field: FieldDefinition, rawValue: string) => void;
  setValue: (record: ProjectRecord, field: FieldDefinition, value: string, options?: { markDirty?: boolean }) => void;
  cellSaveStateFor: (record: LedgerRow, field: FieldDefinition) => CellSaveState | null;
  dirtyLedgerChanges: () => Array<{ record_id: string; field_id: string; value: string; expected_value: string }>;
  hasDirtyLedgerChanges: () => boolean;
  replaceRecordPreservingPending: (updated: ProjectRecord, completedKeys: string | Set<string>) => void;
  reconcileCellAfterCompletedSave: (
    recordId: string,
    fieldId: string,
    completedVersion: number,
    recordHistory: boolean,
  ) => void;
  captureValidationCellRollback: (record: LedgerRow, field: FieldDefinition) => ValidationCellRollbackSnapshot;
  rollbackValidationCells: (snapshots: ValidationCellRollbackSnapshot[], versions: Record<string, number>) => void;
  pushCellHistory: (
    label: string,
    changes: RecordCellBatchCommitResult["changes"],
    projectId?: string,
  ) => void;
  showCellErrorPanel: (
    record: LedgerRow,
    field: FieldDefinition,
    issues: RecordValidationIssue[],
    key: string,
    version: number,
  ) => void;
  saveField: (record: LedgerRow, field: FieldDefinition, options?: { recordHistory?: boolean }) => Promise<boolean>;
  saveFieldWithPreview: (
    record: LedgerRow,
    field: FieldDefinition,
    current: string,
    expectedValue: string,
    key: string,
    initialBefore: string,
    version: number,
  ) => Promise<Array<{ record_id: string; field_id: string; before: string; after: string }>>;
  apiDetailCode: (error: unknown) => string | null;
  validationIssuesFromError: (error: unknown) => RecordValidationIssue[];
} {
  const {
    persistedKey,
    setCellSaveState,
    clearCellSaveState,
    peekCellSaveVersion,
    nextCellSaveVersion,
    restoreCellSaveVersion,
    beginCellSave,
    endCellSave,
    cellSaveInFlightCount,
    cellSaveStates,
    enqueueRecordSave,
  } = deps.cellSave;
  const {
    validationPanel,
    openValidationPanel,
    dismissValidationPanel,
    hasPendingValidationAction,
  } = deps.panel;
  const { records, fields, tableRows, fieldById } = deps;
  const { selectedRecords, selectedRecordIds, selectedRecordCache } = deps.recordSelection;

  const savingIds = ref(new Set<string>());
  const fieldErrors = ref<Record<string, string>>({});
  const persistedValues = new Map<string, string>();
  const dirtyCellKeys = new Set<string>();
  /** setSaving 的引用计数：同一记录多个保存排队时，前一个完成不得提前摘掉标记。 */
  const savingCounts = new Map<string, number>();

  function setSaving(recordId: string, saving: boolean): void {
    const current = savingCounts.get(recordId) ?? 0;
    const next = saving ? current + 1 : Math.max(0, current - 1);
    if (next === current) return;
    if (next > 0) savingCounts.set(recordId, next);
    else savingCounts.delete(recordId);
    const ids = new Set(savingIds.value);
    if (next > 0) ids.add(recordId);
    else ids.delete(recordId);
    savingIds.value = ids;
  }

  function fieldErrorFor(record: LedgerRow, field: FieldDefinition): string {
    return fieldErrors.value[persistedKey(record.id, field.id)] ?? "";
  }

  function setFieldError(record: LedgerRow, field: FieldDefinition, message: string): void {
    fieldErrors.value = {
      ...fieldErrors.value,
      [persistedKey(record.id, field.id)]: message,
    };
  }

  function clearFieldError(record: LedgerRow, field: FieldDefinition): void {
    const key = persistedKey(record.id, field.id);
    if (!(key in fieldErrors.value)) return;
    const next = { ...fieldErrors.value };
    delete next[key];
    fieldErrors.value = next;
  }

  function rememberRecord(record: ProjectRecord): void {
    fields.value.forEach((field) => {
      const key = persistedKey(record.id, field.id);
      persistedValues.set(key, valueFor(record, field));
      dirtyCellKeys.delete(key);
    });
  }

  function rememberAll(): void {
    persistedValues.clear();
    dirtyCellKeys.clear();
    records.value.forEach(rememberRecord);
  }

  /**
   * Validate one cell locally before it reaches the server.
   *
   * This used to build a `RecordUpdateInput` payload that every caller discarded,
   * so only the side effects (date normalization and the thrown messages) were
   * ever used.  It now says what it does: validate, normalize, or throw.
   */
  function validateCellInput(
    record: ProjectRecord,
    field: FieldDefinition,
    rawValue: string,
  ): void {
    const value = rawValue.trim();
    if (field.system_key === "pathology_number") {
      if (!value) throw new Error("病理号不能为空");
      return;
    }
    if (field.system_key === "experiment_date") {
      const normalized = normalizeDateInput(value);
      record.experiment_date = normalized || null;
      return;
    }
    if (field.system_key === "status" && value !== "待实验" && value !== "已完成") {
      throw new Error("状态只能是“待实验”或“已完成”");
    }
  }

  function setValue(
    record: ProjectRecord,
    field: FieldDefinition,
    value: string,
    options: { markDirty?: boolean } = {},
  ): void {
    if (field.system_key === "pathology_number") {
      record.pathology_number = value;
    } else if (field.system_key === "block_number") {
      record.block_number = value || null;
    } else if (field.system_key === "experiment_date") {
      record.experiment_date = value || null;
    } else if (field.system_key === "experiment_number") {
      record.experiment_number = value || null;
    } else if (field.system_key === "status") {
      record.status = value as RecordStatus;
    } else {
      record.values[field.id] = value;
    }
    clearFieldError(record, field);
    if (options.markDirty ?? true) {
      const key = persistedKey(record.id, field.id);
      nextCellSaveVersion(key);
      if (validationPanel.value?.cellKeys.includes(key)) dismissValidationPanel();
      if (deps.isDraft(record) && hasPendingValidationAction() && validationPanel.value?.label === "新增台账记录") {
        dismissValidationPanel();
      }
    }
    if ((options.markDirty ?? true) && !deps.isDraft(record)) {
      const key = persistedKey(record.id, field.id);
      const editState = resolveLedgerCellEditState(
        valueFor(record, field),
        persistedValues.get(key) ?? "",
        cellSaveInFlightCount(key),
      );
      if (editState === "clear") {
        clearCellSaveState(key);
      } else {
        setCellSaveState(record.id, field.id, { status: "dirty" });
      }
    }
    if (!deps.isDraft(record)) {
      const key = persistedKey(record.id, field.id);
      if (valueFor(record, field) === (persistedValues.get(key) ?? "")) dirtyCellKeys.delete(key);
      else dirtyCellKeys.add(key);
    }
  }

  function captureValidationCellRollback(
    record: LedgerRow,
    field: FieldDefinition,
  ): ValidationCellRollbackSnapshot {
    const key = persistedKey(record.id, field.id);
    const previousSaveState = cellSaveStates.value.get(key);
    return {
      key,
      recordId: record.id,
      fieldId: field.id,
      beforeValue: valueFor(record, field),
      previousSaveState: previousSaveState ? { ...previousSaveState } : null,
      previousFieldError: fieldErrors.value[key] ?? null,
    };
  }

  function rollbackValidationCells(
    snapshots: ValidationCellRollbackSnapshot[],
    versions: Record<string, number>,
  ): void {
    snapshots.forEach((snapshot) => {
      const snapshotVersion = versions[snapshot.key];
      if (
        snapshotVersion === undefined
        || !isValidationSnapshotCurrent(snapshotVersion, peekCellSaveVersion(snapshot.key))
      ) return;
      const record = tableRows.value.find((item) => item.id === snapshot.recordId);
      const field = fieldById.value.get(snapshot.fieldId);
      if (!record || !field) return;
      setValue(record, field, snapshot.beforeValue, { markDirty: false });
      restoreCellSaveVersion(snapshot.key, snapshotVersion + 1);
      if (snapshot.previousFieldError) {
        setFieldError(record, field, snapshot.previousFieldError);
      } else {
        clearFieldError(record, field);
      }
      if (snapshot.previousSaveState) {
        setCellSaveState(record.id, field.id, snapshot.previousSaveState);
      } else {
        clearCellSaveState(snapshot.key);
      }
    });
  }

  function cellSaveStateFor(record: LedgerRow, field: FieldDefinition): CellSaveState | null {
    return cellSaveStates.value.get(persistedKey(record.id, field.id)) ?? null;
  }

  function dirtyLedgerChanges(): Array<{ record_id: string; field_id: string; value: string; expected_value: string }> {
    return records.value.flatMap((record) => fields.value.flatMap((field) => {
      const key = persistedKey(record.id, field.id);
      const before = persistedValues.get(key);
      const value = valueFor(record, field);
      return before !== undefined && value !== before
        ? [{ record_id: record.id, field_id: field.id, value, expected_value: before }]
        : [];
    }));
  }

  /**
   * 高频路径专用的"是否有未保存修改"判断。
   *
   * `dirtyLedgerChanges()` 需要遍历 records × fields（1 万行 × 20 列就是 20 万次
   * 比较），而范围刷新、编辑前置检查这类调用只关心"有没有"。这里用增量维护的
   * key 集合直接回答，并顺带剔除已经回到原值的过期条目。
   *
   * 查找基座必须是未筛选的 `records`：行被本地筛出视图不代表编辑已保存，
   * 按视图索引查找会漏判并把这类编辑暴露给刷新闸门（数据丢失）。
   */
  function hasDirtyLedgerChanges(): boolean {
    if (!dirtyCellKeys.size) return false;
    const recordById = new Map(records.value.map((record) => [record.id, record]));
    for (const key of dirtyCellKeys) {
      const separator = key.indexOf(":");
      if (separator < 0) {
        dirtyCellKeys.delete(key);
        continue;
      }
      const record = recordById.get(key.slice(0, separator));
      const field = fieldById.value.get(key.slice(separator + 1));
      if (!record || !field) {
        // 记录/字段已从数据源消失（重载或换项目后的残留），才是真正的过期。
        dirtyCellKeys.delete(key);
        continue;
      }
      if (valueFor(record, field) !== (persistedValues.get(key) ?? "")) return true;
      dirtyCellKeys.delete(key);
    }
    return false;
  }

  function replaceRecordPreservingPending(
    updated: ProjectRecord,
    completedKeys: string | Set<string>,
  ): void {
    const completed =
      typeof completedKeys === "string" ? new Set([completedKeys]) : completedKeys;
    const current = records.value.find((record) => record.id === updated.id);
    rememberRecord(updated);
    if (!current) {
      deps.replaceRecord(updated);
      return;
    }
    const merged = cloneLedgerRecord(updated);
    fields.value.forEach((field) => {
      const key = persistedKey(updated.id, field.id);
      if (completed.has(key)) return;
      const status = cellSaveStates.value.get(key)?.status;
      if (status === "dirty" || status === "saving" || status === "error") {
        setValue(merged, field, valueFor(current, field), { markDirty: false });
      }
    });
    const index = records.value.findIndex((record) => record.id === updated.id);
    if (index >= 0) records.value.splice(index, 1, merged);
    const selectedIndex = selectedRecords.value.findIndex((record) => record.id === updated.id);
    if (selectedIndex >= 0) selectedRecords.value.splice(selectedIndex, 1, merged);
    if (selectedRecordIds.value.has(updated.id)) selectedRecordCache.set(updated.id, merged);
    deps.updateCachedRecord(updated.project_id, merged);
    deps.scheduleLedgerRangeRefresh(updated.project_id);
  }

  function reconcileCellAfterCompletedSave(
    recordId: string,
    fieldId: string,
    completedVersion: number,
    recordHistory: boolean,
  ): void {
    const key = persistedKey(recordId, fieldId);
    const currentRecord = records.value.find((item) => item.id === recordId);
    const currentField = fields.value.find((item) => item.id === fieldId);
    if (!currentRecord || !currentField || currentRecord.locked) return;
    const currentValue = valueFor(currentRecord, currentField);
    const action = resolveLedgerCellCompletionAction({
      completedVersion,
      currentVersion: peekCellSaveVersion(key),
      currentValue,
      persistedValue: persistedValues.get(key) ?? "",
      inFlightCount: cellSaveInFlightCount(key),
    });
    if (action === "none") return;
    if (action === "pending") return;
    if (action === "clear") {
      clearFieldError(currentRecord, currentField);
      clearCellSaveState(key);
      return;
    }
    setCellSaveState(recordId, fieldId, { status: "dirty" });
    void saveField(currentRecord, currentField, { recordHistory });
  }

  function pushCellHistory(
    label: string,
    changes: RecordCellBatchCommitResult["changes"],
    projectId = deps.activeProjectId(),
  ): void {
    if (!projectId || !changes.length) return;
    deps.history.push(
      createLedgerCellHistoryEntry(
        projectId,
        label,
        changes.map((change) => ({
          recordId: change.record_id,
          fieldId: change.field_id,
          before: change.before,
          after: change.after,
        })),
      ),
    );
  }

  async function saveField(
    record: LedgerRow,
    field: FieldDefinition,
    options: { recordHistory?: boolean } = {},
  ): Promise<boolean> {
    const recordHistory = options.recordHistory ?? true;
    if (deps.isDraft(record)) {
      if (field.system_key === "experiment_date") {
        try {
          const normalized = normalizeDateInput(record.experiment_date ?? "");
          record.experiment_date = normalized || null;
          clearFieldError(record, field);
        } catch (error) {
          setFieldError(
            record,
            field,
            error instanceof Error ? error.message : "日期格式无效",
          );
        }
        return false;
      }
      if (field.system_key === "pathology_number") {
        return deps.persistDraft(record);
      }
      return false;
    }
    if (record.locked) return false;
    const key = persistedKey(record.id, field.id);
    if (validationPanel.value?.cellKeys.includes(key)) {
      dismissValidationPanel();
    }
    const initialBefore = persistedValues.get(key) ?? "";
    const current = valueFor(record, field);
    if (current === initialBefore) {
      clearFieldError(record, field);
      if ((cellSaveInFlightCount(key)) > 0) {
        setCellSaveState(record.id, field.id, { status: "dirty" });
      } else {
        clearCellSaveState(key);
      }
      return false;
    }
    try {
      validateCellInput(record, field, current);
      clearFieldError(record, field);
    } catch (error) {
      if (field.system_key === "experiment_date") {
        setFieldError(
          record,
          field,
          error instanceof Error ? error.message : "日期格式无效",
        );
      } else {
          setValue(record, field, initialBefore, { markDirty: false });
        setCellSaveState(record.id, field.id, {
          status: "error",
          message: error instanceof Error ? error.message : "单元格保存失败",
        });
        ElMessage.error(error instanceof Error ? error.message : "单元格保存失败");
      }
      return false;
    }
    // validateCellInput 会原地规范化日期（record.experiment_date）；
    // 载荷必须取规范化后的值，否则后端收到原文必然拒收，
    // 而单元格显示的却是规范化结果（自相矛盾）。
    const payloadValue = valueFor(record, field);

    const version = nextCellSaveVersion(key);
    beginCellSave(key);
    setCellSaveState(record.id, field.id, { status: "saving" });
    setSaving(record.id, true);
    try {
      const changes = await enqueueRecordSave(record.id, async () => {
        const expectedValue = persistedValues.get(key) ?? initialBefore;
        try {
          const updated = await updateRecordCell(record.id, {
            field_id: field.id,
            value: payloadValue,
            expected_value: expectedValue,
          });
          const currentVersion = peekCellSaveVersion(key) === version;
          replaceRecordPreservingPending(updated.record, currentVersion ? key : new Set<string>());
          return updated.change ? [updated.change] : [];
        } catch (error) {
          // 字段校验失败：直接用接口返回的问题列表渲染面板，不再多发一次预检查。
          if (apiDetailCode(error) === "validation_error") {
            const issues = validationIssuesFromError(error);
            showCellErrorPanel(record, field, issues, key, version);
            throw new Error(issues[0]?.message ?? "单元格保存失败");
          }
          // 需要用户确认的警告（病理号重复）退回两段式，复用同一个确认面板。
          if (apiDetailCode(error) === "duplicate_warning") {
            return await saveFieldWithPreview(record, field, payloadValue, expectedValue, key, initialBefore, version);
          }
          throw error;
        }
      });
      if (peekCellSaveVersion(key) === version) {
        setCellSaveState(record.id, field.id, { status: "saved" });
        if (recordHistory && changes.length) {
          pushCellHistory(`编辑 ${field.label}`, changes, record.project_id);
        }
      }
      return true;
    } catch (error) {
      if (peekCellSaveVersion(key) === version) {
        setCellSaveState(record.id, field.id, {
          status: "error",
          message: error instanceof Error ? error.message : "单元格保存失败",
        });
      }
      if (!validationPanel.value) {
        ElMessage.error(error instanceof Error ? error.message : "单元格保存失败");
      }
      return false;
    } finally {
      setSaving(record.id, false);
      endCellSave(key);
      reconcileCellAfterCompletedSave(record.id, field.id, version, recordHistory);
    }
  }

  /**
   * 带确认面板的单格保存（病理号重复警告等场景）。
   *
   * 与原子接口的差别只是"先把预检查结果显示给用户"，提交仍然走同一个
   * cell-batch 通道，因此两条路径的校验规则完全一致。
   */
  async function saveFieldWithPreview(
    record: LedgerRow,
    field: FieldDefinition,
    current: string,
    expectedValue: string,
    key: string,
    initialBefore: string,
    version: number,
  ): Promise<Array<{ record_id: string; field_id: string; before: string; after: string }>> {
    const preview = await previewCellBatch(record.project_id, [
      {
        record_id: record.id,
        field_id: field.id,
        value: current,
        expected_value: expectedValue,
      },
    ]);
    const errors = preview.issues.filter((issue) => issue.severity === "error");
    const warnings = preview.issues.filter((issue) => issue.severity === "warning");
    if (errors.length || warnings.length) {
      const prompt = errors.length
        ? {
            title: "无法保存",
            outcomeText: "当前修改尚未保存，请按提示调整后重试。",
            cancelText: "返回修改",
            continueText: "",
          }
        : buildValidationPromptCopy(warnings, {
            context: "edit",
            cancelBehavior: "discard",
            originalValue: initialBefore,
          });
      openValidationPanel(
        {
          token: preview.token,
          projectId: record.project_id,
          ...prompt,
          label: `编辑 ${field.label}`,
          issues: preview.issues,
          affectedCount: preview.affected_count,
          skippedLocked: preview.skipped_locked,
          cellKeys: [key],
          cellVersions: { [key]: version },
          canContinue: !errors.length,
        },
        errors.length
          ? undefined
          : {
              cancel: () => {
                rollbackValidationCells([
                  {
                    key,
                    recordId: record.id,
                    fieldId: field.id,
                    beforeValue: initialBefore,
                    previousSaveState: null,
                    previousFieldError: null,
                  },
                ], { [key]: version });
                ElMessage.info("已取消修改并恢复原值");
              },
            },
      );
      throw new Error(errors[0]?.message ?? "存在警告，请在验证面板中确认后继续");
    }
    if (preview.issues.length) {
      openValidationPanel({
        token: "",
        projectId: record.project_id,
        title: "操作提示",
        label: `编辑 ${field.label}`,
        outcomeText: "修改已经通过校验并将继续保存。",
        cancelText: "我知道了",
        continueText: "",
        issues: preview.issues,
        affectedCount: preview.affected_count,
        skippedLocked: preview.skipped_locked,
        cellKeys: [key],
        cellVersions: { [key]: version },
        canContinue: false,
      });
    }
    const committed = await commitCellBatch(preview.token);
    const currentVersion = peekCellSaveVersion(key) === version;
    committed.records.forEach((updated) =>
      replaceRecordPreservingPending(updated, currentVersion ? key : new Set<string>()),
    );
    return committed.changes;
  }

  function showCellErrorPanel(
    record: LedgerRow,
    field: FieldDefinition,
    issues: RecordValidationIssue[],
    key: string,
    version: number,
  ): void {
    openValidationPanel({
      token: "",
      projectId: record.project_id,
      title: "无法保存",
      label: `编辑 ${field.label}`,
      outcomeText: "当前修改尚未保存，请按提示调整后重试。",
      cancelText: "返回修改",
      continueText: "",
      issues,
      affectedCount: issues.length,
      skippedLocked: 0,
      cellKeys: [key],
      cellVersions: { [key]: version },
      canContinue: false,
    });
  }

  /** 读取 `ApiError.detail` 里的机器可读错误码（后端 HTTPException.detail）。 */
  function apiDetailCode(error: unknown): string | null {
    if (!(error instanceof ApiError)) return null;
    const body = error.detail;
    if (!body || typeof body !== "object") return null;
    const inner = (body as { detail?: unknown }).detail;
    const candidate = inner && typeof inner === "object" ? inner : body;
    const code = (candidate as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  /** 从 `validation_error` 响应里取出可直接渲染的问题列表。 */
  function validationIssuesFromError(error: unknown): RecordValidationIssue[] {
    if (!(error instanceof ApiError) || !error.detail || typeof error.detail !== "object") return [];
    const inner = (error.detail as { detail?: unknown }).detail;
    const issues = (inner as { issues?: unknown } | undefined)?.issues;
    if (!Array.isArray(issues)) return [];
    return issues.filter((issue): issue is RecordValidationIssue =>
      Boolean(issue && typeof issue === "object"));
  }

  return {
    savingIds,
    fieldErrors,
    persistedValues,
    setSaving,
    fieldErrorFor,
    setFieldError,
    clearFieldError,
    rememberRecord,
    rememberAll,
    validateCellInput,
    setValue,
    cellSaveStateFor,
    dirtyLedgerChanges,
    hasDirtyLedgerChanges,
    captureValidationCellRollback,
    rollbackValidationCells,
    replaceRecordPreservingPending,
    reconcileCellAfterCompletedSave,
    pushCellHistory,
    showCellErrorPanel,
    saveField,
    saveFieldWithPreview,
    apiDetailCode,
    validationIssuesFromError,
  };
}
