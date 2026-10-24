<script setup lang="ts">
import type { ValidationPanelState } from "@/composables/useLedgerValidationPanel";

/**
 * 台账校验确认对话框（P2-2）：纯展示组件。
 *
 * 与 useLedgerValidationPanel 的接口契约：面板状态经 props 传入，
 * “继续 / 取消”以 emit 上报，由调用方分发给 continueValidationCommit /
 * cancelValidationPanel——对话框不反向依赖面板模块（P2-2 循环依赖解法）。
 */
defineProps<{
  panel: ValidationPanelState | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <el-dialog
    v-if="panel"
    :model-value="true"
    class="ledger-dialog ledger-validation-dialog"
    :title="panel.title"
    width="620px"
    align-center
    append-to-body
    destroy-on-close
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    role="alertdialog"
    aria-modal="true"
    aria-describedby="ledger-validation-description"
  >
    <div id="ledger-validation-description" class="validation-dialog-content">
      <div class="validation-dialog-summary">
        <strong>{{ panel.label }}</strong>
        <span>影响 {{ panel.affectedCount }} 个单元格</span>
        <span v-if="panel.skippedLocked">，跳过锁定 {{ panel.skippedLocked }} 个</span>
      </div>
      <ul class="validation-dialog-issues">
        <li
          v-for="(issue, index) in panel.issues.slice(0, 20)"
          :key="index"
          :class="`is-${issue.severity}`"
        >
          {{ issue.message }}
        </li>
      </ul>
      <p v-if="panel.outcomeText" class="validation-dialog-outcome">
        {{ panel.outcomeText }}
      </p>
    </div>
    <template #footer>
      <el-button :disabled="loading" @click="emit('cancel')">
        {{ panel.cancelText }}
      </el-button>
      <el-button
        v-if="panel.canContinue"
        type="primary"
        :loading="loading"
        @click="emit('confirm')"
      >
        {{ panel.continueText }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.validation-dialog-content {
  display: grid;
  gap: var(--app-space-3);
}

.validation-dialog-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--app-space-2) var(--app-space-3);
  align-items: baseline;
}

.validation-dialog-summary strong {
  color: var(--app-text);
  font-size: 15px;
}

.validation-dialog-summary span {
  color: var(--app-muted);
  font-size: 13px;
}

.validation-dialog-issues {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  border: 1px solid var(--app-warning);
  border-radius: var(--app-radius-control);
  padding: var(--app-space-3) var(--app-space-3) var(--app-space-3) var(--app-space-8);
  background: var(--app-warning-soft);
}

.validation-dialog-issues li.is-error {
  color: var(--app-danger-text);
}

.validation-dialog-issues li.is-warning {
  color: var(--app-warning-text);
  font-weight: 600;
}

.validation-dialog-outcome {
  margin: 0;
  border-left: 3px solid var(--app-warning);
  padding: var(--app-space-2) var(--app-space-2);
  background: var(--app-warning-soft);
  color: var(--app-text);
  line-height: 1.6;
}
</style>
