<script setup lang="ts">
import {
  ArrowLeft,
  Dna,
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
  createRecord,
  listRecords,
  previewCellBatch,
  validateNewRecord,
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
  buildQuickEntryChanges,
  buildQuickEntryCreatePayload,
  isMandatoryQuickEntryField,
  normalizeQuickEntrySettings,
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
const settingsDocument = ref<QuickEntrySettingsDocument>(normalizeQuickEntrySettings(null));
const fieldSettings = ref<QuickEntryProjectSettings>({
  selectedFieldIds: [],
  pinnedFieldIds: [],
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
const entryFields = computed(() =>
  projectFields.value.filter((field) => selectedFieldIdSet.value.has(field.id)),
);
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
  projectFields.value.some(
    (field) => (entryValues[field.id] ?? "") !== (baselineValues[field.id] ?? ""),
  ),
);

function replaceValues(target: Record<string, string>, values: Record<string, string>): void {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, values);
}

function focusPathology(): void {
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
  fieldDialogVisible.value = true;
}

function draftIncludes(collection: string[], fieldId: string): boolean {
  return collection.includes(fieldId);
}

function setDraftFieldSelected(field: FieldDefinition, selected: boolean): void {
  if (!selected && isMandatoryQuickEntryField(field)) return;
  const next = new Set(selectedFieldDraft.value);
  if (selected) next.add(field.id);
  else next.delete(field.id);
  selectedFieldDraft.value = projectFields.value
    .filter((item) => next.has(item.id))
    .map((item) => item.id);
  if (!selected) pinnedFieldDraft.value = pinnedFieldDraft.value.filter((id) => id !== field.id);
}

function setDraftFieldPinned(field: FieldDefinition, pinned: boolean): void {
  if (field.system_key === "pathology_number" || !selectedFieldDraft.value.includes(field.id)) return;
  const next = new Set(pinnedFieldDraft.value);
  if (pinned) next.add(field.id);
  else next.delete(field.id);
  pinnedFieldDraft.value = projectFields.value
    .filter((item) => next.has(item.id))
    .map((item) => item.id);
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
    version: 1,
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

function notifyMain(recordId: string, action: "create" | "update"): void {
  if (!bridge) return;
  void bridge
    .notifyQuickEntryChanged({ projectId: activeProjectId.value, recordId, action })
    .catch((error) => console.error("快速录入变更通知失败", error));
}

async function saveNewRecord(): Promise<void> {
  const project = currentProject.value;
  if (!project) return;
  const payload = buildQuickEntryCreatePayload(
    project.id,
    projectFields.value,
    fieldSettings.value.selectedFieldIds,
    entryValues,
  );
  const validation = await validateNewRecord(payload);
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  const warnings = validation.issues.filter((issue) => issue.severity === "warning");
  if (errors.length) {
    await ElMessageBox.alert(issueSummary(errors), "无法保存", { type: "error" });
    return;
  }
  if (!(await confirmWarnings(warnings))) return;
  const created = await createRecord(payload);
  unreportedRecords.value = unreportedQuickEntryRecords([
    ...unreportedRecords.value,
    created,
  ]);
  recordSearch.value = "";
  notifyMain(created.id, "create");
  resetCreateForm(true);
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
  notifyMain(record.id, "update");
  ElMessage.success(`病理号 ${updated?.pathology_number ?? record.pathology_number} 已更新`);
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
              {{ activeRecord ? '只保存下方已选择表头的改动。' : '保存后保留标记为“连续保留”的内容。' }}
            </p>
          </div>
          <div class="entry-toolbar">
            <el-button :icon="Setting" :disabled="saving" @click="openFieldSettings">
              选择快捷表头（{{ entryFields.length }}）
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
          <el-form class="entry-form" label-position="top" size="small">
            <el-form-item v-for="field in entryFields" :key="field.id">
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
              {{ activeRecord ? '保存修改（Ctrl+Enter）' : '保存并下一条（Ctrl+Enter）' }}
            </el-button>
          </div>
        </footer>
      </section>
    </main>

    <el-dialog
      v-model="fieldDialogVisible"
      title="选择快捷表头"
      width="640px"
      append-to-body
      destroy-on-close
    >
      <p class="field-dialog-note">
        “快捷录入”决定表单中显示哪些表头；“连续保留”仅用于新增记录，病理号每次都会清空。
      </p>
      <div class="field-dialog-toolbar">
        <el-button size="small" @click="selectAllFields">全部选择</el-button>
        <el-button size="small" @click="restoreRecommendedFields">恢复项目推荐</el-button>
      </div>
      <div class="field-selector">
        <div class="field-selector-head">
          <span>表头</span>
          <span>快捷录入</span>
          <span>连续保留</span>
        </div>
        <div v-for="field in projectFields" :key="field.id" class="field-selector-row">
          <span class="field-selector-name">
            {{ field.label }}
            <small v-if="isMandatoryQuickEntryField(field)">必选</small>
          </span>
          <el-checkbox
            :model-value="draftIncludes(selectedFieldDraft, field.id)"
            :disabled="isMandatoryQuickEntryField(field)"
            aria-label="用于快捷录入"
            @change="setDraftFieldSelected(field, Boolean($event))"
          />
          <el-checkbox
            :model-value="draftIncludes(pinnedFieldDraft, field.id)"
            :disabled="field.system_key === 'pathology_number' || !draftIncludes(selectedFieldDraft, field.id)"
            aria-label="新增后连续保留"
            @change="setDraftFieldPinned(field, Boolean($event))"
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
  grid-template-columns: minmax(210px, 27%) minmax(0, 1fr);
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
  padding: 14px 14px 8px;
}

.record-pane-header h2 {
  margin: 0;
  font-size: 14px;
}

.record-pane-header p {
  margin: 3px 0 0;
  color: var(--app-muted);
  font-size: 11px;
}

.record-search {
  padding: 0 12px;
}

.record-pane-note {
  margin: 7px 13px 9px;
  color: var(--app-subtle);
  font-size: 10px;
  line-height: 1.4;
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
  padding: 9px 10px;
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
  font-size: 13px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--app-muted);
  font-size: 10px;
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
  display: grid;
  width: 100%;
  max-width: 920px;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 10px 16px;
  margin-inline: auto;
  padding: 12px 16px 20px;
}

.entry-form :deep(.el-form-item) {
  width: 100%;
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
  grid-template-columns: minmax(0, 1fr) 100px 100px;
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

@container quick-entry-form (min-width: 620px) {
  .entry-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
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
    grid-template-columns: 190px minmax(0, 1fr);
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
  .quick-entry-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: 200px minmax(380px, 1fr); overflow-y: auto; }
  .entry-title-row h1 { max-width: 80vw; }
  .field-selector-head, .field-selector-row { grid-template-columns: minmax(0, 1fr) 64px 64px; }
}
</style>
