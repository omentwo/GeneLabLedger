<script setup lang="ts">
import { computed } from "vue";
import { Download, Plus, Redo2, Settings2 as Setting, Undo2 } from "@lucide/vue";

import type { PrintEngine } from "@/types/api";

/**
 * 台账命令卡（P2-8）：撤销/新增/快速录入/导出/更多菜单（重排、查找替换、
 * 排序筛选、最佳列宽、项目表头、Excel/WPS 打开、显示范围）。
 *
 * 单元格编辑栏经默认插槽注入——它属于编辑机制而非命令，保留在视图。
 * “更多”弹层的 popper 样式是全局规则（挂在 body 下），留在视图。
 */
const props = defineProps<{
  canUndo: boolean;
  canRedo: boolean;
  historyBusy: boolean;
  showLocked: boolean;
  moreVisible: boolean;
  columnToolsOpen: boolean;
  hasCellSelection: boolean;
  busy: boolean;
  nativePreviewLoading: boolean;
  nativePreviewAvailable: boolean;
  wordAvailable: boolean;
  wpsAvailable: boolean;
  engineLabel: string;
  previewEngine: PrintEngine;
  previewScope: string;
  rangeMode: string;
  rangeMonths: number;
  rangeCount: number;
  rangeIncludeUndated: boolean;
  rangeIncludeFuture: boolean;
  monthsMax: number;
  countMax: number;
  rangeDates: string;
  rangeSaving: boolean;
}>();

const emit = defineEmits<{
  "update:showLocked": [value: boolean];
  "update:moreVisible": [value: boolean];
  "update:previewEngine": [value: PrintEngine];
  "update:previewScope": [value: string];
  "update:rangeMode": [value: string];
  "update:rangeMonths": [value: number];
  "update:rangeCount": [value: number];
  "update:rangeIncludeUndated": [value: boolean];
  "update:rangeIncludeFuture": [value: boolean];
  undo: [];
  redo: [];
  addRecord: [];
  openQuickEntry: [];
  lockedVisibilityChange: [];
  toggleExport: [];
  reorder: [];
  findReplace: [];
  toggleColumnTools: [];
  bestFitAll: [];
  manageProjects: [];
  savePreviewEngine: [];
  openNative: [];
  saveRange: [];
}>();

const currentEngineAvailable = computed(() => {
  if (props.previewEngine === "word") return props.wordAvailable;
  if (props.previewEngine === "wps") return props.wpsAvailable;
  return props.nativePreviewAvailable;
});
</script>

