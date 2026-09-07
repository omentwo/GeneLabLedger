<script setup lang="ts">
import {
  ArrowLeft,
  Dna,
  GripVertical,
  Pencil as EditPen,
  Lock,
  Plus,
  RefreshCw as Refresh,
  Search,
  Settings2 as Setting,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  commitCellBatch,
  listRecords,
  previewCellBatch,
  quickCreateRecord,
} from "@/api/records";
import { getSetting, putSetting } from "@/api/system";
import EditableChoiceInput from "@/components/EditableChoiceInput.vue";
import EditableDateInput from "@/components/EditableDateInput.vue";
import { useAppStore } from "@/stores/app";
import type { FieldDefinition, ProjectRecord, RecordValidationIssue } from "@/types/api";
import type { QuickEntryOpenContext } from "@/types/electron";
import { desktopBridge } from "@/utils/desktop";
import {
  QUICK_ENTRY_SETTINGS_KEY,
  QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
  QUICK_ENTRY_FIELD_WIDTH_MAX,
  QUICK_ENTRY_FIELD_WIDTH_MIN,
  buildQuickEntryChanges,
  isMandatoryQuickEntryField,
  normalizeQuickEntrySettings,
  parseCombinedPathologyNumber,
  quickEntryDefaultValue,
  quickEntryFieldValue,
  resolveQuickEntryProjectSettings,
  unreportedQuickEntryRecords,
  type QuickEntryFieldDefaults,
  type QuickEntryProjectSettings,
  type QuickEntrySettingsDocument,
} from "@/utils/quickEntry";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const bridge = desktopBridge();

const activeProjectId = ref("");
const unreportedRecords = ref<ProjectRecord[]>([]);
const activeRecord = ref<ProjectRecord | null>(null);
const activeRecordUnavailable = ref(false);
const recordSearch = ref("");
const recordsLoading = ref(false);
const saving = ref(false);
const settingsSaving = ref(false);
const initializationError = ref("");
const entryValues = reactive<Record<string, string>>({});
const baselineValues = reactive<Record<string, string>>({});
const fieldDialogVisible = ref(false);
const selectedFieldDraft = ref<string[]>([]);
const pinnedFieldDraft = ref<string[]>([]);
const fieldWidthDraft = ref(QUICK_ENTRY_FIELD_WIDTH_DEFAULT);
const quickCreateFieldWidthDraft = ref(QUICK_ENTRY_FIELD_WIDTH_DEFAULT);
const draggingFieldId = ref("");
const dragOverFieldId = ref("");
const autoAdvanceDraft = ref(true);
const combinedPathologyInput = ref("");
const combinedPathologyInputRef = ref<{ focus: () => void } | null>(null);
const settingsDocument = ref<QuickEntrySettingsDocument>(normalizeQuickEntrySettings(null));
const fieldSettings = ref<QuickEntryProjectSettings>({
  selectedFieldIds: [],
  pinnedFieldIds: [],
  fieldWidth: QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
  quickCreateFieldWidth: QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
  autoAdvanceAfterUpdate: true,
});
const contextDefaults = new Map<string, QuickEntryFieldDefaults>();
let recordsLoadSequence = 0;
let refreshTimer: number | undefined;
let removeOpenRequestListener: (() => void) | undefined;
let removeFieldsChangedListener: (() => void) | undefined;
const pendingProjectRefreshIds = new Set<string>();
let projectRefreshPromise: Promise<void> | null = null;

function queryIdList(value: unknown): string[] {
  const joined = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  return [...new Set(joined.split(",").map((item) => item.trim()).filter(Boolean))];
}

const initialContext: QuickEntryOpenContext = {
  projectId: typeof route.query.project === "string" ? route.query.project : "",
  selectedFieldIds: queryIdList(route.query.fields),
  pinnedFieldIds: queryIdList(route.query.pinned),
};
if (initialContext.projectId) {
  contextDefaults.set(initialContext.projectId, {
    selectedFieldIds: initialContext.selectedFieldIds,
    pinnedFieldIds: initialContext.pinnedFieldIds,
  });
}

const currentProject = computed(() => appStore.projectById(activeProjectId.value));
const projectFields = computed(() =>
  (currentProject.value?.fields ?? []).slice().sort((left, right) => left.sort_order - right.sort_order),
);
const selectedFieldIdSet = computed(() => new Set(fieldSettings.value.selectedFieldIds));
const pinnedFieldIdSet = computed(() => new Set(fieldSettings.value.pinnedFieldIds));
const fieldById = computed(() => new Map(projectFields.value.map((field) => [field.id, field])));
const entryFields = computed(() =>
  fieldSettings.value.selectedFieldIds.flatMap((fieldId) => {
    const field = fieldById.value.get(fieldId);
    return field ? [field] : [];
  }),
);
const fieldDialogFields = computed(() => {
  const selected = selectedFieldDraft.value.flatMap((fieldId) => {
    const field = fieldById.value.get(fieldId);
    return field ? [field] : [];
  });
  const selectedSet = new Set(selectedFieldDraft.value);
  return [...selected, ...projectFields.value.filter((field) => !selectedSet.has(field.id))];
});
const filteredRecords = computed(() => {
  const term = recordSearch.value.trim().toLocaleLowerCase();
  if (!term) return unreportedRecords.value;
  return unreportedRecords.value.filter((record) =>
    record.pathology_number.toLocaleLowerCase().includes(term),
  );
});
const isLocked = computed(() => activeRecord.value?.locked === true);
const formReadonly = computed(
  () => saving.value || isLocked.value || activeRecordUnavailable.value,
);
const isDirty = computed(() =>
  (!activeRecord.value && Boolean(combinedPathologyInput.value.trim())) ||
  projectFields.value.some(
    (field) => (entryValues[field.id] ?? "") !== (baselineValues[field.id] ?? ""),
  ),
);

function replaceValues(target: Record<string, string>, values: Record<string, string>): void {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, values);
}

