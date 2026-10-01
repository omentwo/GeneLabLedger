<script setup lang="ts">
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Dna,
  GripVertical,
  Info,
  Pencil as EditPen,
  Lock,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw as Refresh,
  Search,
  Settings2 as Setting,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  commitCellBatch,
  listRecords,
  previewCellBatch,
  quickCreateRecord,
  validateNewRecord,
} from "@/api/records";
import { getSetting, putSetting } from "@/api/system";
import EditableChoiceInput from "@/components/EditableChoiceInput.vue";
import EditableDateInput from "@/components/EditableDateInput.vue";
import { useAppStore } from "@/stores/app";
import type { FieldDefinition, ProjectRecord, RecordValidationIssue } from "@/types/api";
import type { ClipboardFollowEvent, QuickEntryOpenContext } from "@/types/electron";
import { ClipboardFollowSession } from "@/utils/clipboardFollow";
import { desktopBridge } from "@/utils/desktop";
import { fieldDropTargetIndex, moveArrayItem } from "@/utils/fieldOrder";
import { gridAutoScrollVector, nextGridScrollOffset } from "@/utils/gridAutoScroll";
import {
  QUICK_ENTRY_SETTINGS_KEY,
  QUICK_ENTRY_CREATE_FIELD_WIDTH_DEFAULT,
  QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
  QUICK_ENTRY_FIELD_WIDTH_MAX,
  QUICK_ENTRY_FIELD_WIDTH_MIN,
  QUICK_ENTRY_FONT_SIZE_DEFAULT,
  QUICK_ENTRY_FONT_SIZE_MAX,
  QUICK_ENTRY_FONT_SIZE_MIN,
  QUICK_ENTRY_INPUT_HEIGHT_DEFAULT,
  QUICK_ENTRY_INPUT_HEIGHT_MAX,
  QUICK_ENTRY_INPUT_HEIGHT_MIN,
  buildQuickEntryChanges,
  isMandatoryQuickEntryField,
  isClipboardEntryField,
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
import { buildValidationPromptCopy } from "@/utils/validationPrompt";

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
const recordPaneCollapsed = ref(false);
const focusMode = ref(false);
const initializing = ref(false);
const saving = ref(false);
const settingsSaving = ref(false);
const initializationError = ref("");
const entryValues = reactive<Record<string, string>>({});
const baselineValues = reactive<Record<string, string>>({});
const fieldDialogVisible = ref(false);
const selectedFieldDraft = ref<string[]>([]);
const pinnedFieldDraft = ref<string[]>([]);
const fieldWidthDraft = ref(QUICK_ENTRY_FIELD_WIDTH_DEFAULT);
const quickCreateFieldWidthDraft = ref(QUICK_ENTRY_CREATE_FIELD_WIDTH_DEFAULT);
const fontSizeDraft = ref(QUICK_ENTRY_FONT_SIZE_DEFAULT);
const inputHeightDraft = ref(QUICK_ENTRY_INPUT_HEIGHT_DEFAULT);
const draggingFieldId = ref("");
const dragOverFieldId = ref("");
const dragFieldInsertAfter = ref(false);
const autoAdvanceDraft = ref(true);
const clipboardFieldDraft = ref<string[]>([]);
const clipboardEnabledDraft = ref(false);
const clipboardOverwriteDraft = ref(false);
const clipboardAutoContinueDraft = ref(false);
const draggingClipboardFieldId = ref("");
const dragOverClipboardFieldId = ref("");
const dragClipboardInsertAfter = ref(false);
const clipboardEnabled = ref(false);
const clipboardBusy = ref(false);
const clipboardSession = reactive(new ClipboardFollowSession());
const clipboardAvailable = Boolean(bridge?.windowKind === "quick-entry" && bridge.clipboardFollowAvailable);
const combinedPathologyInput = ref("");
const combinedPathologyInputRef = ref<{ focus: () => void } | null>(null);
const settingsDocument = ref<QuickEntrySettingsDocument>(normalizeQuickEntrySettings(null));
const fieldSettings = ref<QuickEntryProjectSettings>({
  selectedFieldIds: [],
  pinnedFieldIds: [],
  fieldWidth: QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
  quickCreateFieldWidth: QUICK_ENTRY_CREATE_FIELD_WIDTH_DEFAULT,
  fontSize: QUICK_ENTRY_FONT_SIZE_DEFAULT,
  inputHeight: QUICK_ENTRY_INPUT_HEIGHT_DEFAULT,
  autoAdvanceAfterUpdate: true,
  clipboardFieldIds: [],
  clipboardEnabled: false,
  clipboardOverwriteExisting: false,
  clipboardAutoContinue: false,
});
const contextDefaults = new Map<string, QuickEntryFieldDefaults>();
let recordsLoadSequence = 0;
let refreshTimer: number | undefined;
let removeOpenRequestListener: (() => void) | undefined;
let removeFieldsChangedListener: (() => void) | undefined;
let removeClipboardListener: (() => void) | undefined;
let nativeUndoShortcutTarget: HTMLElement | null = null;
const pendingProjectRefreshIds = new Set<string>();
let projectRefreshPromise: Promise<void> | null = null;
const QUICK_ENTRY_RECORD_PANE_STORAGE_KEY = "gene-lab-ledger.quick-entry-record-pane-collapsed";
const QUICK_ENTRY_FOCUS_MODE_STORAGE_KEY = "gene-lab-ledger.quick-entry-focus-mode";

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
function clipboardFieldSequence(fieldId: string): string {
  if (!clipboardEnabled.value) return "";
  const index = fieldSettings.value.clipboardFieldIds.indexOf(fieldId);
  return index >= 0 ? `(${index + 1}/${fieldSettings.value.clipboardFieldIds.length})` : "";
}
const clipboardNextField = computed(() => fieldById.value.get(clipboardSession.nextFieldId));
const clipboardDialogFields = computed(() => {
  const eligible = selectedFieldDraft.value.flatMap((id) => {
    const field = fieldById.value.get(id);
    return field && isClipboardEntryField(field) ? [field] : [];
  });
  const selected = new Set(clipboardFieldDraft.value);
  return [
    ...clipboardFieldDraft.value.flatMap((id) => eligible.filter((field) => field.id === id)),
    ...eligible.filter((field) => !selected.has(field.id)),
  ];
});
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
const effectiveRecordPaneCollapsed = computed(() => recordPaneCollapsed.value || focusMode.value);
const entryGuidance = computed(() => {
  if (activeRecord.value && clipboardEnabled.value) {
    return "确认本条后，在其他软件逐项复制；自动填入草稿，检查后保存。";
  }
  if (activeRecord.value) return "只保存下方已选择表头的改动，成功后自动进入下一条。";
  return "输入“病理号-蜡块号”，按 Enter 即可连续创建。";
});

function restoreLayoutPreferences(): void {
  try {
    recordPaneCollapsed.value = window.localStorage.getItem(QUICK_ENTRY_RECORD_PANE_STORAGE_KEY) === "true";
    focusMode.value = window.localStorage.getItem(QUICK_ENTRY_FOCUS_MODE_STORAGE_KEY) === "true";
  } catch {
    // localStorage may be unavailable in restricted desktop environments.
  }
}

function persistLayoutPreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Layout preferences are optional; the current session can continue without persistence.
  }
}