<template>
    <section class="page-card ledger-command-card">
      <header class="ledger-workspace-heading" aria-label="台账工具栏">
        <div class="ledger-workspace-actions" role="toolbar" aria-label="台账常用操作">
          <el-button
            class="ledger-history-button"
            size="small"
            :icon="Undo2"
            text
            :disabled="!canUndo"
            :loading="historyBusy"
            title="撤销"
            @click="emit('undo')"
          >撤销</el-button>
          <el-button
            class="ledger-history-button"
            size="small"
            :icon="Redo2"
            text
            :disabled="!canRedo"
            :loading="historyBusy"
            title="恢复"
            @click="emit('redo')"
          >恢复</el-button>
          <span class="ledger-toolbar-divider" aria-hidden="true" />
          <el-button size="small" :icon="Plus" type="primary" plain @click="emit('addRecord')">
            新增记录
          </el-button>
          <el-button size="small" :icon="Plus" @click="emit('openQuickEntry')">快速录入</el-button>
        </div>
        <slot />
        <el-checkbox
          :model-value="showLocked"
          @update:model-value="emit('update:showLocked', $event)"
          class="ledger-locked-visibility"
          @change="emit('lockedVisibilityChange')"
        >显示锁定记录</el-checkbox>
        <div class="ledger-workspace-actions" role="toolbar" aria-label="台账导出与更多操作">
          <el-button size="small" :icon="Download" @click="emit('toggleExport')">
            导出 Excel
          </el-button>
          <el-popover
            :visible="moreVisible"
            @update:visible="emit('update:moreVisible', $event)"
            placement="bottom-end"
            :width="380"
            trigger="click"
            popper-class="ledger-toolbar-popover"
          >
            <template #reference>
              <el-button size="small" :icon="Setting" data-toolbar-action="more">更多</el-button>
            </template>
            <div class="ledger-popover-section">
              <strong class="ledger-popover-title">数据与视图</strong>
              <div class="ledger-popover-action-grid">
                <el-button @click="emit('reorder')">按日期重排</el-button>
                <el-button @click="emit('findReplace')">查找替换</el-button>
                <el-button
                  :icon="Setting"
                  :type="columnToolsOpen ? 'primary' : undefined"
                  @click="emit('toggleColumnTools')"
                >排序/筛选</el-button>
                <el-button @click="emit('bestFitAll')">最佳列宽</el-button>
                <el-button
                  :icon="Setting"
                  class="ledger-manage-project-action"
                  @click="emit('manageProjects')"
                >管理项目与表头</el-button>
              </div>
            </div>
            <div class="ledger-popover-section ledger-native-open-section">
              <strong class="ledger-popover-title">使用 Excel/WPS 打开</strong>
              <div class="ledger-native-open-options">
                <label>
                  <span>打开方式</span>
                  <el-select
                    :model-value="previewEngine"
                    @update:model-value="emit('update:previewEngine', $event)"
                    class="ledger-preview-engine"
                    aria-label="打开方式"
                    @change="emit('savePreviewEngine')"
                  >
                    <el-option label="自动选择" value="auto" />
                    <el-option label="Microsoft Excel" value="word" :disabled="!wordAvailable" />
                    <el-option label="WPS" value="wps" :disabled="!wpsAvailable" />
                  </el-select>
                </label>
                <label>
                  <span>打开范围</span>
                  <el-select :model-value="previewScope"
                  @update:model-value="emit('update:previewScope', $event)" class="ledger-preview-scope" aria-label="打开范围">
                    <el-option label="当前选区" value="selection" :disabled="!hasCellSelection" />
                    <el-option label="当前台账" value="project" />
                    <el-option label="整本台账" value="all" />
                  </el-select>
                </label>
              </div>
              <el-button
                class="ledger-native-open-button"
                type="primary"
                plain
                :loading="nativePreviewLoading"
                :disabled="!currentEngineAvailable"
                @click="emit('openNative')"
              >使用 {{ engineLabel }} 打开</el-button>
            </div>
            <div class="ledger-popover-section">
              <strong class="ledger-popover-title">记录显示范围</strong>
              <el-radio-group :model-value="rangeMode"
              @update:model-value="emit('update:rangeMode', $event)" aria-label="记录显示范围" :disabled="rangeSaving">
                <el-radio value="all">全部显示</el-radio>
                <el-radio value="months">近几个月</el-radio>
                <el-radio value="count">末尾几条</el-radio>
              </el-radio-group>
              <template v-if="rangeMode === 'months'">
                <label class="ledger-range-input">
                  <span>近几个月</span>
                  <el-input-number
                    :model-value="rangeMonths"
                    @update:model-value="emit('update:rangeMonths', $event)"
                    :min="1" :max="monthsMax" :precision="0"
                    :disabled="rangeSaving" controls-position="right" aria-label="显示月数"
                  />
                </label>
                <p class="page-description">按台账“日期”：{{ rangeDates }}</p>
                <el-checkbox :model-value="rangeIncludeUndated"
                  @update:model-value="emit('update:rangeIncludeUndated', $event)" :disabled="rangeSaving">
                  包含日期为空的记录
                </el-checkbox>
                <el-checkbox :model-value="rangeIncludeFuture"
                  @update:model-value="emit('update:rangeIncludeFuture', $event)" :disabled="rangeSaving">
                  包含未来日期的记录
                </el-checkbox>
                <p v-if="!rangeIncludeFuture" class="page-description">
                  关闭后，日期晚于今天的记录会被移出当前视图。
                </p>
              </template>
              <template v-else-if="rangeMode === 'count'">
                <label class="ledger-range-input">
                  <span>显示条数</span>
                  <el-input-number
                    :model-value="rangeCount"
                  @update:model-value="emit('update:rangeCount', $event)"
                    :min="1" :max="countMax" :precision="0"
                    :disabled="rangeSaving" controls-position="right" aria-label="显示条数"
                  />
                </label>
                <p class="page-description">按当前排序，从台账底部向上取记录，保留原显示顺序。</p>
              </template>
              <el-button type="primary" plain :loading="rangeSaving" :disabled="busy" @click="emit('saveRange')">
                保存显示范围
              </el-button>
            </div>
          </el-popover>
        </div>
      </header>
    </section>
</template>

<style scoped>
.ledger-range-input {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 0;
}

.ledger-workspace-heading {
  box-sizing: border-box;
  display: flex;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  gap: var(--app-space-2);
  overflow-x: auto;
  padding: var(--app-space-2) var(--app-space-2);
  scrollbar-width: thin;
}

.ledger-workspace-heading::-webkit-scrollbar {
  height: 4px;
}

.ledger-workspace-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--app-space-1);
  white-space: nowrap;
}

.ledger-workspace-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.ledger-workspace-actions :deep(.el-button) {
  min-height: 32px;
  flex: 0 0 auto;
  font-size: 14px;
}

.ledger-locked-visibility {
  flex: 0 0 auto;
  margin-right: 0;
  white-space: nowrap;
}

.ledger-locked-visibility :deep(.el-checkbox__label) {
  padding-left: var(--app-space-1);
  font-size: 14px;
}

.ledger-history-button {
  width: auto;
  min-width: 58px;
}
</style>
