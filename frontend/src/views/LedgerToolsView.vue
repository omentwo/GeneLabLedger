<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import type { TableV2Instance } from "element-plus";

import {
  applyReorderByDate,
  FIND_REPLACE_RECORD_LIMIT,
  listRecords,
  previewReorderByDate,
  queryRecordIds as queryLedgerRecordIds,
} from "@/api/records";
import { useLedgerFindReplace } from "@/composables/useLedgerFindReplace";
import LedgerTemplateManager from "@/components/LedgerTemplateManager.vue";
import ProjectFieldManager from "@/components/ProjectFieldManager.vue";
import { useAppStore } from "@/stores/app";
import { shanghaiDateKey } from "@/utils/datetime";
import { desktopBridge } from "@/utils/desktop";
import { logError } from "@/utils/logger";
import type { LedgerRow } from "@/utils/ledgerTableView";
import type { GridCellPosition } from "@/utils/gridSelectionModel";
import { initializeWindowCloseGuard, registerWindowCloseGuard } from "@/utils/windowCloseGuard";
import type {
  FieldDefinition,
  ProjectRecord,
  RecordReorderByDatePreview,
} from "@/types/api";
import type {
  LedgerToolsChangedPayload,
  LedgerToolsOpenContext,
  LedgerToolsTab,
} from "@/types/electron";

/**
 * 台账工具窗口（桌面端独立非置顶窗口）：管理项目与表头 / 按日期重排 / 查找替换。
 *
 * 与快速录入同构：bootstrap → 初始化上下文 → ledgerToolsReady；之后通过
 * ledger-tools-open-requested 接收重复打开时的上下文。数据变更经
 * notifyLedgerToolsChanged 交给主进程转发主窗口与快速录入。
 */

const TOOL_WINDOW_TABS: LedgerToolsTab[] = ["fields", "reorder", "find-replace"];
const RECORD_PAGE_SIZE = 10_000;

const appStore = useAppStore();
const route = useRoute();
const bridge = desktopBridge();

const initializing = ref(false);
const initializationError = ref("");
const activeProjectId = ref("");
const activeTab = ref<LedgerToolsTab>("fields");
const templateManagerVisible = ref(false);

const activeProjectName = computed(
  () => appStore.projectById(activeProjectId.value)?.name ?? "",
);
const toolFields = computed<FieldDefinition[]>(() => {
  const project = appStore.projectById(activeProjectId.value);
  return (project?.fields ?? [])
    .filter((field) => field.is_core || !field.hidden)
    .sort((left, right) => left.sort_order - right.sort_order);
});

function notifyToolChange(
  projectIds: string[],
  action: LedgerToolsChangedPayload["action"],
): void {
  if (bridge?.windowKind !== "ledger-tools") return;
  [...new Set(projectIds)].filter(Boolean).forEach((projectId) => {
    void bridge
      .notifyLedgerToolsChanged({ projectId, action })
      .catch((error) => logError("ledger-tools", "台账工具变更通知失败", error));
  });
}

// —— 管理项目与表头 ——————————————————————————————————————

function handleFieldsChanged(changedProjectId: string): void {
  notifyToolChange([changedProjectId || activeProjectId.value], "fields");
}

function handleToolProjectSelected(projectId: string): void {
  if (projectId && projectId !== activeProjectId.value) activeProjectId.value = projectId;
  if (bridge?.windowKind === "ledger-tools") {
    void bridge
      .selectProjectFromLedgerTools(projectId)
      .catch((error) => logError("ledger-tools", "项目切换同步失败", error));
  }
}

function finishToolsSession(): void {
  window.close();
}

// —— 按日期重排 ——————————————————————————————————————————

const reorderDate = ref(shanghaiDateKey(new Date()));
const reorderPreview = ref<RecordReorderByDatePreview | null>(null);
const reorderLoading = ref(false);

async function loadReorderPreview(): Promise<void> {
  if (!activeProjectId.value) {
    ElMessage.warning("请先选择台账项目");
    return;
  }
  if (!reorderDate.value) {
    ElMessage.warning("请选择需要重排的实验日期");
    return;
  }
  reorderLoading.value = true;
  try {
    reorderPreview.value = await previewReorderByDate(activeProjectId.value, reorderDate.value);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "重排预览失败");
  } finally {
    reorderLoading.value = false;
  }
}

