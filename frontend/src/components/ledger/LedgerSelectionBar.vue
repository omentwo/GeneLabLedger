<script setup lang="ts">
import { ArrowDown, Brush, Delete, Lock, Unlock } from "@lucide/vue";

/**
 * 台账批量操作条（P2-7）：纯展示组件。
 *
 * 选择范围 v-model；全部批量命令以 emit 意图上报，处理器
 * （含确认弹窗与批量写回）保留在视图。
 */
defineProps<{
  selectionScope: "all" | "unlocked";
  selectedCount: number;
  hasCellSelection: boolean;
  editing: boolean;
  highlightBusy: boolean;
  batchActive: boolean;
}>();

const emit = defineEmits<{
  "update:selectionScope": [value: "all" | "unlocked"];
  selectAll: [];
  invertSelection: [];
  highlight: [command: "set" | "clear"];
  status: [command: "已完成" | "待实验"];
  report: [command: "generated" | "pending"];
  lock: [command: "lock" | "unlock"];
  deleteSelected: [];
  clearSelection: [];
}>();
</script>

<template>
<section
      class="selection-bar"
      role="toolbar"
      aria-label="批量操作"
    >
      <el-select
        :model-value="selectionScope"
        @update:model-value="emit('update:selectionScope', $event)"
        class="record-selection-scope"
        aria-label="记录选择范围"
        size="small"
      >
        <el-option label="全部记录" value="all" />
        <el-option label="非锁定记录" value="unlocked" />
      </el-select>
      <div class="selection-quick-actions" aria-label="快速选择">
        <el-button size="small" @click="emit('selectAll')">全选</el-button>
        <el-button size="small" @click="emit('invertSelection')">反选</el-button>
      </div>
      <span class="selection-divider" aria-hidden="true" />
      <el-dropdown
        trigger="click"
        :disabled="editing || (selectedCount === 0 && !hasCellSelection)"
        @command="(command: string | number | object) => emit('highlight', command as 'set' | 'clear')"
      >
        <el-button
          size="small"
          :icon="Brush"
          :loading="highlightBusy"
          :disabled="editing || (selectedCount === 0 && !hasCellSelection)"
        >
          底色<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="set">设置底色</el-dropdown-item>
            <el-dropdown-item command="clear">清除底色</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        trigger="click"
        :disabled="selectedCount === 0"
        @command="(command: string | number | object) => emit('status', command as '已完成' | '待实验')"
      >
        <el-button size="small" :disabled="selectedCount === 0">
          状态<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="已完成">已完成</el-dropdown-item>
            <el-dropdown-item command="待实验">待实验</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        trigger="click"
        :disabled="selectedCount === 0"
        @command="(command: string | number | object) => emit('report', command as 'generated' | 'pending')"
      >
        <el-button size="small" :disabled="selectedCount === 0">
          报告状态<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="generated">已生成报告</el-dropdown-item>
            <el-dropdown-item command="pending">待生成报告</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        trigger="click"
        :disabled="selectedCount === 0"
        @command="(command: string | number | object) => emit('lock', command as 'lock' | 'unlock')"
      >
        <el-button size="small" :disabled="selectedCount === 0">
          锁定<ArrowDown :size="14" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="lock" :icon="Lock">锁定</el-dropdown-item>
            <el-dropdown-item command="unlock" :icon="Unlock">解锁</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button
        size="small"
        type="danger"
        plain
        :icon="Delete"
        :disabled="selectedCount === 0"
        @click="emit('deleteSelected')"
      >删除所选</el-button>
      <el-button
        class="selection-clear-button"
        size="small"
        text
        :disabled="!batchActive"
        @click="emit('clearSelection')"
      >
        取消选择
      </el-button>
</section>
</template>

<style scoped>
.selection-bar {
  display: flex;
  min-height: 46px;
  align-items: center;
  flex-wrap: nowrap;
  gap: var(--app-space-2);
  overflow-x: auto;
  border: 1px solid var(--app-primary-border);
  border-radius: var(--app-radius-card);
  background: var(--app-hover);
  padding: var(--app-space-1) var(--app-space-2);
  scrollbar-width: none;
}

.selection-bar::-webkit-scrollbar {
  display: none;
}

.record-selection-scope {
  width: 120px;
  flex: 0 0 120px;
}

.record-selection-scope :deep(.el-select__wrapper) {
  min-height: 32px;
  font-size: 14px;
}

.selection-quick-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--app-space-1);
}

.selection-quick-actions > :deep(.el-button + .el-button) {
  margin-left: 0;
}

.selection-bar :deep(.el-button) {
  min-height: 32px;
  font-size: 14px;
}

.selection-bar > :deep(.el-dropdown),
.selection-clear-button {
  flex: 0 0 auto;
}

.selection-bar :deep(.el-button > svg) {
  margin-left: var(--app-space-1);
}

.selection-bar :deep(.el-button + .el-button) {
  margin-left: 0;
}

.selection-bar > * {
  flex-shrink: 0;
}

.selection-divider {
  width: 1px;
  height: 20px;
  flex: 0 0 1px;
  background: var(--app-border);
}
</style>
