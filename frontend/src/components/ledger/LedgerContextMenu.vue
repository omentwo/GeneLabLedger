<script setup lang="ts">
import { computed, type CSSProperties } from "vue";
import { ArrowRight } from "@lucide/vue";

/**
 * 台账右键菜单（P2-1）：纯展示组件。
 *
 * 状态与派生判断（选中数、锁定、加载中）全部由父级以 props 传入，
 * 动作以 emit 意图上报；插入行数经 v-model 与父级双向同步，
 * 保持“跨菜单打开仍记住上次数值”的既有行为。
 */
export type LedgerContextMenuTarget = {
  kind: "cell" | "row";
  rowId: string;
  fieldId?: string;
};
export type LedgerContextMenuState = {
  x: number;
  y: number;
  submenuLeft: boolean;
  target: LedgerContextMenuTarget;
};

const props = defineProps<{
  menu: LedgerContextMenuState | null;
  canCut: boolean;
  canDeleteCells: boolean;
  busy: boolean;
  deleteRecordCount: number;
  deleteRecordLocked: boolean;
  insertRowCount: number | "";
}>();

const emit = defineEmits<{
  cut: [];
  copy: [];
  deleteCells: [];
  deleteRecord: [];
  insertRows: [placement: "before" | "after"];
  "update:insertRowCount": [value: number | ""];
}>();

const menuStyle = computed<CSSProperties>(() => ({
  left: `${props.menu?.x ?? 0}px`,
  top: `${props.menu?.y ?? 0}px`,
}));
</script>

<template>
  <div
    v-if="menu"
    class="ledger-context-menu"
    :style="menuStyle"
    role="menu"
    @pointerdown.stop
    @click.stop
    @contextmenu.prevent
  >
    <button
      type="button"
      role="menuitem"
      :disabled="!canCut"
      class="ledger-context-menu-shortcut-item"
      title="剪切选中单元格（Ctrl+X / Cmd+X）"
      aria-keyshortcuts="Control+X Meta+X"
      @click="emit('cut')"
    >
      <span>剪切</span><kbd>Ctrl+X</kbd>
    </button>
    <button type="button" role="menuitem" class="ledger-context-menu-shortcut-item" @click="emit('copy')">
      <span>复制</span><kbd>Ctrl+C</kbd>
    </button>
    <button
      type="button"
      role="menuitem"
      :disabled="!canDeleteCells"
      @click="emit('deleteCells')"
    >
      删除
    </button>
    <div class="ledger-context-menu-submenu">
      <button
        type="button"
        class="ledger-context-menu-submenu-trigger"
        role="menuitem"
        aria-haspopup="menu"
      >
        <span>插入行</span>
        <ArrowRight :size="14" aria-hidden="true" />
      </button>
      <div
        class="ledger-context-menu-submenu-panel"
        :class="{ 'opens-left': menu.submenuLeft }"
        role="group"
        aria-label="插入行设置"
      >
        <label class="ledger-context-menu-insert-count">
          <span>插入行数</span>
          <input
            :value="insertRowCount"
            type="number"
            min="1"
            max="100"
            step="1"
            inputmode="numeric"
            aria-label="插入行数，范围 1 到 100"
            @click.stop
            @input="emit('update:insertRowCount', ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))"
            @keydown.enter.stop.prevent="emit('insertRows', 'before')"
          />
        </label>
        <button type="button" role="menuitem" @click="emit('insertRows', 'before')">
          在上方插入
        </button>
        <button type="button" role="menuitem" @click="emit('insertRows', 'after')">
          在下方插入
        </button>
      </div>
    </div>
    <div class="ledger-context-menu-separator" role="separator"></div>
    <button
      type="button"
      class="ledger-context-menu-danger"
      role="menuitem"
      :disabled="busy"
      :title="deleteRecordCount > 1
        ? `永久删除选中的 ${deleteRecordCount} 条记录`
        : deleteRecordLocked
          ? '当前记录已锁定，请先解锁后再删除'
          : '永久删除当前记录'"
      @click="emit('deleteRecord')"
    >
      {{ deleteRecordCount > 1
        ? '删除所选记录'
        : '删除记录' }}
    </button>
  </div>
</template>

<style scoped>
.ledger-context-menu button:focus-visible {
  outline: 2px solid var(--app-primary);
  outline-offset: -2px;
  background: var(--app-primary-soft);
}

.ledger-context-menu {
  width: 160px;
  overflow: visible;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-card);
  background: var(--app-bg);
  box-shadow: 0 8px 26px rgb(45 42 38 / 10%);
  padding: var(--app-space-1);
}

.ledger-context-menu button {
  display: block;
  width: 100%;
  border: 0;
  border-radius: var(--app-radius-control);
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
  font: inherit;
  padding: var(--app-space-2) var(--app-space-2);
  text-align: left;
}

.ledger-context-menu button:hover:not(:disabled) {
  background: var(--app-primary-soft);
  color: var(--app-primary-text);
}

.ledger-context-menu button:disabled {
  color: var(--app-disabled);
  cursor: not-allowed;
}

.ledger-context-menu .ledger-context-menu-shortcut-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ledger-context-menu-shortcut-item kbd {
  color: var(--app-muted);
  font-family: inherit;
  font-size: 11px;
}

.ledger-context-menu-separator {
  height: 1px;
  margin: var(--app-space-1) var(--app-space-1);
  background: var(--app-border);
}

.ledger-context-menu button.ledger-context-menu-danger:not(:disabled) {
  color: var(--el-color-danger);
}

.ledger-context-menu button.ledger-context-menu-danger:hover:not(:disabled) {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.ledger-context-menu-submenu {
  position: relative;
}

.ledger-context-menu .ledger-context-menu-submenu-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ledger-context-menu-submenu-panel {
  position: absolute;
  z-index: 1;
  bottom: -5px;
  left: calc(100% - 4px);
  display: none;
  width: 200px;
  box-sizing: border-box;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-card);
  background: var(--app-bg);
  box-shadow: 0 8px 26px rgb(45 42 38 / 10%);
  padding: var(--app-space-1);
  transform-origin: top left;
  animation: ledger-overlay-pop-in 0.16s ease;
}

.ledger-context-menu-submenu-panel.opens-left {
  right: calc(100% - 4px);
  left: auto;
  transform-origin: top right;
}

@keyframes ledger-overlay-pop-in {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
}

.ledger-context-menu-insert-count {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--app-space-2);
  color: var(--app-muted);
  font-size: 13px;
  padding: var(--app-space-1) var(--app-space-2) var(--app-space-2);
  white-space: nowrap;
}

.ledger-context-menu-insert-count input {
  box-sizing: border-box;
  width: 72px;
  height: 28px;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-control);
  outline: 0;
  background: var(--app-bg);
  color: var(--app-text);
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0 var(--app-space-1);
  text-align: center;
}

.ledger-context-menu-insert-count input:focus {
  border-color: var(--app-primary);
  box-shadow: 0 0 0 2px var(--app-primary-soft);
}

.ledger-context-menu-submenu:hover > .ledger-context-menu-submenu-panel,
.ledger-context-menu-submenu:focus-within > .ledger-context-menu-submenu-panel {
  display: block;
}
</style>
