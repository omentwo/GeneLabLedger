<script setup lang="ts">
import type { RecordReorderByDatePreview } from "@/types/api";

/**
 * 台账“按实验日期重排”对话框（P2-5）：纯展示组件。
 *
 * 全部状态（visible/date/preview/loading）由父级持有——loading 同时
 * 参与关闭守卫，属跨区块共享状态。动作以 emit 上报：
 * preview → 加载预览，confirm → 确认重排，changed → 日期变化清除预览。
 */
defineProps<{
  visible: boolean;
  date: string;
  preview: RecordReorderByDatePreview | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  "update:date": [value: string];
  changed: [];
  preview: [];
  confirm: [];
}>();
</script>

<template>
  <el-dialog
    class="ledger-dialog"
    :model-value="visible"
    title="按实验日期重排台账"
    width="680px"
    @update:model-value="emit('update:visible', $event)"
  >
    <p class="dialog-note">
      仅重排当前项目中所选日期的记录，并按“病理号-蜡块号”的实验编排规则排序；其他日期记录的位置保持不变。
    </p>
    <el-form label-position="top">
      <el-form-item label="实验日期">
        <el-date-picker
          :model-value="date"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="选择日期"
          @update:model-value="emit('update:date', String($event ?? ''))"
          @change="emit('changed')"
        />
      </el-form-item>
    </el-form>
    <div v-if="preview" class="reorder-preview-panel">
      <strong>
        当前项目共 {{ preview.affected_records }} 条记录，
        将调整 {{ preview.changed_records }} 条
      </strong>
      <el-alert
        v-if="preview.locked_records.length"
        type="error"
        :closable="false"
        :title="`有 ${preview.locked_records.length} 条锁定记录，请先解锁`"
      />
      <div v-for="project in preview.projects" :key="project.project_id" class="reorder-project-preview">
        <b>{{ project.project_name }}（调整 {{ project.changed_count }} 条）</b>
        <span>调整前：{{ project.before.join('、') || '无' }}</span>
        <span>调整后：{{ project.after.join('、') || '无' }}</span>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button :loading="loading" @click="emit('preview')">预览</el-button>
      <el-button
        type="primary"
        :loading="loading"
        :disabled="!preview || Boolean(preview.locked_records.length) || !preview.changed_records"
        @click="emit('confirm')"
      >
        确认重排
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
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
</style>
