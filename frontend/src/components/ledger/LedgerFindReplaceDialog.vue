<script setup lang="ts">
import type { FieldDefinition, RecordReplacePreview } from "@/types/api";
import type { FindReplaceMode } from "@/composables/useLedgerFindReplace";

/**
 * 台账查找替换对话框（P2-3b）：纯展示组件。
 *
 * 表单值经 5 个 v-model 与父级（useLedgerFindReplace 的 reactive 表单）
 * 双向同步；输入框实例通过 inputRef prop 回写，供 composable 聚焦。
 */
const props = defineProps<{
  visible: boolean;
  loading: boolean;
  mode: FindReplaceMode;
  fieldId: string;
  find: string;
  replacement: string;
  matchMode: "substring" | "whole";
  caseSensitive: boolean;
  fields: FieldDefinition[];
  totalRecords: number;
  scopeLabel: string;
  scopeCount: number | null;
  preview: RecordReplacePreview | null;
  matchStatus: string;
  matchCount: number;
  recordLimit: number;
  /** 输入框实例注册回调：回写 composable 持有的 ref（模板会解包 ref，不能直接传）。 */
  registerInput: (element: { focus: () => void } | null) => void;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  "update:fieldId": [value: string];
  "update:find": [value: string];
  "update:replacement": [value: string];
  "update:matchMode": [value: "substring" | "whole"];
  "update:caseSensitive": [value: boolean];
  setMode: [mode: FindReplaceMode];
  opened: [];
  closed: [];
  enter: [event: KeyboardEvent];
  navigate: [direction: -1 | 1];
  preview: [];
  commit: [];
}>();

function assignInputRef(element: unknown): void {
  props.registerInput(element as { focus: () => void } | null);
}
</script>

<template>
  <el-dialog class="ledger-dialog" :model-value="visible"
   @update:model-value="emit('update:visible', $event)" title="查找替换" width="660px"
   :modal="false" :lock-scroll="false"
   :close-on-click-modal="!loading" :close-on-press-escape="!loading" :show-close="!loading" @opened="emit('opened')" @closed="emit('closed')">
    <div class="find-replace-mode-switch" role="group" aria-label="查找模式">
      <el-button
        size="small"
        :type="mode === 'find' ? 'primary' : undefined"
        :aria-pressed="mode === 'find'"
        @click="emit('setMode', 'find')"
      >查找</el-button>
      <el-button
        size="small"
        :type="mode === 'replace' ? 'primary' : undefined"
        :aria-pressed="mode === 'replace'"
        @click="emit('setMode', 'replace')"
      >替换</el-button>
    </div>
    <p class="muted" v-if="mode === 'find'">
      在当前台账的筛选结果中查找，共 {{ totalRecords.toLocaleString('zh-CN') }} 条记录。Enter 查找下一个，Shift+Enter 查找上一个。
    </p>
    <p class="muted" v-else>
      {{ scopeLabel }}；单次最多 {{ recordLimit.toLocaleString('zh-CN') }} 条记录。
    </p>
    <el-form label-position="top" :disabled="loading">
      <el-form-item :label="mode === 'find' ? '查找表头' : '指定表头'">
        <el-select :model-value="fieldId"
          @update:model-value="emit('update:fieldId', $event)" filterable>
          <el-option v-if="mode === 'find'" label="全部表头" value="" />
          <el-option v-for="field in fields" :key="field.id" :label="field.label" :value="field.id" />
        </el-select>
      </el-form-item>
      <div :class="{ 'two-column-dialog-form': mode === 'replace' }">
        <el-form-item label="查找内容">
          <el-input
            :ref="assignInputRef"
            :model-value="find"
            @update:model-value="emit('update:find', $event)"
            clearable
            aria-label="查找内容"
            @keydown.enter="emit('enter', $event)"
          />
        </el-form-item>
        <el-form-item v-if="mode === 'replace'" label="替换为">
          <el-input :model-value="replacement"
          @update:model-value="emit('update:replacement', $event)" />
        </el-form-item>
      </div>
      <div class="two-column-dialog-form">
        <el-form-item label="匹配方式">
          <el-radio-group :model-value="matchMode"
            @update:model-value="emit('update:matchMode', $event)">
            <el-radio-button value="substring">子串</el-radio-button>
            <el-radio-button value="whole">完整单元格</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="大小写">
          <el-checkbox :model-value="caseSensitive"
          @update:model-value="emit('update:caseSensitive', $event)">区分大小写</el-checkbox>
        </el-form-item>
      </div>
    </el-form>
    <div v-if="mode === 'find'" class="ledger-find-navigation">
      <span class="ledger-find-status" role="status" aria-live="polite">{{ matchStatus }}</span>
      <div>
        <el-button :disabled="matchCount === 0" @click="emit('navigate', -1)">上一个</el-button>
        <el-button type="primary" :disabled="matchCount === 0" @click="emit('navigate', 1)">
          下一个
        </el-button>
      </div>
    </div>
    <div v-else-if="scopeCount !== null" class="replace-preview-panel" aria-live="polite">
      <strong>范围 {{ scopeCount.toLocaleString('zh-CN') }} 条记录</strong>
      <template v-if="preview">
        <span>，可替换 {{ preview.matched_count }} 个单元格</span>
        <span>，锁定跳过 {{ preview.skipped_locked }} 个单元格</span>
      </template>
      <p v-if="scopeCount > recordLimit" role="alert">范围超过单次上限，请缩小筛选或选中范围后重试；本次未执行替换。</p>
      <ul v-if="preview?.issues.length">
        <li v-for="(issue, index) in preview.issues.slice(0, 20)" :key="index">
          {{ issue.message }}
        </li>
      </ul>
    </div>
    <template #footer>
      <el-button :disabled="loading" @click="emit('update:visible', false)">取消</el-button>
      <template v-if="mode === 'replace'">
        <el-button :loading="loading" @click="emit('preview')">预览</el-button>
        <el-button
          type="primary"
          :loading="loading"
          :disabled="!preview?.matched_count || preview.issues.some((issue) => issue.severity === 'error')"
          @click="emit('commit')"
        >
          确认替换
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.two-column-dialog-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--app-space-4);
}

.replace-preview-panel {
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-control);
  padding: var(--app-space-3);
  background: var(--app-surface-soft);
}

.find-replace-mode-switch {
  display: flex;
  gap: var(--app-space-1);
  margin-bottom: var(--app-space-3);
}

.ledger-find-navigation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--app-space-3);
  margin-top: var(--app-space-2);
}

.ledger-find-status {
  color: var(--app-muted);
  font-size: 13px;
}

.replace-preview-panel ul {
  max-height: 150px;
  overflow: auto;
  margin: var(--app-space-2) 0 0;
  padding-left: var(--app-space-6);
}
</style>