async function confirmReorderByDate(): Promise<void> {
  const preview = reorderPreview.value;
  if (!preview) return;
  reorderLoading.value = true;
  try {
    const result = await applyReorderByDate(
      activeProjectId.value,
      preview.experiment_date,
      preview.expected_order_hash,
    );
    const affectedProjectIds = preview.projects.map((project) => project.project_id);
    reorderPreview.value = null;
    notifyToolChange(affectedProjectIds, "reorder");
    ElMessage.success(`重排完成，共调整 ${result.changed_records} 条记录`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "按日期重排失败");
    reorderPreview.value = null;
  } finally {
    reorderLoading.value = false;
  }
}

// —— 查找替换（复用 useLedgerFindReplace，网格依赖以空实现替换） ——

const records = ref<ProjectRecord[]>([]);
const recordsProjectId = ref("");
const recordsLoading = ref(false);
const tableRef = ref<TableV2Instance | null>(null);
const editingGridCell = ref<GridCellPosition | null>(null);
const activeGridCell = ref<GridCellPosition | null>(null);
const gridSelectionAnchor = ref<GridCellPosition | null>(null);
const gridCellRange = ref(null);
const selectedGridCellKeys = ref(new Set<string>());
const findReplaceInputRef = ref<{ focus: () => void } | null>(null);

async function loadProjectRecords(projectId: string): Promise<void> {
  recordsLoading.value = true;
  try {
    const collected: ProjectRecord[] = [];
    let offset = 0;
    for (;;) {
      const page = await listRecords({
        project_id: projectId,
        include_locked: true,
        limit: RECORD_PAGE_SIZE,
        offset,
      });
      collected.push(...page.items);
      offset += page.items.length;
      if (!page.items.length || offset >= page.total || collected.length >= FIND_REPLACE_RECORD_LIMIT) {
        break;
      }
    }
    records.value = collected;
    recordsProjectId.value = projectId;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "台账记录读取失败");
  } finally {
    recordsLoading.value = false;
  }
}

async function ensureRecordsLoaded(): Promise<void> {
  if (!activeProjectId.value) return;
  if (recordsProjectId.value === activeProjectId.value && records.value.length) return;
  await loadProjectRecords(activeProjectId.value);
}

function registerFindReplaceInput(element: { focus: () => void } | null): void {
  findReplaceInputRef.value = element;
}

const {
  findReplaceVisible,
  findReplaceLoading,
  findReplacePreview,
  findReplaceScopeCount,
  findReplaceScopeLabel,
  findReplaceMode,
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
} = useLedgerFindReplace({
  fields: toolFields,
  tableRows: computed(() => records.value as LedgerRow[]),
  tableRowIndexById: computed(() => new Map(records.value.map((record, index) => [record.id, index]))),
  records,
  selection: {
    activeGridCell,
    gridSelectionAnchor,
    gridCellRange,
    selectedGridCellKeys,
    selectGridCell: () => undefined,
    selectedGridCellPositions: () => [],
  },
  clampCell: (position) => position,
  tableRef,
  gridEditorRoot: () => null,
  editingGridCell,
  commitEditThen: async () => true,
  focusCell: () => undefined,
  isDraft: () => false,
  getProjectId: () => activeProjectId.value,
  queryRecordIds: () => queryLedgerRecordIds({
    project_id: activeProjectId.value,
    include_locked: true,
    field_filters: [],
  }),
  replaceRecord: (updated) => {
    const index = records.value.findIndex((record) => record.id === updated.id);
    if (index >= 0) records.value.splice(index, 1, updated);
  },
  pushCellHistory: () => undefined,
});
// 工具窗口里查找/替换面板常驻，等价于对话框始终打开。
findReplaceVisible.value = true;

const canLocateInLedger = computed(
  () => Boolean(bridge && bridge.windowKind === "ledger-tools" && findCurrentMatch.value),
);

function locateCurrentMatch(): void {
  const match = findCurrentMatch.value;
  if (!match || bridge?.windowKind !== "ledger-tools") return;
  void bridge
    .locateLedgerRecord({
      projectId: activeProjectId.value,
      recordId: match.rowId,
      fieldId: match.fieldId,
    })
    .catch((error) => logError("ledger-tools", "定位主表记录失败", error));
}