function toggleRecordPane(): void {
  recordPaneCollapsed.value = !recordPaneCollapsed.value;
  persistLayoutPreference(QUICK_ENTRY_RECORD_PANE_STORAGE_KEY, recordPaneCollapsed.value);
}

function toggleFocusMode(): void {
  focusMode.value = !focusMode.value;
  persistLayoutPreference(QUICK_ENTRY_FOCUS_MODE_STORAGE_KEY, focusMode.value);
}

function stopNativeClipboard(): void {
  const sessionId = clipboardSession.context?.sessionId;
  if (sessionId && bridge?.stopClipboardFollow) void bridge.stopClipboardFollow(sessionId).catch(() => undefined);
}

function resetClipboardFollow(message?: string): void {
  resetNativeUndoShortcut();
  stopNativeClipboard();
  clipboardSession.reset(message);
}

function pauseClipboardFollow(message?: string): void {
  if (!clipboardSession.context) return;
  clipboardSession.pause(message);
  stopNativeClipboard();
}

async function beginClipboardFollow(resume = false): Promise<boolean> {
  const record = activeRecord.value;
  if (!clipboardAvailable || !clipboardEnabled.value || !record || saving.value || clipboardBusy.value) return false;
  if (formReadonly.value || record.report_generated) {
    resetClipboardFollow("当前记录不可编辑，请选择其他病理号");
    return false;
  }
  if (projectFields.value.some((field) =>
    ["pathology_number", "block_number"].includes(field.system_key ?? "") &&
    (entryValues[field.id] ?? "") !== (baselineValues[field.id] ?? ""))) {
    ElMessage.warning("病理号或蜡块号有未保存修改，请先保存后重新确认");
    return false;
  }
  const fieldIds = fieldSettings.value.clipboardFieldIds;
  if (!fieldIds.length) {
    ElMessage.warning("请先在快捷表头设置中选择粘贴字段与顺序");
    return false;
  }
  stopNativeClipboard();
  const context = { sessionId: crypto.randomUUID(), projectId: activeProjectId.value, recordId: record.id };
  clipboardSession.start(context, fieldIds, resume);
  if (clipboardSession.status === "complete") return false;
  clipboardBusy.value = true;
  try {
    await bridge!.startClipboardFollow(context);
    if (!clipboardSession.matches(context) || clipboardSession.status !== "listening") {
      await bridge!.stopClipboardFollow(context.sessionId).catch(() => undefined);
      return false;
    }
    return true;
  } catch (error) {
    if (clipboardSession.matches(context)) {
      clipboardSession.pause(error instanceof Error ? error.message : "剪贴板监听无法启动");
    }
    await bridge!.stopClipboardFollow(context.sessionId).catch(() => undefined);
    return false;
  } finally {
    clipboardBusy.value = false;
  }
}

function applyClipboardFill(result: ReturnType<ClipboardFollowSession["receive"]>): void {
  if (result.kind === "filled") setEntryValue(result.field, result.value);
  if (clipboardSession.status !== "listening") stopNativeClipboard();
}

function handleClipboardEvent(event: ClipboardFollowEvent): void {
  if (!clipboardSession.matches(event)) return;
  if (event.type === "stopped") {
    clipboardSession.pause(event.reason);
    return;
  }
  if (
    !clipboardEnabled.value || activeRecord.value?.id !== event.recordId ||
    activeProjectId.value !== event.projectId || formReadonly.value ||
    activeRecord.value.report_generated || fieldDialogVisible.value
  ) {
    pauseClipboardFollow("当前记录或表头暂不可接收，请重新确认后继续");
    return;
  }
  applyClipboardFill(clipboardSession.receive(
    event, projectFields.value, entryValues, fieldSettings.value.clipboardOverwriteExisting,
  ));
}

async function skipClipboardField(): Promise<void> {
  if (saving.value || clipboardBusy.value) return;
  pauseClipboardFollow();
  clipboardSession.skip();
  if (clipboardSession.status === "listening") await beginClipboardFollow(true);
}

async function undoClipboardField(): Promise<void> {
  if (saving.value || clipboardBusy.value) return;
  resetNativeUndoShortcut();
  pauseClipboardFollow();
  const historyLength = clipboardSession.history.length;
  const change = clipboardSession.undo(entryValues);
  const field = change && fieldById.value.get(change.fieldId);
  if (change && field) setEntryValue(field, change.value);
  if (clipboardSession.history.length < historyLength) await beginClipboardFollow(true);
}

async function overwriteClipboardField(): Promise<void> {
  if (formReadonly.value || clipboardBusy.value) return;
  applyClipboardFill(clipboardSession.overwritePending(projectFields.value, entryValues));
  if (clipboardSession.status === "listening") await beginClipboardFollow(true);
}

async function acceptCurrentClipboard(): Promise<void> {
  if (clipboardSession.status !== "listening" && !(await beginClipboardFollow(true))) return;
  const context = clipboardSession.context;
  if (!context) return;
  try {
    await bridge!.acceptCurrentClipboard(context.sessionId);
  } catch (error) {
    if (clipboardSession.matches(context)) {
      pauseClipboardFollow(error instanceof Error ? error.message : "无法读取当前剪贴板");
    }
  }
}

async function toggleClipboardFollow(enabled: boolean): Promise<void> {
  if (!clipboardAvailable || !activeProjectId.value || settingsSaving.value || saving.value) return;
  const projectId = activeProjectId.value;
  const previous = fieldSettings.value.clipboardEnabled;
  resetClipboardFollow();
  clipboardEnabled.value = enabled;
  settingsSaving.value = true;
  try {
    const document: QuickEntrySettingsDocument = {
      version: 5, projects: { ...settingsDocument.value.projects,
        [projectId]: { ...fieldSettings.value, clipboardEnabled: enabled } },
    };
    const result = await putSetting(QUICK_ENTRY_SETTINGS_KEY, document);
    settingsDocument.value = normalizeQuickEntrySettings(result.value);
    if (projectId === activeProjectId.value) fieldSettings.value = resolveFieldSettings(projectId);
  } catch (error) {
    if (projectId === activeProjectId.value) clipboardEnabled.value = previous;
    ElMessage.error(error instanceof Error ? error.message : "剪贴板跟随设置保存失败");
  } finally {
    settingsSaving.value = false;
  }
}

watch([isLocked, activeRecordUnavailable], ([locked, unavailable]) => {
  if (locked || unavailable) resetClipboardFollow("当前记录不可编辑，接收已停止");
});
watch(() => JSON.stringify(entryFields.value.map((field) => [
  field.id, field.hidden, field.data_type, field.options.map((option) => option.value),
])), () => {
  if (clipboardSession.context) resetClipboardFollow("表头已变化，请重新确认粘贴顺序");
});

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

