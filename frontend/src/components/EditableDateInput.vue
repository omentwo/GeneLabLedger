<script setup lang="ts">
import { Calendar } from "@lucide/vue";
import { ref } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    readonly?: boolean;
    placeholder?: string;
  }>(),
  {
    readonly: false,
    placeholder: "例如：2026-07-27",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
  paste: [event: ClipboardEvent];
}>();

const picker = ref<HTMLInputElement>();

function openPicker(): void {
  if (props.readonly || !picker.value) return;
  const input = picker.value as HTMLInputElement & { showPicker?: () => void };
  try {
    if (input.showPicker) input.showPicker();
    else input.click();
  } catch {
    input.click();
  }
}

function applyPicker(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  emit("update:modelValue", value);
  emit("change", value);
}
</script>

<template>
  <div class="editable-date-input">
    <el-input
      :model-value="modelValue"
      :readonly="readonly"
      :placeholder="placeholder"
      @update:model-value="emit('update:modelValue', String($event))"
      @change="emit('change', String($event))"
      @paste="emit('paste', $event)"
    >
      <template #suffix>
        <button
          v-if="!readonly"
          class="date-trigger"
          type="button"
          aria-label="选择日期"
          title="选择日期"
          @click.prevent="openPicker"
        >
          <Calendar :size="16" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </template>
    </el-input>
    <input
      ref="picker"
      class="native-date-picker"
      type="date"
      :value="modelValue"
      tabindex="-1"
      aria-hidden="true"
      @change="applyPicker"
    />
  </div>
</template>

<style scoped>
.editable-date-input {
  position: relative;
  width: 100%;
}

.date-trigger {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  color: var(--app-muted);
  background: transparent;
  cursor: pointer;
}

.date-trigger:hover {
  color: var(--app-primary-text);
  background: var(--app-primary-soft);
}

.native-date-picker {
  position: absolute;
  right: 8px;
  bottom: 2px;
  width: 1px;
  height: 1px;
  border: 0;
  opacity: 0;
  pointer-events: none;
}
</style>