function focusPathology(): void {
  if (!activeRecord.value) {
    void nextTick(() => combinedPathologyInputRef.value?.focus());
    return;
  }
  const pathologyField = projectFields.value.find(
    (field) => field.system_key === "pathology_number",
  );
  if (!pathologyField) return;
  void nextTick(() => {
    const input = document.querySelector<HTMLElement>(
      `[data-entry-field="${pathologyField.id}"] input`,
    );
    input?.focus();
    input?.scrollIntoView({ block: "center" });
  });
}

async function scrollRecordIntoView(recordId: string): Promise<void> {
  await nextTick();
  const item = [...document.querySelectorAll<HTMLElement>(".record-list-item")]
    .find((element) => element.dataset.recordId === recordId);
  item?.scrollIntoView({ block: "nearest" });
}

function valuesForRecord(record: ProjectRecord): Record<string, string> {
  return Object.fromEntries(
    projectFields.value.map((field) => [field.id, quickEntryFieldValue(record, field)]),
  );
}

function loadRecordIntoForm(record: ProjectRecord): void {
  activeRecord.value = record;
  activeRecordUnavailable.value = record.report_generated;
  const values = valuesForRecord(record);
  replaceValues(entryValues, values);
  replaceValues(baselineValues, values);
}

function resetCreateForm(preservePinned = false): void {
  const previous = { ...entryValues };
  const values = Object.fromEntries(
    projectFields.value.map((field) => {
      const preserve =
        preservePinned &&
        pinnedFieldIdSet.value.has(field.id) &&
        field.system_key !== "pathology_number";
      return [
        field.id,
        preserve ? previous[field.id] ?? quickEntryDefaultValue(field) : quickEntryDefaultValue(field),
      ];
    }),
  );
  activeRecord.value = null;
  combinedPathologyInput.value = "";
  activeRecordUnavailable.value = false;
  replaceValues(entryValues, values);
  replaceValues(baselineValues, values);
  focusPathology();
}

function fieldOptions(field: FieldDefinition): string[] {
  if (field.system_key === "status") return ["待实验", "已完成"];
  return field.options
    .slice()
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((option) => option.value);
}

function setEntryValue(field: FieldDefinition, value: string): void {
  entryValues[field.id] = value;
}