// commitFindReplace 成功时会把 visible 置 false（对话框语义）；面板场景里
// 借此感知提交成功，通知主窗口刷新并重置表单，保持面板可继续下一次操作。
watch(findReplaceVisible, (visible) => {
  if (visible) return;
  notifyToolChange([activeProjectId.value], "replace");
  openFindReplace("replace", true);
});

// —— 上下文与生命周期 ————————————————————————————————————

function applyContext(context: LedgerToolsOpenContext): void {
  if (initializing.value) return;
  if (
    context.projectId &&
    appStore.projects.some((project) => project.id === context.projectId) &&
    context.projectId !== activeProjectId.value
  ) {
    activeProjectId.value = context.projectId;
  }
  activeTab.value = context.tool;
  if (context.tool === "find-replace") {
    void ensureRecordsLoaded();
    openFindReplace(context.mode === "find" ? "find" : "replace", true);
  }
}

async function initialize(): Promise<void> {
  if (initializing.value) return;
  initializing.value = true;
  initializationError.value = "";
  try {
    await appStore.bootstrap();
    const routeTool = TOOL_WINDOW_TABS.includes(route.query.tool as LedgerToolsTab)
      ? (route.query.tool as LedgerToolsTab)
      : "fields";
    const routeProject = typeof route.query.project === "string" ? route.query.project : "";
    const requestedProject = appStore.projects.some((project) => project.id === routeProject)
      ? routeProject
      : appStore.projects[0]?.id ?? "";
    if (!requestedProject) {
      initializationError.value = "当前没有可用的台账项目";
      return;
    }
    activeProjectId.value = requestedProject;
    activeTab.value = routeTool;
    if (routeTool === "find-replace") {
      openFindReplace(route.query.mode === "find" ? "find" : "replace", true);
      await ensureRecordsLoaded();
    }
  } catch (error) {
    initializationError.value = error instanceof Error ? error.message : "台账工具初始化失败";
  } finally {
    initializing.value = false;
  }
}

function retryInitialize(): void {
  void initialize();
}

function refreshOnFocus(): void {
  if (activeTab.value === "find-replace" && activeProjectId.value && !recordsLoading.value) {
    void ensureRecordsLoaded();
  }
}

let removeCloseGuard: (() => void) | null = null;
let removeBusyGuard: (() => void) | null = null;
let removeOpenRequestListener: (() => void) | null = null;

onMounted(() => {
  removeCloseGuard = initializeWindowCloseGuard();
  removeBusyGuard = registerWindowCloseGuard({
    state: () => ({
      dirty: false,
      busy: recordsLoading.value || reorderLoading.value || findReplaceLoading.value,
    }),
    save: async () => true,
  });
  window.addEventListener("focus", refreshOnFocus);
  void initialize().finally(() => {
    if (bridge?.windowKind === "ledger-tools") {
      void bridge
        .ledgerToolsReady()
        .catch((error) => logError("ledger-tools", "台账工具窗口就绪通知失败", error));
      removeOpenRequestListener = bridge.onLedgerToolsOpenRequested((context) => {
        applyContext(context);
      });
    }
  });
});

onBeforeUnmount(() => {
  removeOpenRequestListener?.();
  removeOpenRequestListener = null;
  removeBusyGuard?.();
  removeBusyGuard = null;
  removeCloseGuard?.();
  removeCloseGuard = null;
  window.removeEventListener("focus", refreshOnFocus);
  cancelFindTermDebounce();
});
</script>