async function copyPathologyNumber(pathologyNumber: string): Promise<boolean> {
  try {
    if (clipboardAvailable) {
      await bridge!.writeInternalClipboard(pathologyNumber);
      return true;
    }
    const clipboard = navigator.clipboard;
    if (!clipboard) throw new Error("clipboard-unavailable");
    await clipboard.writeText(pathologyNumber);
    return true;
  } catch (error) {
    console.error("下一条病理号自动复制失败", error);
    ElMessage.warning("已进入下一条记录，但无法自动复制病理号，请手动复制");
    return false;
  }
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
  if (activeRecord.value?.id !== record.id || activeRecord.value?.project_id !== record.project_id) {
    resetClipboardFollow();
  }
  activeRecord.value = record;
  activeRecordUnavailable.value = record.report_generated;
  const values = valuesForRecord(record);
  replaceValues(entryValues, values);
  replaceValues(baselineValues, values);
}

function resetCreateForm(preservePinned = false): void {
  resetClipboardFollow();
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
  if (["pathology_number", "block_number"].includes(field.system_key ?? "") && entryValues[field.id] !== value) {
    resetClipboardFollow("记录标识已修改，请保存后重新确认");
  }
  entryValues[field.id] = value;
}

async function confirmDiscardChanges(action: string): Promise<boolean> {
  pauseClipboardFollow();
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
    ElMessage.warning(error instanceof Error ? error.message : "快速录入设置读取失败");
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
        include_locked: false,
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
      ElMessage.warning("当前记录已锁定或已生成报告并移出侧栏，未保存内容仍保留但不能再提交");
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
  clipboardEnabled.value = clipboardAvailable && fieldSettings.value.clipboardEnabled;
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
  pauseClipboardFollow("正在设置表头，接收已暂停");
  selectedFieldDraft.value = [...fieldSettings.value.selectedFieldIds];
  pinnedFieldDraft.value = [...fieldSettings.value.pinnedFieldIds];
  fieldWidthDraft.value = fieldSettings.value.fieldWidth;
  quickCreateFieldWidthDraft.value = fieldSettings.value.quickCreateFieldWidth;
  fontSizeDraft.value = fieldSettings.value.fontSize;
  inputHeightDraft.value = fieldSettings.value.inputHeight;
  autoAdvanceDraft.value = fieldSettings.value.autoAdvanceAfterUpdate;
  clipboardFieldDraft.value = [...fieldSettings.value.clipboardFieldIds];
  clipboardEnabledDraft.value = fieldSettings.value.clipboardEnabled;
  clipboardOverwriteDraft.value = fieldSettings.value.clipboardOverwriteExisting;
  clipboardAutoContinueDraft.value = fieldSettings.value.clipboardAutoContinue;
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
  if (!selected) clipboardFieldDraft.value = clipboardFieldDraft.value.filter((id) => id !== field.id);
}

function setClipboardFieldSelected(fieldId: string, selected: boolean): void {
  clipboardFieldDraft.value = clipboardFieldDraft.value.filter((id) => id !== fieldId);
  if (selected) clipboardFieldDraft.value.push(fieldId);
}

function moveDraftField(items: string[], fieldId: string, targetIndex: number): string[] {
  const sourceIndex = items.indexOf(fieldId);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= items.length) return items;
  return moveArrayItem(items, sourceIndex, targetIndex);
}

function moveSelectedFieldTo(fieldId: string, targetIndex: number): void {
  selectedFieldDraft.value = moveDraftField(selectedFieldDraft.value, fieldId, targetIndex);
}

function moveSelectedField(fieldId: string, offset: -1 | 1): void {
  moveSelectedFieldTo(fieldId, selectedFieldDraft.value.indexOf(fieldId) + offset);
}

function moveClipboardFieldTo(fieldId: string, targetIndex: number): void {
  clipboardFieldDraft.value = moveDraftField(clipboardFieldDraft.value, fieldId, targetIndex);
}

function moveClipboardField(fieldId: string, offset: -1 | 1): void {
  moveClipboardFieldTo(fieldId, clipboardFieldDraft.value.indexOf(fieldId) + offset);
}

function insertAfterPointer(event: DragEvent, row: HTMLElement): boolean {
  const rect = row.getBoundingClientRect();
  return event.clientY >= rect.top + rect.height / 2;
}

type QuickOrderKind = "field" | "clipboard";

function orderDraft(kind: QuickOrderKind): string[] {
  return kind === "field" ? selectedFieldDraft.value : clipboardFieldDraft.value;
}

function orderDraggingId(kind: QuickOrderKind): string {
  return kind === "field" ? draggingFieldId.value : draggingClipboardFieldId.value;
}

function setOrderDropTarget(kind: QuickOrderKind, fieldId: string, insertAfter: boolean): void {
  if (kind === "field") {
    dragOverFieldId.value = fieldId;
    dragFieldInsertAfter.value = insertAfter;
  } else {
    dragOverClipboardFieldId.value = fieldId;
    dragClipboardInsertAfter.value = insertAfter;
  }
}

function clearOrderDropTarget(kind: QuickOrderKind): void {
  setOrderDropTarget(kind, "", false);
}

function updateOrderDropTarget(event: DragEvent, kind: QuickOrderKind): boolean {
  const sourceId = orderDraggingId(kind);
  const items = orderDraft(kind);
  const sourceIndex = items.indexOf(sourceId);
  const container = event.currentTarget;
  if (!sourceId || sourceIndex < 0 || !(container instanceof HTMLElement)) return false;

  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const containerRect = container.getBoundingClientRect();
  const maximumScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const scrollDirection = gridAutoScrollVector(
    event.clientX,
    event.clientY,
    containerRect,
    38,
  ).vertical;
  container.scrollTop = nextGridScrollOffset(container.scrollTop, maximumScroll, scrollDirection, 18);

  const targetElement = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-order-field-id]")
    : null;
  const targetId = targetElement && container.contains(targetElement)
    ? targetElement.dataset.orderFieldId ?? ""
    : "";
  const rowIndex = items.indexOf(targetId);
  if (targetElement && rowIndex >= 0) {
    const insertAfter = insertAfterPointer(event, targetElement);
    const boundaryIndex = rowIndex + (insertAfter ? 1 : 0);
    if (fieldDropTargetIndex(sourceIndex, boundaryIndex, items.length) < 0) return false;
    setOrderDropTarget(kind, targetId, insertAfter);
    return true;
  }

  const selectedRows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-order-field-id]"),
  ).filter((row) => items.includes(row.dataset.orderFieldId ?? ""));
  const firstRow = selectedRows[0];
  const lastRow = selectedRows.at(-1);
  if (!firstRow || !lastRow) {
    clearOrderDropTarget(kind);
    return false;
  }
  const firstRect = firstRow.getBoundingClientRect();
  const lastRect = lastRow.getBoundingClientRect();
  if (event.clientY <= firstRect.top) {
    setOrderDropTarget(kind, items[0] ?? "", false);
    return true;
  }
  if (event.clientY >= lastRect.bottom) {
    setOrderDropTarget(kind, items.at(-1) ?? "", true);
    return true;
  }
  clearOrderDropTarget(kind);
  return false;
}

function leaveOrderList(event: DragEvent, kind: QuickOrderKind): void {
  const container = event.currentTarget;
  if (!(container instanceof HTMLElement)) return;
  if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return;
  clearOrderDropTarget(kind);
}