async function confirmDiscardChanges(action: string): Promise<boolean> {
  if (!isDirty.value) return true;
  try {
    await ElMessageBox.confirm(
      `当前内容尚未保存，${action}会放弃这些修改。`,
      "放弃未保存内容？",
      {
        confirmButtonText: "放弃并继续",
        cancelButtonText: "继续编辑",
        type: "warning",
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function selectRecord(record: ProjectRecord): Promise<void> {
  if (saving.value) return;
  if (activeRecord.value?.id === record.id) {
    focusPathology();
    return;
  }
  if (!(await confirmDiscardChanges("切换病理号"))) return;
  loadRecordIntoForm(record);
  focusPathology();
}

async function startCreate(): Promise<void> {
  if (saving.value) return;
  if (!activeRecord.value && !isDirty.value) {
    focusPathology();
    return;
  }
  if (!(await confirmDiscardChanges("新建记录"))) return;
  resetCreateForm(false);
}

async function loadSettings(): Promise<void> {
  try {
    const result = await getSetting<unknown>(QUICK_ENTRY_SETTINGS_KEY);
    settingsDocument.value = normalizeQuickEntrySettings(result.value);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "快捷表头设置读取失败");
  }
}

function defaultsForProject(projectId: string): QuickEntryFieldDefaults {
  return contextDefaults.get(projectId) ?? {};
}

function resolveFieldSettings(projectId: string): QuickEntryProjectSettings {
  const project = appStore.projectById(projectId);
  return resolveQuickEntryProjectSettings(
    project?.fields ?? [],
    settingsDocument.value.projects[projectId],
    defaultsForProject(projectId),
  );
}

async function loadUnreportedRecords(projectId: string): Promise<void> {
  const sequence = ++recordsLoadSequence;
  recordsLoading.value = true;
  try {
    const items: ProjectRecord[] = [];
    let offset = 0;
    let total = 0;
    do {
      const page = await listRecords({
        project_id: projectId,
        report_generated: false,
        limit: 1000,
        offset,
      });
      if (sequence !== recordsLoadSequence || projectId !== activeProjectId.value) return;
      items.push(...page.items);
      total = page.total;
      offset += page.items.length;
      if (!page.items.length) break;
    } while (offset < total);

    const nextRecords = unreportedQuickEntryRecords([
      ...new Map(items.map((record) => [record.id, record])).values(),
    ]);
    unreportedRecords.value = nextRecords;
    const selected = activeRecord.value;
    if (!selected) return;
    const refreshed = nextRecords.find((record) => record.id === selected.id);
    if (refreshed) {
      activeRecordUnavailable.value = false;
      if (isDirty.value) activeRecord.value = refreshed;
      else loadRecordIntoForm(refreshed);
      return;
    }
    if (!isDirty.value) {
      resetCreateForm(false);
    } else if (!activeRecordUnavailable.value) {
      activeRecordUnavailable.value = true;
      ElMessage.warning("当前记录已生成报告并移出侧栏，未保存内容仍保留但不能再提交");
    }
  } catch (error) {
    if (sequence === recordsLoadSequence) {
      ElMessage.error(error instanceof Error ? error.message : "未生成报告记录读取失败");
    }
  } finally {
    if (sequence === recordsLoadSequence) recordsLoading.value = false;
  }
}

function reconcileValuesAfterFieldRefresh(previousFields: FieldDefinition[]): void {
  const nextFieldIds = new Set(projectFields.value.map((field) => field.id));
  const removedDirtyFields = previousFields.filter(
    (field) =>
      !nextFieldIds.has(field.id) &&
      (entryValues[field.id] ?? "") !== (baselineValues[field.id] ?? ""),
  );
  const previousValues = { ...entryValues };
  const previousBaselines = { ...baselineValues };
  const nextValues: Record<string, string> = {};
  const nextBaselines: Record<string, string> = {};
  projectFields.value.forEach((field) => {
    const fallback = activeRecord.value
      ? quickEntryFieldValue(activeRecord.value, field)
      : quickEntryDefaultValue(field);
    nextValues[field.id] = Object.hasOwn(previousValues, field.id)
      ? previousValues[field.id] ?? ""
      : fallback;
    nextBaselines[field.id] = Object.hasOwn(previousBaselines, field.id)
      ? previousBaselines[field.id] ?? ""
      : fallback;
  });
  replaceValues(entryValues, nextValues);
  replaceValues(baselineValues, nextBaselines);
  if (removedDirtyFields.length) {
    ElMessage.warning(
      `表头“${removedDirtyFields.map((field) => field.label).join("、")}”已被删除，其未保存内容无法继续提交`,
    );
  }
}

async function refreshProjectData(projectId: string): Promise<void> {
  if (!projectId) return;
  pendingProjectRefreshIds.add(projectId);
  if (projectRefreshPromise) {
    try {
      await projectRefreshPromise;
    } catch {
      // The owner of the shared refresh reports the error once.
    }
    return;
  }
  const refresh = (async () => {
    while (pendingProjectRefreshIds.size) {
      const requestedProjectIds = new Set(pendingProjectRefreshIds);
      pendingProjectRefreshIds.clear();
      const currentActiveProjectId = activeProjectId.value;
      const refreshActiveProject = requestedProjectIds.has(currentActiveProjectId);
      const previousFields = refreshActiveProject ? projectFields.value.slice() : [];
      await appStore.reloadProjects();
      if (!refreshActiveProject || currentActiveProjectId !== activeProjectId.value) continue;
      fieldSettings.value = resolveFieldSettings(currentActiveProjectId);
      reconcileValuesAfterFieldRefresh(previousFields);
      await loadUnreportedRecords(currentActiveProjectId);
    }
  })();
  projectRefreshPromise = refresh;
  try {
    await refresh;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "快速录入数据刷新失败");
  } finally {
    if (projectRefreshPromise === refresh) projectRefreshPromise = null;
  }
}

async function activateProject(
  projectId: string,
  defaults?: QuickEntryFieldDefaults,
): Promise<void> {
  if (defaults) contextDefaults.set(projectId, defaults);
  const project = appStore.projectById(projectId);
  if (!project) return;
  activeProjectId.value = projectId;
  recordSearch.value = "";
  unreportedRecords.value = [];
  fieldSettings.value = resolveFieldSettings(projectId);
  resetCreateForm(false);
  await router.replace({ name: "quick-entry", query: { project: projectId } });
  await loadUnreportedRecords(projectId);
}

async function handleProjectChange(projectId: string): Promise<void> {
  if (saving.value) return;
  if (projectId === activeProjectId.value) return;
  if (!(await confirmDiscardChanges("切换项目"))) return;
  await activateProject(projectId);
}

async function handleOpenRequest(context: QuickEntryOpenContext): Promise<void> {
  if (saving.value) {
    ElMessage.warning("当前记录正在保存，完成后可再次切换项目");
    return;
  }
  if (context.projectId && context.projectId !== activeProjectId.value && isDirty.value) {
    ElMessage.warning("当前快速录入有未保存内容，已保留原项目；保存或还原后可再切换");
    return;
  }
  if (context.projectId) {
    contextDefaults.set(context.projectId, {
      selectedFieldIds: context.selectedFieldIds,
      pinnedFieldIds: context.pinnedFieldIds,
    });
  }
  if (!context.projectId || context.projectId === activeProjectId.value) {
    if (activeProjectId.value) await refreshProjectData(activeProjectId.value);
    return;
  }
  await refreshProjectData(context.projectId);
  await activateProject(context.projectId, {
    selectedFieldIds: context.selectedFieldIds,
    pinnedFieldIds: context.pinnedFieldIds,
  });
}

function openFieldSettings(): void {
  if (saving.value || settingsSaving.value) return;
  selectedFieldDraft.value = [...fieldSettings.value.selectedFieldIds];
  pinnedFieldDraft.value = [...fieldSettings.value.pinnedFieldIds];
  fieldWidthDraft.value = fieldSettings.value.fieldWidth;
  quickCreateFieldWidthDraft.value = fieldSettings.value.quickCreateFieldWidth;
  autoAdvanceDraft.value = fieldSettings.value.autoAdvanceAfterUpdate;
  fieldDialogVisible.value = true;
}

function draftIncludes(collection: string[], fieldId: string): boolean {
  return collection.includes(fieldId);
}

function setDraftFieldSelected(field: FieldDefinition, selected: boolean): void {
  if (!selected && isMandatoryQuickEntryField(field)) return;
  if (selected && !selectedFieldDraft.value.includes(field.id)) {
    selectedFieldDraft.value = [...selectedFieldDraft.value, field.id];
  } else if (!selected) {
    selectedFieldDraft.value = selectedFieldDraft.value.filter((id) => id !== field.id);
  }
  if (!selected) pinnedFieldDraft.value = pinnedFieldDraft.value.filter((id) => id !== field.id);
}

function entryFieldStyle(): Record<string, string> {
  return {
    "--quick-field-width": `${fieldSettings.value.fieldWidth}px`,
  };
}

function quickCreateFieldStyle(): Record<string, string> {
  return {
    "--quick-create-field-width": `${fieldSettings.value.quickCreateFieldWidth}px`,
  };
}

function startFieldDrag(event: DragEvent, fieldId: string): void {
  if (!selectedFieldDraft.value.includes(fieldId)) return;
  draggingFieldId.value = fieldId;
  event.dataTransfer?.setData("text/plain", fieldId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function dragOverField(event: DragEvent, fieldId: string): void {
  if (!draggingFieldId.value || !selectedFieldDraft.value.includes(fieldId)) return;
  event.preventDefault();
  dragOverFieldId.value = fieldId;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function dropField(event: DragEvent, targetFieldId: string): void {
  event.preventDefault();
  const sourceFieldId = draggingFieldId.value || event.dataTransfer?.getData("text/plain") || "";
  if (!sourceFieldId || sourceFieldId === targetFieldId) {
    endFieldDrag();
    return;
  }
  const next = selectedFieldDraft.value.filter((fieldId) => fieldId !== sourceFieldId);
  const targetIndex = next.indexOf(targetFieldId);
  if (targetIndex >= 0) next.splice(targetIndex, 0, sourceFieldId);
  selectedFieldDraft.value = next;
  endFieldDrag();
}

function endFieldDrag(): void {
  draggingFieldId.value = "";
  dragOverFieldId.value = "";
}

function selectAllFields(): void {
  selectedFieldDraft.value = projectFields.value.map((field) => field.id);
}

function restoreRecommendedFields(): void {
  const recommended = resolveQuickEntryProjectSettings(
    projectFields.value,
    undefined,
    defaultsForProject(activeProjectId.value),
  );
  selectedFieldDraft.value = recommended.selectedFieldIds;
  pinnedFieldDraft.value = recommended.pinnedFieldIds;
}

async function saveFieldSettings(): Promise<void> {
  const projectId = activeProjectId.value;
  if (!projectId || saving.value || settingsSaving.value) return;
  const resolved = resolveQuickEntryProjectSettings(
    projectFields.value,
    {
      selectedFieldIds: selectedFieldDraft.value,
      pinnedFieldIds: pinnedFieldDraft.value,
      fieldWidth: fieldWidthDraft.value,
      quickCreateFieldWidth: quickCreateFieldWidthDraft.value,
      autoAdvanceAfterUpdate: autoAdvanceDraft.value,
    },
  );
  const nextSelected = new Set(resolved.selectedFieldIds);
  const removedDirtyFields = projectFields.value.filter(
    (field) =>
      selectedFieldIdSet.value.has(field.id) &&
      !nextSelected.has(field.id) &&
      (entryValues[field.id] ?? "") !== (baselineValues[field.id] ?? ""),
  );
  if (removedDirtyFields.length) {
    try {
      await ElMessageBox.confirm(
        `取消选择“${removedDirtyFields.map((field) => field.label).join("、")}”会放弃这些字段尚未保存的修改。`,
        "放弃未保存字段？",
        {
          confirmButtonText: "放弃并保存设置",
          cancelButtonText: "返回设置",
          type: "warning",
        },
      );
    } catch {
      return;
    }
  }
  const nextDocument: QuickEntrySettingsDocument = {
    version: 3,
    projects: {
      ...settingsDocument.value.projects,
      [projectId]: resolved,
    },
  };
  settingsSaving.value = true;
  try {
    const result = await putSetting(QUICK_ENTRY_SETTINGS_KEY, nextDocument);
    settingsDocument.value = normalizeQuickEntrySettings(result.value);
    fieldSettings.value = resolveFieldSettings(projectId);
    removedDirtyFields.forEach((field) => {
      entryValues[field.id] = baselineValues[field.id] ?? quickEntryDefaultValue(field);
    });
    fieldDialogVisible.value = false;
    ElMessage.success("快捷表头设置已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "快捷表头设置保存失败");
  } finally {
    settingsSaving.value = false;
  }
}

function issueSummary(issues: RecordValidationIssue[]): string {
  return [...new Set(issues.map((issue) => issue.message))].join("；");
}

async function confirmWarnings(issues: RecordValidationIssue[]): Promise<boolean> {
  if (!issues.length) return true;
  try {
    await ElMessageBox.confirm(issueSummary(issues), "字段校验警告", {
      confirmButtonText: "仍然保存",
      cancelButtonText: "返回修改",
      type: "warning",
    });
    return true;
  } catch {
    return false;
  }
}

async function notifyMain(recordId: string, action: "create" | "update"): Promise<void> {
  if (!bridge) return;
  try {
    await bridge.notifyQuickEntryChanged({ projectId: activeProjectId.value, recordId, action });
  } catch (error) {
    console.error("快速录入变更通知失败", error);
  }
}

async function saveNewRecord(): Promise<void> {
  const project = currentProject.value;
  if (!project) return;
  const parsed = parseCombinedPathologyNumber(combinedPathologyInput.value);
  combinedPathologyInput.value = parsed.normalized;
  const created = await quickCreateRecord(project.id, parsed.normalized);
  unreportedRecords.value = unreportedQuickEntryRecords([
    ...unreportedRecords.value,
    created,
  ]);
  recordSearch.value = "";
  await notifyMain(created.id, "create");
  resetCreateForm(false);
  await scrollRecordIntoView(created.id);
  ElMessage.success("记录已保存，可继续录入下一条");
}

async function saveExistingRecord(): Promise<void> {
  const record = activeRecord.value;
  if (!record) return;
  if (activeRecordUnavailable.value || record.report_generated) {
    ElMessage.warning("该记录已生成报告，不再允许从快速录入侧栏修改");
    return;
  }
  if (record.locked) {
    ElMessage.warning("该记录已锁定，不能修改");
    return;
  }
  const currentIndex = filteredRecords.value.findIndex((item) => item.id === record.id);
  const nextRecordId = currentIndex >= 0 ? filteredRecords.value[currentIndex + 1]?.id : undefined;
  const changes = buildQuickEntryChanges(
    record,
    projectFields.value,
    fieldSettings.value.selectedFieldIds,
    entryValues,
    baselineValues,
  );
  if (!changes.length) {
    ElMessage.info("没有需要保存的修改");
    return;
  }
  const preview = await previewCellBatch(record.project_id, changes);
  if (preview.skipped_locked) {
    ElMessage.warning("该记录刚刚被锁定，请刷新后重试");
    return;
  }
  const errors = preview.issues.filter((issue) => issue.severity === "error");
  const warnings = preview.issues.filter((issue) => issue.severity === "warning");
  if (errors.length) {
    await ElMessageBox.alert(issueSummary(errors), "无法保存", { type: "error" });
    return;
  }
  if (!(await confirmWarnings(warnings))) return;
  const result = await commitCellBatch(preview.token, warnings.length > 0);
  const updated = result.records.find((item) => item.id === record.id);
  if (updated) {
    unreportedRecords.value = unreportedQuickEntryRecords([
      ...unreportedRecords.value.filter((item) => item.id !== updated.id),
      updated,
    ]);
    if (activeRecord.value?.id === record.id) {
      loadRecordIntoForm(updated);
      if (updated.report_generated) activeRecordUnavailable.value = true;
    }
  } else {
    await loadUnreportedRecords(record.project_id);
  }
  await notifyMain(record.id, "update");
  ElMessage.success(`病理号 ${updated?.pathology_number ?? record.pathology_number} 已更新`);
  if (fieldSettings.value.autoAdvanceAfterUpdate && nextRecordId) {
    const nextRecord = unreportedRecords.value.find((item) => item.id === nextRecordId);
    if (nextRecord) {
      loadRecordIntoForm(nextRecord);
      await scrollRecordIntoView(nextRecord.id);
      focusPathology();
    }
  } else if (fieldSettings.value.autoAdvanceAfterUpdate && currentIndex >= 0) {
    ElMessage.info("已到最后一条记录");
  }
}

function handleCombinedPathologyKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.key !== "Enter") return;
  event.preventDefault();
  void saveEntry();
}

async function saveEntry(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    if (activeRecord.value) await saveExistingRecord();
    else await saveNewRecord();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "快速录入保存失败");
  } finally {
    saving.value = false;
  }
}

function restoreEntry(): void {
  if (activeRecord.value) replaceValues(entryValues, { ...baselineValues });
  else resetCreateForm(false);
}

function handleEntryKeydown(event: KeyboardEvent, field: FieldDefinition): void {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void saveEntry();
    return;
  }
  if (event.key !== "Enter" || event.shiftKey) return;
  if (field.data_type === "text" && !field.is_core) return;
  event.preventDefault();
  const index = entryFields.value.findIndex((item) => item.id === field.id);
  const nextField = entryFields.value[index + 1];
  if (!nextField) {
    void saveEntry();
    return;
  }
  document
    .querySelector<HTMLElement>(
      `[data-entry-field="${nextField.id}"] input, ` +
        `[data-entry-field="${nextField.id}"] textarea`,
    )
    ?.focus();
}

async function returnToMain(): Promise<void> {
  if (bridge?.windowKind === "quick-entry") {
    await bridge.focusMainWindow();
    return;
  }
  if (window.opener && !window.opener.closed) {
    window.opener.focus();
    window.close();
    return;
  }
  await router.push({ name: "ledger", query: { project: activeProjectId.value } });
}

async function initialize(): Promise<void> {
  try {
    await appStore.bootstrap();
    await loadSettings();
    const requestedProject = appStore.projects.some(
      (project) => project.id === initialContext.projectId,
    )
      ? initialContext.projectId
      : appStore.projects[0]?.id ?? "";
    if (!requestedProject) {
      initializationError.value = "当前没有可录入的项目";
      return;
    }
    await activateProject(requestedProject, contextDefaults.get(requestedProject));
  } catch (error) {
    initializationError.value = error instanceof Error ? error.message : "快速录入初始化失败";
  }
}

function refreshOnFocus(): void {
  if (activeProjectId.value) void refreshProjectData(activeProjectId.value);
}

function refreshRecordsPeriodically(): void {
  if (activeProjectId.value) void loadUnreportedRecords(activeProjectId.value);
}

onMounted(() => {
  if (bridge?.windowKind === "quick-entry") {
    removeOpenRequestListener = bridge.onQuickEntryOpenRequested((context) => {
      void handleOpenRequest(context);
    });
    removeFieldsChangedListener = bridge.onQuickEntryFieldsChanged((payload) => {
      void refreshProjectData(payload.projectId);
    });
  }
  window.addEventListener("focus", refreshOnFocus);
  refreshTimer = window.setInterval(refreshRecordsPeriodically, 30_000);
  void initialize().finally(() => {
    if (bridge?.windowKind === "quick-entry") {
      void bridge.quickEntryReady().catch((error) => {
        console.error("快速录入窗口就绪通知失败", error);
      });
    }
  });
});

onBeforeUnmount(() => {
  recordsLoadSequence += 1;
  removeOpenRequestListener?.();
  removeOpenRequestListener = undefined;
  removeFieldsChangedListener?.();
  removeFieldsChangedListener = undefined;
  window.removeEventListener("focus", refreshOnFocus);
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="quick-entry-page">
    <header class="quick-entry-header">
      <div class="quick-entry-brand">
        <Dna :stroke-width="1.7" aria-hidden="true" />
        <div>
          <strong>快速录入</strong>
          <span>独立置顶窗口</span>
        </div>
      </div>

      <el-select
        class="project-select"
        :model-value="activeProjectId"
        :disabled="saving"
        placeholder="选择项目"
        @change="handleProjectChange(String($event))"
      >
        <el-option
          v-for="project in appStore.projects"
          :key="project.id"
          :label="project.name"
          :value="project.id"
        />
      </el-select>

      <div class="quick-entry-header-actions">
        <span v-if="bridge?.windowKind === 'quick-entry'" class="always-on-top-badge">
          <span aria-hidden="true" /> 始终置顶
        </span>
        <el-button :icon="ArrowLeft" @click="returnToMain">返回主程序</el-button>
      </div>
    </header>

    <div v-if="initializationError" class="quick-entry-error">
      <el-empty :description="initializationError" />
    </div>

    <main v-else class="quick-entry-layout">
      <aside class="record-pane">
        <div class="record-pane-header">
          <div>
            <h2>未生成报告</h2>
            <p>{{ unreportedRecords.length }} 条记录</p>
          </div>
          <el-button
            text
            circle
            :icon="Refresh"
            :loading="recordsLoading"
            aria-label="刷新病理号列表"
            title="刷新"
            @click="loadUnreportedRecords(activeProjectId)"
          />
        </div>
        <el-input
          v-model="recordSearch"
          class="record-search"
          clearable
          :prefix-icon="Search"
          placeholder="搜索病理号"
        />
        <p class="record-pane-note">已生成报告的记录不会出现在这里。</p>

        <el-scrollbar v-loading="recordsLoading" class="record-list">
          <button
            v-for="record in filteredRecords"
            :key="record.id"
            type="button"
            class="record-list-item"
            :data-record-id="record.id"
            :class="{ active: activeRecord?.id === record.id }"
            :disabled="saving"
            @click="selectRecord(record)"
          >
            <span class="record-pathology">{{ record.pathology_number }}</span>
            <span class="record-meta">
              {{ record.experiment_date || '未填日期' }}
              <el-icon v-if="record.locked" title="记录已锁定"><Lock /></el-icon>
            </span>
          </button>
          <div v-if="!recordsLoading && !filteredRecords.length" class="record-list-empty">
            {{ recordSearch ? '没有匹配的病理号' : '暂无未生成报告记录' }}
          </div>
        </el-scrollbar>
      </aside>

      <section class="entry-pane">
        <div class="entry-pane-header">
          <div class="entry-heading">
            <div class="entry-title-row">
              <h1>{{ activeRecord ? activeRecord.pathology_number : '新增记录' }}</h1>
              <el-tag v-if="activeRecord" type="warning" effect="plain">
                <el-icon><EditPen /></el-icon> 快速修改
              </el-tag>
              <el-tag v-else type="success" effect="plain">
                <el-icon><Plus /></el-icon> 连续录入
              </el-tag>
              <el-tag v-if="isLocked" type="danger" effect="plain">已锁定</el-tag>
              <el-tag v-if="isDirty" type="info" effect="plain">未保存</el-tag>
            </div>
            <p>
              {{ activeRecord ? '只保存下方已选择表头的改动，成功后自动进入下一条。' : '输入“病理号-蜡块号”，按 Enter 即可连续创建。' }}
            </p>
          </div>
          <div class="entry-toolbar">
            <el-button :icon="Setting" :disabled="saving" @click="openFieldSettings">
              快捷表头与尺寸（{{ entryFields.length }}）
            </el-button>
            <el-button :icon="Plus" type="primary" plain :disabled="saving" @click="startCreate">
              新增记录
            </el-button>
          </div>
        </div>

        <el-alert
          v-if="activeRecordUnavailable"
          class="locked-alert"
          type="error"
          title="该记录已生成报告并移出病理号侧栏，当前内容仅保留供查看，不能再提交。"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="isLocked"
          class="locked-alert"
          type="warning"
          title="该记录已锁定，只能查看，不能快速修改。"
          :closable="false"
          show-icon
        />

        <el-scrollbar class="entry-form-scroll">
          <el-form
            v-if="activeRecord"
            class="entry-form"
            label-position="top"
            size="small"
            @submit.prevent
          >
            <el-form-item
              v-for="field in entryFields"
              :key="field.id"
              :style="entryFieldStyle()"
            >
              <template #label>
                <span class="entry-field-label">
                  <span>{{ field.label }}</span>
                  <span v-if="isMandatoryQuickEntryField(field)" class="required-mark">必填</span>
                  <span
                    v-if="!activeRecord && pinnedFieldIdSet.has(field.id)"
                    class="pinned-mark"
                  >
                    连续保留
                  </span>
                </span>
              </template>
              <div class="entry-field" :data-entry-field="field.id">
                <EditableDateInput
                  v-if="field.data_type === 'date' || field.system_key === 'experiment_date'"
                  :model-value="entryValues[field.id] ?? ''"
                  :readonly="formReadonly"
                  @update:model-value="setEntryValue(field, $event)"
                  @keydown="handleEntryKeydown($event, field)"
                />
                <EditableChoiceInput
                  v-else-if="field.data_type === 'select' || field.options.length || field.system_key === 'status'"
                  :model-value="entryValues[field.id] ?? ''"
                  :options="fieldOptions(field)"
                  :readonly="formReadonly"
                  @update:model-value="setEntryValue(field, $event)"
                  @keydown="handleEntryKeydown($event, field)"
                />
                <el-input
                  v-else
                  :model-value="entryValues[field.id] ?? ''"
                  :readonly="formReadonly"
                  :type="field.is_core ? 'text' : 'textarea'"
                  :autosize="field.is_core ? undefined : { minRows: 1, maxRows: 4 }"
                  @update:model-value="setEntryValue(field, String($event))"
                  @keydown="handleEntryKeydown($event, field)"
                />
              </div>
            </el-form-item>
          </el-form>
          <div v-else class="quick-create-form" :style="quickCreateFieldStyle()">
            <label for="combined-pathology-number">病理号-蜡块号</label>
            <el-input
              id="combined-pathology-number"
              ref="combinedPathologyInputRef"
              v-model="combinedPathologyInput"
              size="large"
              clearable
              autofocus
              placeholder="例如 A-20260907-3"
              @keydown="handleCombinedPathologyKeydown"
            />
            <p>系统会按最后一个连接符拆分；前半部分写入病理号，最后一段写入蜡块号。</p>
          </div>
        </el-scrollbar>

        <footer class="entry-footer">
          <span>Ctrl+Enter 快速保存</span>
          <div>
            <el-button :disabled="formReadonly" @click="restoreEntry">
              {{ activeRecord ? '还原修改' : '清空' }}
            </el-button>
            <el-button
              type="primary"
              :loading="saving"
              :disabled="isLocked || activeRecordUnavailable"
              @click="saveEntry"
            >
              {{ activeRecord ? '保存修改（Ctrl+Enter）' : '创建并继续（Enter）' }}
            </el-button>
          </div>
        </footer>
      </section>
    </main>

    <el-dialog
      v-model="fieldDialogVisible"
      title="快捷表头、顺序与输入框宽度"
      width="min(820px, 94vw)"
      append-to-body
      destroy-on-close
    >
      <p class="field-dialog-note">
        “快捷录入”决定修改表单中显示哪些表头；修改记录与新增记录的输入框宽度可分别设置。
      </p>
      <div class="field-dialog-toolbar">
        <el-button size="small" @click="selectAllFields">全部选择</el-button>
        <el-button size="small" @click="restoreRecommendedFields">恢复项目推荐</el-button>
        <el-checkbox v-model="autoAdvanceDraft">修改后自动进入下一条</el-checkbox>
        <span class="unified-size-controls">
          <b>修改记录输入框宽度</b>
          <el-input-number
            v-model="fieldWidthDraft"
            :min="QUICK_ENTRY_FIELD_WIDTH_MIN"
            :max="QUICK_ENTRY_FIELD_WIDTH_MAX"
            :step="10"
            size="small"
            controls-position="right"
            aria-label="修改记录输入框宽度"
          />
          <span>px</span>
        </span>
        <span class="unified-size-controls">
          <b>新增记录输入框宽度</b>
          <el-input-number
            v-model="quickCreateFieldWidthDraft"
            :min="QUICK_ENTRY_FIELD_WIDTH_MIN"
            :max="QUICK_ENTRY_FIELD_WIDTH_MAX"
            :step="10"
            size="small"
            controls-position="right"
            aria-label="新增记录输入框宽度"
          />
          <span>px</span>
        </span>
      </div>
      <div class="field-selector">
        <div class="field-selector-head">
          <span>表头与顺序</span>
          <span>快捷录入</span>
        </div>
        <div
          v-for="field in fieldDialogFields"
          :key="field.id"
          class="field-selector-row"
          :class="{
            'is-dragging': draggingFieldId === field.id,
            'is-drag-over': dragOverFieldId === field.id,
          }"
          @dragover="dragOverField($event, field.id)"
          @drop="dropField($event, field.id)"
        >
          <span class="field-selector-name">
            <span
              v-if="draftIncludes(selectedFieldDraft, field.id)"
              class="field-drag-handle"
              draggable="true"
              title="拖动调整顺序"
              aria-label="拖动调整表头顺序"
              @dragstart="startFieldDrag($event, field.id)"
              @dragend="endFieldDrag"
            ><GripVertical :size="16" /></span>
            {{ field.label }}
            <small v-if="isMandatoryQuickEntryField(field)">必选</small>
          </span>
          <el-checkbox
            :model-value="draftIncludes(selectedFieldDraft, field.id)"
            :disabled="isMandatoryQuickEntryField(field)"
            aria-label="用于快捷录入"
            @change="setDraftFieldSelected(field, Boolean($event))"
          />
        </div>
      </div>
      <template #footer>
        <el-button @click="fieldDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="settingsSaving" @click="saveFieldSettings">
          保存设置
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.quick-entry-page {
  display: flex;
  height: 100vh;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--app-bg);
  color: var(--app-text);
}

.quick-entry-header {
  display: flex;
  min-height: 64px;
  flex: 0 0 auto;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-bg);
  padding: 10px 14px;
  box-shadow: 0 1px 3px rgb(16 24 40 / 5%);
}

