<script setup lang="ts">
import { Download } from "@lucide/vue";

import EditableDateInput from "@/components/EditableDateInput.vue";

/**
 * 台账导出面板（P2-6）：纯展示组件。
 *
 * visible/start/end 全部 v-model 双向，导出动作以 emit 上报——
 * `exportCurrentProject` 依赖查询构建与字段序列化，保留在视图。
 * `.field-label` 是视图内多处置用的共享类，这里按同值复制一份。
 */
defineProps<{
  visible: boolean;
  start: string;
  end: string;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  "update:start": [value: string];
  "update:end": [value: string];
  export: [];
}>();
</script>

<template>
  <section v-if="visible" class="page-card export-panel">
    <div class="page-card-header">
      <div>
        <h2 class="page-card-title">导出当前项目台账</h2>
        <p class="page-description">
          导出当前项目台账；可按实验日期指定导出范围。
        </p>
      </div>
      <el-button text @click="emit('update:visible', false)">收起</el-button>
    </div>
    <div class="page-card-body toolbar">
      <span class="field-label">开始日期</span>
      <EditableDateInput
        :model-value="start"
        class="export-date"
        @update:model-value="emit('update:start', $event)"
      />
      <span class="field-label">结束日期</span>
      <EditableDateInput
        :model-value="end"
        class="export-date"
        @update:model-value="emit('update:end', $event)"
      />
      <el-tag effect="plain">.xlsx</el-tag>
      <el-button type="primary" :icon="Download" @click="emit('export')">
        确认导出
      </el-button>
    </div>
  </section>
</template>

<style scoped>
.export-panel {
  border-color: var(--app-primary-border);
}

.field-label {
  color: var(--app-muted);
  font-size: 12px;
}

.export-date {
  width: 190px;
}
</style>