function applyOrderDrop(event: DragEvent, kind: QuickOrderKind): void {
  updateOrderDropTarget(event, kind);
  const items = orderDraft(kind);
  const sourceIndex = items.indexOf(orderDraggingId(kind));
  const targetId = kind === "field" ? dragOverFieldId.value : dragOverClipboardFieldId.value;
  const insertAfter = kind === "field" ? dragFieldInsertAfter.value : dragClipboardInsertAfter.value;
  const rowIndex = items.indexOf(targetId);
  const boundaryIndex = rowIndex + (insertAfter ? 1 : 0);
  const targetIndex = fieldDropTargetIndex(sourceIndex, boundaryIndex, items.length);
  if (sourceIndex >= 0 && rowIndex >= 0 && targetIndex >= 0) {
    const reordered = moveArrayItem(items, sourceIndex, targetIndex);
    if (kind === "field") selectedFieldDraft.value = reordered;
    else clipboardFieldDraft.value = reordered;
  }
  if (kind === "field") endFieldDrag();
  else endClipboardFieldDrag();
}

function startClipboardFieldDrag(event: DragEvent, fieldId: string): void {
  if (!clipboardFieldDraft.value.includes(fieldId)) return;
  draggingClipboardFieldId.value = fieldId;
  event.dataTransfer?.setData("text/plain", fieldId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function dragOverClipboardField(event: DragEvent): void {
  updateOrderDropTarget(event, "clipboard");
}

function dropClipboardField(event: DragEvent): void {
  applyOrderDrop(event, "clipboard");
}

function endClipboardFieldDrag(): void {
  draggingClipboardFieldId.value = "";
  dragOverClipboardFieldId.value = "";
  dragClipboardInsertAfter.value = false;
}

function quickEntryPageStyle(): Record<string, string> {
  return {
    "--quick-entry-font-size": `${fieldSettings.value.fontSize}px`,
    "--quick-entry-input-height": `${fieldSettings.value.inputHeight}px`,
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

function dragOverField(event: DragEvent): void {
  updateOrderDropTarget(event, "field");
}

function entryFormStyle(): Record<string, string> {
  const width = fieldSettings.value.fieldWidth;
  return {
    "--quick-field-width": `${width}px`,
    "--quick-form-max-width": `${width * 4 + 66}px`,
  };
}

function dropField(event: DragEvent): void {
  applyOrderDrop(event, "field");
}

function endFieldDrag(): void {
  draggingFieldId.value = "";
  dragOverFieldId.value = "";
  dragFieldInsertAfter.value = false;
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
      fontSize: fontSizeDraft.value,
      inputHeight: inputHeightDraft.value,
      autoAdvanceAfterUpdate: autoAdvanceDraft.value,
      clipboardFieldIds: clipboardFieldDraft.value,
      clipboardEnabled: clipboardEnabledDraft.value,
      clipboardOverwriteExisting: clipboardOverwriteDraft.value,
      clipboardAutoContinue: clipboardAutoContinueDraft.value,
    },
  );
  if (resolved.clipboardEnabled && !resolved.clipboardFieldIds.length) {
    ElMessage.warning("开启剪贴板跟随前，请至少选择一个粘贴字段");
    return;
  }
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
    version: 5,
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
    resetClipboardFollow();
    clipboardEnabled.value = clipboardAvailable && fieldSettings.value.clipboardEnabled;
    removedDirtyFields.forEach((field) => {
      entryValues[field.id] = baselineValues[field.id] ?? quickEntryDefaultValue(field);
    });
    fieldDialogVisible.value = false;
    ElMessage.success("快速录入设置已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "快速录入设置保存失败");
  } finally {
    settingsSaving.value = false;
  }
}

function issueSummary(issues: RecordValidationIssue[]): string {
  return [...new Set(issues.map((issue) => issue.message))].join("；");
}

async function confirmWarnings(
  issues: RecordValidationIssue[],
  context: "create" | "edit",
): Promise<boolean> {
  if (!issues.length) return true;
  const prompt = buildValidationPromptCopy(issues, {
    context,
    cancelBehavior: "return",
  });
  try {
    await ElMessageBox.confirm(`${issueSummary(issues)}；${prompt.outcomeText}`, prompt.title, {
      confirmButtonText: prompt.continueText,
      cancelButtonText: prompt.cancelText,
      type: "warning",
      closeOnClickModal: false,
      closeOnPressEscape: false,
      showClose: false,
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

async function saveNewRecord(): Promise<ProjectRecord | undefined> {
  const project = currentProject.value;
  if (!project) return;
  const parsed = parseCombinedPathologyNumber(combinedPathologyInput.value);
  combinedPathologyInput.value = parsed.normalized;
  const validation = await validateNewRecord({
    project_id: project.id,
    pathology_number: parsed.pathologyNumber,
    block_number: parsed.blockNumber,
    status: "待实验",
    experiment_date: null,
    experiment_number: null,
    values: {},
  });
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  const warnings = validation.issues.filter((issue) => issue.severity === "warning");
  if (errors.length) {
    await ElMessageBox.alert(issueSummary(errors), "无法保存", { type: "error" });
    return;
  }
  if (!(await confirmWarnings(warnings, "create"))) return;
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
  return created;
}

async function saveExistingRecord(): Promise<ProjectRecord | undefined> {
  const record = activeRecord.value;
  if (!record) return;
  if (activeRecordUnavailable.value || record.report_generated) {
    ElMessage.warning("该记录已锁定或已生成报告，不再允许从快速录入侧栏修改");
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
  if (!(await confirmWarnings(warnings, "edit"))) return;
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
  resetClipboardFollow("本条已保存，确认下一条后可再次接收");
  ElMessage.success(`病理号 ${updated?.pathology_number ?? record.pathology_number} 已更新`);
  if (fieldSettings.value.autoAdvanceAfterUpdate && nextRecordId) {
    const nextRecord = unreportedRecords.value.find((item) => item.id === nextRecordId);
    if (nextRecord) {
      loadRecordIntoForm(nextRecord);
      await scrollRecordIntoView(nextRecord.id);
      focusPathology();
      const copied = await copyPathologyNumber(nextRecord.pathology_number);
      if (copied) {
        ElMessage.success(`已进入下一条记录，病理号 ${nextRecord.pathology_number} 已写入剪贴板`);
      }
      if (clipboardEnabled.value && fieldSettings.value.clipboardAutoContinue) return nextRecord;
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
  pauseClipboardFollow("正在保存，接收已暂停");
  saving.value = true;
  let nextClipboardRecord: ProjectRecord | undefined;
  try {
    if (activeRecord.value) nextClipboardRecord = await saveExistingRecord();
    else await saveNewRecord();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "快速录入保存失败");
  } finally {
    saving.value = false;
  }
  if (nextClipboardRecord && nextClipboardRecord.id === activeRecord.value?.id) await beginClipboardFollow();
}

function restoreEntry(): void {
  resetClipboardFollow();
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
  if (clipboardEnabled.value && field.system_key === "pathology_number") {
    event.preventDefault();
    void beginClipboardFollow(true);
    return;
  }
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

function resetNativeUndoShortcut(): void {
  nativeUndoShortcutTarget = null;
}

function shortcutEditingTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) {
    return target;
  }
  return target.closest<HTMLElement>("[contenteditable='true']");
}

function handleQuickEntryFocusIn(): void {
  resetNativeUndoShortcut();
}

function handleQuickEntryInput(event: Event): void {
  if (!nativeUndoShortcutTarget || event.target !== nativeUndoShortcutTarget) return;
  if (event instanceof InputEvent && event.inputType === "historyUndo") return;
  resetNativeUndoShortcut();
}

function handleQuickEntryShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || fieldDialogVisible.value) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void saveEntry();
    return;
  }
  const isUndoShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
    event.key.toLocaleLowerCase() === "z";
  if (!isUndoShortcut) {
    if (!["Alt", "Control", "Meta", "Shift"].includes(event.key)) resetNativeUndoShortcut();
    return;
  }
  if (!activeRecord.value || !clipboardEnabled.value || !clipboardSession.history.length) {
    resetNativeUndoShortcut();
    return;
  }

  const editingTarget = shortcutEditingTarget(event.target);
  if (editingTarget) {
    if (nativeUndoShortcutTarget !== editingTarget || event.repeat) {
      nativeUndoShortcutTarget = editingTarget;
      return;
    }
    resetNativeUndoShortcut();
  } else {
    resetNativeUndoShortcut();
  }
  event.preventDefault();
  void undoClipboardField();
}

async function returnToMain(): Promise<void> {
  pauseClipboardFollow("已返回主程序，接收已暂停");
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
  if (initializing.value) return;
  initializing.value = true;
  initializationError.value = "";
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
  } finally {
    initializing.value = false;
  }
}

function refreshOnFocus(): void {
  if (activeProjectId.value) void refreshProjectData(activeProjectId.value);
}

function refreshRecordsPeriodically(): void {
  if (activeProjectId.value) void loadUnreportedRecords(activeProjectId.value);
}

onMounted(() => {
  restoreLayoutPreferences();
  if (bridge?.windowKind === "quick-entry") {
    removeOpenRequestListener = bridge.onQuickEntryOpenRequested((context) => {
      void handleOpenRequest(context);
    });
    removeFieldsChangedListener = bridge.onQuickEntryFieldsChanged((payload) => {
      void refreshProjectData(payload.projectId);
    });
    if (clipboardAvailable) removeClipboardListener = bridge.onClipboardFollowEvent(handleClipboardEvent);
  }
  window.addEventListener("focus", refreshOnFocus);
  window.addEventListener("focusin", handleQuickEntryFocusIn);
  window.addEventListener("input", handleQuickEntryInput);
  window.addEventListener("keydown", handleQuickEntryShortcut);
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
  resetClipboardFollow();
  removeClipboardListener?.();
  recordsLoadSequence += 1;
  removeOpenRequestListener?.();
  removeOpenRequestListener = undefined;
  removeFieldsChangedListener?.();
  removeFieldsChangedListener = undefined;
  window.removeEventListener("focus", refreshOnFocus);
  window.removeEventListener("focusin", handleQuickEntryFocusIn);
  window.removeEventListener("input", handleQuickEntryInput);
  window.removeEventListener("keydown", handleQuickEntryShortcut);
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div
    class="quick-entry-page"
    :class="{ 'records-collapsed': effectiveRecordPaneCollapsed, 'is-focus-mode': focusMode }"
    :style="quickEntryPageStyle()"
  >
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
        <el-button
          size="small"
          :icon="focusMode ? Minimize2 : Maximize2"
          data-layout-action="focus"
          :aria-pressed="focusMode"
          @click="toggleFocusMode"
        >{{ focusMode ? '退出专注' : '专注录入' }}</el-button>
        <el-button size="small" :icon="ArrowLeft" @click="returnToMain">返回主程序</el-button>
      </div>
    </header>

    <div v-if="initializationError" class="quick-entry-error">
      <el-empty :description="initializationError">
        <el-button
          v-if="appStore.bootstrapError"
          type="primary"
          :loading="initializing"
          @click="initialize"
        >
          重新加载
        </el-button>
      </el-empty>
    </div>

    <main v-else class="quick-entry-layout">
      <aside
        v-show="!focusMode"
        class="record-pane"
        :class="{ 'is-collapsed': recordPaneCollapsed }"
      >
        <div class="record-pane-header">
          <div v-if="!recordPaneCollapsed">
            <h2>记录</h2>
            <p>{{ unreportedRecords.length }} 条记录</p>
          </div>
          <div class="record-pane-actions">
            <el-button
              v-if="!recordPaneCollapsed"
              text
              circle
              :icon="Refresh"
              :loading="recordsLoading"
              aria-label="刷新病理号列表"
              title="刷新"
              @click="loadUnreportedRecords(activeProjectId)"
            />
            <el-button
              text
              circle
              :icon="recordPaneCollapsed ? PanelLeftOpen : PanelLeftClose"
              data-layout-action="records"
              :aria-expanded="!recordPaneCollapsed"
              aria-controls="quick-entry-record-list"
              :aria-label="recordPaneCollapsed ? '展开病理号列表' : '收起病理号列表'"
              :title="recordPaneCollapsed ? '展开病理号列表' : '收起病理号列表'"
              @click="toggleRecordPane"
            />
          </div>
        </div>
        <template v-if="!recordPaneCollapsed">
          <el-input
            v-model="recordSearch"
            class="record-search"
            clearable
            :prefix-icon="Search"
            placeholder="搜索病理号"
          />
          <p class="record-pane-note">锁定或已生成报告的记录不会出现在这里。</p>

          <el-scrollbar id="quick-entry-record-list" v-loading="recordsLoading" class="record-list">
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
              {{ recordSearch ? '没有匹配的病理号' : '暂无可快速录入记录' }}
            </div>
          </el-scrollbar>
        </template>
        <div v-else class="record-pane-rail" title="收起的记录列表">
          <strong>{{ unreportedRecords.length }}</strong>
          <span>记录</span>
        </div>
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
              <span v-if="activeRecord?.block_number" class="entry-block-chip">
                蜡块 {{ activeRecord.block_number }}
              </span>
              <span
                class="entry-guidance"
                role="note"
                tabindex="0"
                :aria-label="entryGuidance"
                :title="entryGuidance"
              ><Info :size="16" aria-hidden="true" /></span>
            </div>
          </div>
          <div class="entry-toolbar">
            <el-button size="small" :icon="Setting" :disabled="saving" @click="openFieldSettings">
              表头与尺寸（{{ entryFields.length }}）
            </el-button>
            <el-button size="small" :icon="Plus" type="primary" plain :disabled="saving" @click="startCreate">
              新增记录
            </el-button>
          </div>
        </div>

        <el-scrollbar class="entry-form-scroll">
          <div v-if="activeRecord" class="clipboard-follow-panel" :class="{ 'is-listening': clipboardSession.status === 'listening' }">
            <div class="clipboard-follow-heading">
              <el-switch
                :model-value="clipboardEnabled"
                :disabled="!clipboardAvailable || saving || settingsSaving || clipboardBusy"
                active-text="剪贴板跟随"
                @change="toggleClipboardFollow(Boolean($event))"
              />
              <span v-if="!clipboardAvailable" class="clipboard-note">仅 Windows 桌面版可用</span>
            </div>
            <template v-if="clipboardEnabled">
              <div class="clipboard-progress" aria-live="polite">
                <strong v-if="clipboardNextField">
                  当前项：{{ clipboardNextField.label }}（{{ clipboardSession.index + 1 }}/{{ clipboardSession.fieldIds.length }}）
                </strong>
                <strong v-else-if="clipboardSession.status === 'complete'">全部填完，请检查后 Ctrl+Enter 保存</strong>
                <strong v-else>等待确认本条</strong>
                <span :title="clipboardSession.message">{{ clipboardSession.message }}</span>
              </div>
              <div v-if="activeRecord" class="clipboard-toolbar">
                <el-button
                  v-if="clipboardSession.status === 'waiting' || clipboardSession.status === 'paused'"
                  size="small" type="primary" :disabled="formReadonly" :loading="clipboardBusy"
                  @click="beginClipboardFollow(clipboardSession.status === 'paused')"
                >{{ clipboardSession.status === 'paused' ? '继续接收' : '确认本条并开始' }}</el-button>
                <el-button v-if="clipboardSession.status === 'listening'" size="small" @click="pauseClipboardFollow()">暂停</el-button>
                <el-button
                  size="small"
                  :disabled="formReadonly || clipboardBusy || clipboardSession.status === 'waiting' || clipboardSession.status === 'complete'"
                  @click="acceptCurrentClipboard"
                >粘贴</el-button>
                <el-button
                  size="small" :disabled="formReadonly || clipboardBusy || !clipboardSession.nextFieldId"
                  @click="skipClipboardField"
                >跳过当前项</el-button>
                <el-button
                  v-if="clipboardSession.pending" size="small" type="warning" :disabled="formReadonly || clipboardBusy"
                  @click="overwriteClipboardField"
                >覆盖当前项</el-button>
                <el-button
                  size="small" :disabled="formReadonly || clipboardBusy || !clipboardSession.history.length"
                  @click="undoClipboardField"
                >撤回至上一项</el-button>
                <el-button size="small" :disabled="formReadonly || clipboardBusy" @click="beginClipboardFollow(false)">重新开始录入</el-button>
              </div>
            </template>
          </div>

          <el-alert
            v-if="activeRecordUnavailable"
            class="locked-alert"
            type="error"
            title="该记录已锁定或已生成报告并移出病理号侧栏，当前内容仅保留供查看，不能再提交。"
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

          <el-form
            v-if="activeRecord"
            class="entry-form"
            label-position="top"
            size="default"
            :style="entryFormStyle()"
            @submit.prevent
          >
            <el-form-item
              v-for="field in entryFields"
              :key="field.id"
              :class="{ 'clipboard-next-field': clipboardEnabled && clipboardNextField?.id === field.id, 'clipboard-filled-field': clipboardEnabled && clipboardSession.lastFilledFieldId === field.id }"
            >
              <template #label>
                <span class="entry-field-label">
                  <span>{{ field.label }}</span>
                  <span v-if="clipboardFieldSequence(field.id)" class="entry-field-sequence">
                    {{ clipboardFieldSequence(field.id) }}
                  </span>
                  <span v-if="clipboardEnabled && clipboardNextField?.id === field.id" class="clipboard-field-mark">当前项</span>
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
          <span>Ctrl+Enter 快速保存 · Ctrl+Z 撤回（输入框内连续按两次）</span>
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
      title="快捷表头、顺序与显示尺寸"
      width="min(820px, 94vw)"
      append-to-body
      destroy-on-close
    >
      <p class="field-dialog-note">
        “快捷录入”决定修改表单中显示哪些表头；拖到列表顶部或底部可直接移到首尾，靠近边缘时会自动滚动，字体和尺寸按项目保存。
      </p>
      <div class="field-dialog-toolbar">
        <el-button size="small" @click="selectAllFields">全部选择</el-button>
        <el-button size="small" @click="restoreRecommendedFields">恢复项目推荐</el-button>
        <el-checkbox v-model="autoAdvanceDraft">修改后自动进入下一条</el-checkbox>
      </div>
      <div class="display-size-controls">
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
        <span class="unified-size-controls">
          <b>字体大小</b>
          <el-input-number
            v-model="fontSizeDraft"
            :min="QUICK_ENTRY_FONT_SIZE_MIN"
            :max="QUICK_ENTRY_FONT_SIZE_MAX"
            :step="1"
            size="small"
            controls-position="right"
            aria-label="快速录入字体大小"
          />
          <span>px</span>
        </span>
        <span class="unified-size-controls">
          <b>输入框高度</b>
          <el-input-number
            v-model="inputHeightDraft"
            :min="QUICK_ENTRY_INPUT_HEIGHT_MIN"
            :max="QUICK_ENTRY_INPUT_HEIGHT_MAX"
            :step="1"
            size="small"
            controls-position="right"
            aria-label="快速录入输入框高度"
          />
          <span>px</span>
        </span>
      </div>
      <div
        class="field-selector"
        @dragover="dragOverField"
        @dragleave="leaveOrderList($event, 'field')"
        @drop="dropField"
      >
        <div class="field-selector-head">
          <span>表头与顺序</span>
          <span>快捷录入</span>
        </div>
        <div
          v-for="field in fieldDialogFields"
          :key="field.id"
          class="field-selector-row"
          :data-order-field-id="field.id"
          :class="{
            'is-dragging': draggingFieldId === field.id,
            'is-drag-before': dragOverFieldId === field.id && !dragFieldInsertAfter,
            'is-drag-after': dragOverFieldId === field.id && dragFieldInsertAfter,
          }"
        >
          <span class="field-selector-name">
            <span v-if="draftIncludes(selectedFieldDraft, field.id)" class="quick-order-actions">
              <button
                type="button"
                class="field-drag-handle"
                draggable="true"
                title="拖动调整顺序"
                :aria-label="`拖动表头“${field.label}”调整顺序`"
                @dragstart="startFieldDrag($event, field.id)"
                @dragend="endFieldDrag"
              ><GripVertical :size="16" aria-hidden="true" /></button>
              <el-button
                link :icon="ChevronsUp"
                :disabled="selectedFieldDraft.indexOf(field.id) === 0"
                :aria-label="`将表头“${field.label}”移到最前`" title="移到最前"
                @click="moveSelectedFieldTo(field.id, 0)"
              />
              <el-button
                link :icon="ArrowUp"
                :disabled="selectedFieldDraft.indexOf(field.id) === 0"
                :aria-label="`将表头“${field.label}”向前移动一位`" title="向前移动"
                @click="moveSelectedField(field.id, -1)"
              />
              <el-button
                link :icon="ArrowDown"
                :disabled="selectedFieldDraft.indexOf(field.id) === selectedFieldDraft.length - 1"
                :aria-label="`将表头“${field.label}”向后移动一位`" title="向后移动"
                @click="moveSelectedField(field.id, 1)"
              />
              <el-button
                link :icon="ChevronsDown"
                :disabled="selectedFieldDraft.indexOf(field.id) === selectedFieldDraft.length - 1"
                :aria-label="`将表头“${field.label}”移到最后`" title="移到最后"
                @click="moveSelectedFieldTo(field.id, selectedFieldDraft.length - 1)"
              />
            </span>
            <span
              v-if="draftIncludes(selectedFieldDraft, field.id)"
              class="field-order-number"
            >{{ selectedFieldDraft.indexOf(field.id) + 1 }}.</span>
            <span>{{ field.label }}</span>
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
      <section class="clipboard-order-settings">
        <h3>剪贴板粘贴顺序</h3>
        <p class="field-dialog-note">只从上方已选的可见表头中选择。拖到列表顶部或底部可直接移到首尾，靠近边缘时会自动滚动，也可使用首尾和上下按钮；不改变表单显示顺序。</p>
        <div class="clipboard-options">
          <el-checkbox v-model="clipboardEnabledDraft" :disabled="!clipboardAvailable">默认开启剪贴板跟随</el-checkbox>
          <el-checkbox v-model="clipboardOverwriteDraft">允许覆盖已有字段内容</el-checkbox>
          <el-checkbox v-model="clipboardAutoContinueDraft">保存进入下一条后自动开始接收</el-checkbox>
        </div>
        <div
          class="clipboard-order-list"
          @dragover="dragOverClipboardField"
          @dragleave="leaveOrderList($event, 'clipboard')"
          @drop="dropClipboardField"
        >
          <div
            v-for="field in clipboardDialogFields" :key="field.id" class="clipboard-order-row"
            :data-order-field-id="field.id"
            :class="{
              'is-dragging': draggingClipboardFieldId === field.id,
              'is-drag-before': dragOverClipboardFieldId === field.id && !dragClipboardInsertAfter,
              'is-drag-after': dragOverClipboardFieldId === field.id && dragClipboardInsertAfter,
            }"
          >
            <button
              v-if="clipboardFieldDraft.includes(field.id)" type="button"
              class="field-drag-handle" draggable="true"
              :aria-label="`拖动“${field.label}”调整粘贴顺序`"
              title="拖动调整顺序"
              @dragstart="startClipboardFieldDrag($event, field.id)"
              @dragend="endClipboardFieldDrag"
            ><GripVertical :size="16" aria-hidden="true" /></button>
            <el-checkbox
              :model-value="clipboardFieldDraft.includes(field.id)"
              @change="setClipboardFieldSelected(field.id, Boolean($event))"
            >{{ clipboardFieldDraft.includes(field.id) ? `${clipboardFieldDraft.indexOf(field.id) + 1}. ` : '' }}{{ field.label }}</el-checkbox>
            <span v-if="clipboardFieldDraft.includes(field.id)" class="clipboard-order-arrows">
              <el-button
                link :icon="ChevronsUp" :disabled="clipboardFieldDraft.indexOf(field.id) === 0"
                :aria-label="`将“${field.label}”移到最前`" title="移到最前"
                @click="moveClipboardFieldTo(field.id, 0)"
              />
              <el-button
                link :icon="ArrowUp" :disabled="clipboardFieldDraft.indexOf(field.id) === 0"
                :aria-label="`将“${field.label}”向前移动一位`" title="向前移动"
                @click="moveClipboardField(field.id, -1)"
              />
              <el-button
                link :icon="ArrowDown" :disabled="clipboardFieldDraft.indexOf(field.id) === clipboardFieldDraft.length - 1"
                :aria-label="`将“${field.label}”向后移动一位`" title="向后移动"
                @click="moveClipboardField(field.id, 1)"
              />
              <el-button
                link :icon="ChevronsDown" :disabled="clipboardFieldDraft.indexOf(field.id) === clipboardFieldDraft.length - 1"
                :aria-label="`将“${field.label}”移到最后`" title="移到最后"
                @click="moveClipboardFieldTo(field.id, clipboardFieldDraft.length - 1)"
              />
            </span>
          </div>
        </div>
        <p v-if="!clipboardDialogFields.length" class="field-dialog-note">请先选择至少一个可见的业务表头。</p>
      </section>
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
.clipboard-follow-panel {
  display: flex;
  flex: 0 0 auto;
  min-width: 0;
  align-items: center;
  gap: 8px;
  margin: 6px 8px 0;
  padding: 5px 7px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
}
.clipboard-follow-panel.is-listening { border-color: var(--app-primary); }
.clipboard-follow-heading, .clipboard-toolbar, .clipboard-options, .clipboard-order-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.clipboard-follow-heading { flex: 0 0 auto; flex-wrap: nowrap; }
.clipboard-toolbar {
  min-width: 0;
  max-width: 62%;
  flex: 0 1 auto;
  flex-wrap: nowrap;
  gap: 5px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.clipboard-toolbar :deep(.el-button) { flex: 0 0 auto; }
.clipboard-toolbar :deep(.el-button + .el-button) { margin-left: 0; }
.clipboard-note, .clipboard-progress span { color: var(--app-muted); font-size: 12px; }
.clipboard-progress {
  display: flex;
  min-width: 120px;
  flex: 1 1 220px;
  align-items: center;
  gap: 7px;
}
.clipboard-progress strong {
  flex: 0 0 auto;
  color: var(--app-primary-text);
  font-size: 13px;
  white-space: nowrap;
}
.clipboard-progress span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clipboard-field-mark { color: var(--app-primary-text); font-size: 11px; }
.clipboard-next-field .entry-field { outline: 2px solid var(--app-primary-border); border-radius: 5px; }
.clipboard-filled-field .entry-field { background: var(--app-primary-soft); border-radius: 5px; }
.clipboard-order-settings { margin-top: 18px; border-top: 1px solid var(--app-border); padding-top: 10px; }
.clipboard-order-settings h3 { margin: 0 0 8px; font-size: 15px; }
.clipboard-options { margin-bottom: 8px; }
.clipboard-order-list {
  max-height: min(360px, 45vh);
  overflow: auto;
  border: 1px solid var(--app-border);
  border-radius: 8px;
}
.clipboard-order-row {
  min-height: 38px;
  border-bottom: 1px solid var(--app-border-light);
  padding: 4px;
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
.clipboard-order-row:last-child { border-bottom: 0; }
.clipboard-order-row.is-dragging { opacity: 0.45; }
.clipboard-order-arrows { margin-left: auto; display: flex; gap: 4px; }
.clipboard-order-arrows :deep(.el-button + .el-button) { margin-left: 0; }
.quick-entry-page {
  display: flex;
  height: 100vh;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--app-bg);
  color: var(--app-text);
  font-size: var(--quick-entry-font-size, 14px);
}

.quick-entry-page :deep(.el-input) {
  --el-input-height: var(--quick-entry-input-height, 32px);
  font-size: var(--quick-entry-font-size, 14px);
}

.quick-entry-page :deep(.el-select) {
  --el-input-height: var(--quick-entry-input-height, 32px);
}

.quick-entry-page :deep(.el-select__wrapper) {
  min-height: var(--quick-entry-input-height, 32px);
  font-size: var(--quick-entry-font-size, 14px);
}

.quick-entry-page :deep(.el-textarea__inner) {
  min-height: var(--quick-entry-input-height, 32px) !important;
  font-size: var(--quick-entry-font-size, 14px);
}

.quick-entry-header {
  display: flex;
  min-height: 52px;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-bg);
  padding: 6px 10px;
  box-shadow: 0 1px 3px rgb(16 24 40 / 5%);
}

.quick-entry-brand {
  display: flex;
  min-width: 142px;
  align-items: center;
  gap: 7px;
}

.quick-entry-brand svg {
  padding: 6px;
  color: var(--app-primary-text);
  background: var(--app-primary-soft);
  border: 1px solid var(--app-primary-border);
  border-radius: 9px;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
}

.quick-entry-brand div {
  display: grid;
  gap: 1px;
}

.quick-entry-brand strong {
  font-size: calc(var(--quick-entry-font-size, 14px) + 2px);
}

.quick-entry-brand span {
  display: none;
}

.project-select {
  width: min(220px, 28vw);
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
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
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
  gap: 8px;
  padding: 8px;
}

.quick-entry-page.records-collapsed .quick-entry-layout {
  grid-template-columns: 44px minmax(0, 1fr);
}

.quick-entry-page.is-focus-mode .quick-entry-layout {
  grid-template-columns: minmax(0, 1fr);
  padding: 6px;
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

.record-pane-actions {
  display: flex;
  min-width: 0;
  align-items: center;
}

.record-pane-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.record-pane.is-collapsed .record-pane-header {
  justify-content: center;
  padding: 6px 3px;
}

.record-pane-rail {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-top: 1px solid var(--app-border-light);
  color: var(--app-muted);
  font-size: calc(var(--quick-entry-font-size, 14px) - 2px);
}

.record-pane-rail strong {
  color: var(--app-primary-text);
  font-size: var(--quick-entry-font-size, 14px);
}

.record-pane-rail span {
  writing-mode: vertical-rl;
}

.record-pane-header h2 {
  margin: 0;
  font-size: var(--quick-entry-font-size, 14px);
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
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-meta {
  display: block;
  overflow: hidden;
  color: var(--app-muted);
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-meta .el-icon {
  color: var(--app-danger);
}

.record-list-empty {
  padding: 28px 10px;
  color: var(--app-subtle);
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
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
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--app-border-light);
  padding: 7px 10px;
}

.entry-heading {
  min-width: 0;
}

.entry-title-row {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.entry-title-row h1 {
  max-width: min(360px, 45vw);
  overflow: hidden;
  margin: 0;
  font-size: calc(var(--quick-entry-font-size, 14px) + 4px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-title-row .el-tag {
  gap: 3px;
}

.entry-block-chip {
  border-radius: 999px;
  background: var(--app-surface-soft);
  color: var(--app-muted);
  padding: 2px 7px;
  font-size: calc(var(--quick-entry-font-size, 14px) - 2px);
  white-space: nowrap;
}

.entry-guidance {
  display: inline-grid;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  place-items: center;
  border-radius: 999px;
  color: var(--app-muted);
  cursor: help;
}

.entry-guidance:hover,
.entry-guidance:focus-visible {
  background: var(--app-hover);
  color: var(--app-primary-text);
  outline: none;
}

.entry-toolbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: nowrap;
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
  max-width: min(var(--quick-form-max-width, 706px), 100%);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--quick-field-width, 160px)), 1fr));
  align-items: start;
  gap: 8px 14px;
  margin-inline: auto;
  padding: 10px 12px 16px;
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
  line-height: 1.35;
}

.entry-field-label {
  display: inline-flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 6px;
  color: var(--app-text);
  font-size: var(--quick-entry-font-size, 14px);
  font-weight: 600;
  line-height: 1.35;
}

.entry-field-sequence {
  color: var(--app-muted);
  font-size: calc(var(--quick-entry-font-size, 14px) - 2px);
  font-weight: 500;
}

.required-mark,
.pinned-mark {
  border-radius: 999px;
  padding: 1px 6px;
  font-size: calc(var(--quick-entry-font-size, 14px) - 2px);
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
  font-size: calc(var(--quick-entry-font-size, 14px) + 2px);
  font-weight: 700;
}

.quick-create-form p {
  margin: 10px 0 0;
  color: var(--app-muted);
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
  line-height: 1.6;
}

.entry-footer {
  display: flex;
  min-height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--app-border);
  background: var(--app-bg);
  padding: 6px 10px;
}

.entry-footer > span {
  color: var(--app-subtle);
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
}

.entry-footer > div {
  display: flex;
  gap: 8px;
}

.entry-footer .el-button + .el-button {
  margin-left: 0;
}

.quick-entry-page.is-focus-mode .entry-toolbar,
.quick-entry-page.is-focus-mode .entry-footer > span {
  display: none;
}

.quick-entry-page.is-focus-mode .entry-footer {
  justify-content: flex-end;
}

.field-dialog-note {
  margin: -2px 0 12px;
  color: var(--app-muted);
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
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

.display-size-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 14px;
  margin-bottom: 12px;
  border: 1px solid var(--app-border-light);
  border-radius: 9px;
  background: var(--app-surface-soft);
  padding: 10px 12px;
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
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
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

.field-selector-row.is-drag-before,
.clipboard-order-row.is-drag-before {
  background: var(--app-primary-soft);
  box-shadow: inset 0 3px var(--app-primary);
}

.field-selector-row.is-drag-after,
.clipboard-order-row.is-drag-after {
  background: var(--app-primary-soft);
  box-shadow: inset 0 -3px var(--app-primary);
}

.field-selector-name {
  display: flex;
  min-width: 0;
  overflow: hidden;
  align-items: center;
  gap: 4px;
  font-size: var(--quick-entry-font-size, 14px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field-selector-name small {
  margin-left: 5px;
  color: var(--app-danger);
  font-size: calc(var(--quick-entry-font-size, 14px) - 2px);
}

.field-drag-handle {
  display: inline-flex;
  width: 26px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  color: var(--app-muted);
  background: transparent;
  cursor: grab;
  margin-right: 4px;
  padding: 0;
  vertical-align: middle;
}

.field-drag-handle:hover,
.field-drag-handle:focus-visible {
  color: var(--app-primary-text);
  background: var(--app-primary-soft);
}

.field-drag-handle:active {
  cursor: grabbing;
}

.quick-order-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
}

.quick-order-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.field-order-number {
  color: var(--app-muted);
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
}

.unified-size-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 125px auto;
  align-items: center;
  gap: 5px;
  color: var(--app-muted);
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
}

.unified-size-controls :deep(.el-input-number) {
  width: 125px;
}

@media (max-width: 680px) {
  .display-size-controls {
    grid-template-columns: 1fr;
  }
}

@container quick-entry-form (max-width: 760px) {
  .clipboard-follow-panel {
    flex-wrap: wrap;
  }

  .clipboard-progress {
    min-width: 0;
  }

  .clipboard-toolbar {
    max-width: 100%;
    flex-basis: 100%;
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
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 8px;
    padding: 8px;
  }

  .entry-pane-header {
    flex-wrap: wrap;
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
  .entry-pane-header {
    gap: 7px;
    padding: 8px 12px;
  }

  .clipboard-follow-panel {
    margin: 5px 8px 0;
    padding: 5px 8px;
  }

  .entry-footer {
    min-height: 48px;
    padding-block: 6px;
  }

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
.record-pane-header p, .record-pane-note, .record-meta,
.entry-footer > span, .quick-entry-brand span, .field-selector-head {
  font-size: calc(var(--quick-entry-font-size, 14px) - 1px);
}
.required-mark, .pinned-mark, .field-selector-name small {
  font-size: calc(var(--quick-entry-font-size, 14px) - 2px);
}
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