.quick-entry-brand {
  display: flex;
  min-width: 170px;
  align-items: center;
  gap: 9px;
}

.quick-entry-brand svg {
  padding: 7px;
  color: var(--app-primary-text);
  background: var(--app-primary-soft);
  border: 1px solid var(--app-primary-border);
  border-radius: 11px;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
}

.quick-entry-brand div {
  display: grid;
  gap: 1px;
}

.quick-entry-brand strong {
  font-size: 15px;
}

.quick-entry-brand span {
  color: var(--app-muted);
  font-size: 11px;
}

.project-select {
  width: min(240px, 28vw);
}

.quick-entry-header-actions {
  display: flex;
  margin-left: auto;
  align-items: center;
  gap: 10px;
}

.always-on-top-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--app-primary-text);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.always-on-top-badge > span {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--app-primary);
  box-shadow: 0 0 0 4px var(--app-primary-soft);
}

.quick-entry-error {
  display: grid;
  flex: 1;
  place-items: center;
}

.quick-entry-layout {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(100px, 110px) minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
}

.record-pane,
.entry-pane {
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-bg);
  box-shadow: 0 1px 3px rgb(16 24 40 / 4%);
}

.record-pane {
  display: flex;
  flex-direction: column;
}

.record-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 6px 7px;
}