<template>
  <div class="ledger-tools-page">
    <header class="ledger-tools-header">
      <div>
        <h1 class="ledger-tools-title">台账工具</h1>
        <p class="ledger-tools-subtitle">
          当前项目：<strong>{{ activeProjectName || "—" }}</strong>
        </p>
      </div>
    </header>

    <div v-if="initializationError" class="ledger-tools-error">
      <el-alert type="error" :closable="false" :title="initializationError" />
      <el-button @click="retryInitialize">重试</el-button>
    </div>

    <el-tabs v-else v-model="activeTab" class="ledger-tools-tabs">
      <el-tab-pane label="管理项目与表头" name="fields">
        <ProjectFieldManager
          :selected-project-id="activeProjectId"
          embedded
          @changed="handleFieldsChanged"
          @select-project="handleToolProjectSelected"
          @open-templates="templateManagerVisible = true"
          @close="finishToolsSession"
        />
      </el-tab-pane>

      <el-tab-pane label="按日期重排" name="reorder">
        <div class="tools-pane">
          <p class="tools-pane-note">
            仅重排当前项目中所选日期的记录，并按“病理号-蜡块号”的实验编排规则排序；其他日期记录的位置保持不变。
          </p>
          <div class="tools-reorder-controls">
            <span class="tools-field-label">实验日期</span>
            <el-date-picker
              v-model="reorderDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="选择日期"
              @change="reorderPreview = null"
            />
            <el-button :loading="reorderLoading" @click="loadReorderPreview">预览</el-button>
            <el-button
              type="primary"
              :loading="reorderLoading"
              :disabled="!reorderPreview || Boolean(reorderPreview.locked_records.length) || !reorderPreview.changed_records"
              @click="confirmReorderByDate"
            >
              确认重排
            </el-button>
          </div>
          <div v-if="reorderPreview" class="reorder-preview-panel">
            <strong>
              当前项目共 {{ reorderPreview.affected_records }} 条记录，
              将调整 {{ reorderPreview.changed_records }} 条
            </strong>
            <el-alert
              v-if="reorderPreview.locked_records.length"
              type="error"
              :closable="false"
              :title="`有 ${reorderPreview.locked_records.length} 条锁定记录，请先解锁`"
            />
            <div
              v-for="project in reorderPreview.projects"
              :key="project.project_id"
              class="reorder-project-preview"
            >
              <b>{{ project.project_name }}（调整 {{ project.changed_count }} 条）</b>
              <span>调整前：{{ project.before.join('、') || '无' }}</span>
              <span>调整后：{{ project.after.join('、') || '无' }}</span>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="查找替换" name="find-replace">
        <div v-loading="recordsLoading" class="tools-pane">
          <div class="find-replace-mode-switch" role="group" aria-label="查找模式">
            <el-button
              size="small"
              :type="findReplaceMode === 'find' ? 'primary' : undefined"
              :aria-pressed="findReplaceMode === 'find'"
              @click="setFindReplaceMode('find')"
            >查找</el-button>
            <el-button
              size="small"
              :type="findReplaceMode === 'replace' ? 'primary' : undefined"
              :aria-pressed="findReplaceMode === 'replace'"
              @click="setFindReplaceMode('replace')"
            >替换</el-button>
          </div>
          <p class="muted" v-if="findReplaceMode === 'find'">
            在当前项目全部 {{ records.length.toLocaleString('zh-CN') }} 条记录中查找；点击“在主表中定位”可跳回台账高亮该单元格。
          </p>
          <p class="muted" v-else>
            {{ findReplaceScopeLabel }}；单次最多 {{ FIND_REPLACE_RECORD_LIMIT.toLocaleString('zh-CN') }} 条记录。
          </p>
          <el-form label-position="top" :disabled="findReplaceLoading">
            <el-form-item :label="findReplaceMode === 'find' ? '查找表头' : '指定表头'">
              <el-select v-model="findReplaceForm.fieldId" filterable>
                <el-option v-if="findReplaceMode === 'find'" label="全部表头" value="" />
                <el-option
                  v-for="field in toolFields"
                  :key="field.id"
                  :label="field.label"
                  :value="field.id"
                />
              </el-select>
            </el-form-item>
            <div :class="{ 'tools-two-column-form': findReplaceMode === 'replace' }">
              <el-form-item label="查找内容">
                <el-input
                  :ref="registerFindReplaceInput"
                  v-model="findReplaceForm.find"
                  clearable
                  aria-label="查找内容"
                  @keydown.enter="handleFindReplaceInputEnter"
                />
              </el-form-item>
              <el-form-item v-if="findReplaceMode === 'replace'" label="替换为">
                <el-input v-model="findReplaceForm.replacement" />
              </el-form-item>
            </div>
            <div class="tools-two-column-form">
              <el-form-item label="匹配方式">
                <el-radio-group v-model="findReplaceForm.matchMode">
                  <el-radio-button value="substring">子串</el-radio-button>
                  <el-radio-button value="whole">完整单元格</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="大小写">
                <el-checkbox v-model="findReplaceForm.caseSensitive">区分大小写</el-checkbox>
              </el-form-item>
            </div>
          </el-form>
          <div v-if="findReplaceMode === 'find'" class="ledger-find-navigation">
            <span class="ledger-find-status" role="status" aria-live="polite">{{ findMatchStatus }}</span>
            <div>
              <el-button
                :disabled="!canLocateInLedger"
                title="回到主窗口并高亮当前匹配单元格"
                @click="locateCurrentMatch"
              >在主表中定位</el-button>
              <el-button :disabled="findMatches.length === 0" @click="navigateFindMatch(-1)">上一个</el-button>
              <el-button
                type="primary"
                :disabled="findMatches.length === 0"
                @click="navigateFindMatch(1)"
              >下一个</el-button>
            </div>
          </div>
          <div v-else-if="findReplaceScopeCount !== null" class="replace-preview-panel" aria-live="polite">
            <strong>范围 {{ findReplaceScopeCount.toLocaleString('zh-CN') }} 条记录</strong>
            <template v-if="findReplacePreview">
              <span>，可替换 {{ findReplacePreview.matched_count }} 个单元格</span>
              <span>，锁定跳过 {{ findReplacePreview.skipped_locked }} 个单元格</span>
            </template>
            <p v-if="findReplaceScopeCount > FIND_REPLACE_RECORD_LIMIT" role="alert">
              范围超过单次上限，请缩小范围后重试；本次未执行替换。
            </p>
            <ul v-if="findReplacePreview?.issues.length">
              <li v-for="(issue, index) in findReplacePreview.issues.slice(0, 20)" :key="index">
                {{ issue.message }}
              </li>
            </ul>
          </div>
          <div v-if="findReplaceMode === 'replace'" class="tools-find-actions">
            <el-button :loading="findReplaceLoading" @click="runFindReplacePreview">预览</el-button>
            <el-button
              type="primary"
              :loading="findReplaceLoading"
              :disabled="!findReplacePreview?.matched_count || findReplacePreview.issues.some((issue) => issue.severity === 'error')"
              @click="commitFindReplace"
            >
              确认替换
            </el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <LedgerTemplateManager
      v-model="templateManagerVisible"
      :selected-project-id="activeProjectId"
    />
  </div>