.record-pane-header h2 {
  margin: 0;
  font-size: 12px;
}

.record-pane-header p {
  display: none;
}

.record-search {
  padding: 0 5px;
}

.record-pane-note {
  display: none;
}

.record-list {
  min-height: 0;
  flex: 1;
  border-top: 1px solid var(--app-border-light);
}

.record-list :deep(.el-scrollbar__view) {
  display: grid;
  align-content: start;
  padding: 6px;
}

.record-list-item {
  display: grid;
  width: 100%;
  gap: 3px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 7px 5px;
  text-align: left;
}

.record-list-item:hover {
  background: var(--app-hover);
}

.record-list-item:disabled {
  cursor: wait;
  opacity: 0.65;
}

.record-list-item:disabled:hover {
  background: transparent;
}

.record-list-item.active {
  background: var(--app-primary-soft);
  color: var(--app-primary-text);
  box-shadow: inset 3px 0 var(--app-primary);
}

.record-pathology {
  overflow: hidden;
  font-size: 11px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-meta {
  display: block;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-meta .el-icon {
  color: var(--app-danger);
}

.record-list-empty {
  padding: 28px 10px;
  color: var(--app-subtle);
  font-size: 12px;
  text-align: center;
}

.entry-pane {
  display: flex;
  flex-direction: column;
  container: quick-entry-form / inline-size;
}

.entry-pane-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid var(--app-border-light);
  padding: 14px 16px 12px;
}

.entry-heading {
  min-width: 0;
}

.entry-title-row {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.entry-title-row h1 {
  max-width: min(360px, 45vw);
  overflow: hidden;
  margin: 0;
  font-size: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-title-row .el-tag {
  gap: 3px;
}

.entry-heading p {
  margin: 5px 0 0;
  color: var(--app-muted);
  font-size: 11px;
}

.entry-toolbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}

.entry-toolbar .el-button + .el-button {
  margin-left: 0;
}

.locked-alert {
  margin: 10px 14px 0;
  width: auto;
}

.entry-form-scroll {
  min-height: 0;
  flex: 1;
}

.entry-form {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  max-width: 560px;
  flex-wrap: wrap;
  align-items: start;
  gap: 10px 16px;
  margin-inline: auto;
  padding: 12px 16px 20px;
}

.entry-form :deep(.el-form-item) {
  width: min(var(--quick-field-width, 320px), 100%);
  flex: 0 0 min(var(--quick-field-width, 320px), 100%);
  min-width: 0;
  margin-bottom: 0;
}

.entry-form :deep(.el-form-item__label) {
  height: auto;
  min-width: 0;
  padding-bottom: 4px;
  line-height: 18px;
}

.entry-field-label {
  display: inline-flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 6px;
  color: var(--app-text);
  font-weight: 600;
  line-height: 18px;
}

.required-mark,
.pinned-mark {
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 500;
}

.required-mark {
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.pinned-mark {
  background: var(--app-primary-soft);
  color: var(--app-primary-text);
}

.entry-field {
  width: 100%;
  min-width: 0;
}

.entry-field :deep(.el-input),
.entry-field :deep(.el-textarea),
.entry-field :deep(.el-select),
.entry-field :deep(.el-autocomplete),
.entry-field :deep(.editable-date-input) {
  width: 100%;
  min-width: 0;
}

.quick-create-form {
  width: min(var(--quick-create-field-width, 320px), calc(100% - 32px));
  margin: 56px auto;
}

.quick-create-form label {
  display: block;
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: 700;
}

.quick-create-form p {
  margin: 10px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.entry-footer {
  display: flex;
  min-height: 58px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--app-border);
  background: var(--app-bg);
  padding: 10px 14px;
}

.entry-footer > span {
  color: var(--app-subtle);
  font-size: 11px;
}

.entry-footer > div {
  display: flex;
  gap: 8px;
}

.entry-footer .el-button + .el-button {
  margin-left: 0;
}

.field-dialog-note {
  margin: -2px 0 12px;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.field-dialog-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
}

.field-dialog-toolbar .el-button + .el-button {
  margin-left: 0;
}

.field-selector {
  max-height: min(520px, 60vh);
  overflow: auto;
  border: 1px solid var(--app-border);
  border-radius: 9px;
}

.field-selector-head,
.field-selector-row {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) 78px;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 6px 12px;
}

.field-selector-head {
  position: sticky;
  z-index: 1;
  top: 0;
  background: var(--app-surface-soft);
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 700;
}

.field-selector-head span:not(:first-child),
.field-selector-row > :not(:first-child) {
  justify-self: center;
}

.field-selector-row {
  border-top: 1px solid var(--app-border-light);
  transition: background-color 120ms ease, box-shadow 120ms ease;
}

.field-selector-row.is-dragging {
  opacity: 0.45;
}

.field-selector-row.is-drag-over {
  background: var(--app-primary-soft);
  box-shadow: inset 0 2px var(--app-primary);
}

.field-selector-name {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field-selector-name small {
  margin-left: 5px;
  color: var(--app-danger);
  font-size: 10px;
}

.field-drag-handle {
  display: inline-flex;
  align-items: center;
  color: var(--app-muted);
  cursor: grab;
  margin-right: 4px;
  vertical-align: middle;
}

.field-drag-handle:active {
  cursor: grabbing;
}

.unified-size-controls {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  color: var(--app-muted);
  font-size: 12px;
}

.unified-size-controls :deep(.el-input-number) {
  width: 125px;
}

@media (max-width: 820px) {
  .quick-entry-header {
    gap: 9px;
    padding-inline: 10px;
  }

  .quick-entry-brand {
    min-width: 142px;
  }

  .quick-entry-brand span,
  .always-on-top-badge {
    display: none;
  }

  .quick-entry-layout {
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 8px;
    padding: 8px;
  }

  .entry-pane-header {
    display: grid;
  }

  .entry-toolbar {
    justify-content: flex-start;
  }

  .entry-footer > span {
    display: none;
  }

  .entry-footer {
    justify-content: flex-end;
  }
}

@media (max-height: 560px) {
  .quick-entry-header {
    min-height: 54px;
    padding-block: 7px;
  }

  .quick-entry-brand svg {
    width: 30px;
    height: 30px;
    flex-basis: 30px;
  }

  .entry-form {
    gap: 8px 14px;
    padding-block: 8px 14px;
  }
}
.record-pane, .entry-pane { border-color: var(--app-border); box-shadow: 0 4px 20px rgb(30 41 59 / 3%); }
.record-pane-header { background: var(--app-surface-soft); }
.record-pane-header p, .record-pane-note, .record-meta, .entry-heading p,
.entry-footer > span, .quick-entry-brand span, .field-selector-head,
.required-mark, .pinned-mark, .field-selector-name small { font-size: 12px; }
.record-pane-note, .record-meta, .entry-footer > span, .record-list-empty { color: var(--app-muted); }
.entry-pane-header { background: linear-gradient(110deg, var(--app-bg), var(--app-surface-soft)); }
.entry-field-label { color: var(--app-text); }
@media (max-width: 640px) {
  .quick-entry-header { flex-wrap: wrap; }
  .project-select { order: 3; width: 100%; }
  .quick-entry-layout { grid-template-columns: 100px minmax(0, 1fr); }
  .entry-title-row h1 { max-width: 80vw; }
  .field-selector-head, .field-selector-row { grid-template-columns: minmax(120px, 1fr) 64px; }
}
</style>