</template>

<style scoped>
.ledger-tools-page {
  display: flex;
  min-height: 100vh;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  padding: 16px 18px 18px;
}

.ledger-tools-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ledger-tools-title {
  margin: 0;
  font-size: 18px;
}

.ledger-tools-subtitle {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 13px;
}

.ledger-tools-error {
  display: grid;
  gap: 12px;
  justify-items: start;
}

.ledger-tools-tabs {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.ledger-tools-tabs :deep(.el-tabs__content) {
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.tools-pane {
  display: grid;
  align-content: start;
  gap: 12px;
  padding-top: 4px;
}

.tools-pane-note {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}

.tools-reorder-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.tools-field-label {
  color: var(--app-muted);
  font-size: 13px;
}

.reorder-preview-panel {
  display: grid;
  gap: var(--app-space-2);
}

.reorder-project-preview {
  display: grid;
  gap: var(--app-space-1);
  border: 1px solid var(--app-border-light);
  border-radius: var(--app-radius-control);
  padding: var(--app-space-2) var(--app-space-3);
  font-size: 12px;
}

.reorder-project-preview span {
  overflow-wrap: anywhere;
}

.find-replace-mode-switch {
  display: flex;
  gap: var(--app-space-1);
}

.tools-two-column-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--app-space-4);
}

.ledger-find-navigation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--app-space-3);
}

.ledger-find-status {
  color: var(--app-muted);
  font-size: 13px;
}

.replace-preview-panel {
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-control);
  padding: var(--app-space-3);
  background: var(--app-surface-soft);
}

.replace-preview-panel ul {
  max-height: 180px;
  overflow: auto;
  margin: var(--app-space-2) 0 0;
  padding-left: var(--app-space-6);
}

.tools-find-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--app-space-2);
}

@media (max-width: 720px) {
  .tools-two-column-form {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
