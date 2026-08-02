<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: string[];
    readonly?: boolean;
    placeholder?: string;
  }>(),
  {
    readonly: false,
    placeholder: "可输入或选择",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
  paste: [event: ClipboardEvent];
}>();

function commit(value: string): void {
  emit("update:modelValue", value);
  emit("change", value);
}
</script>

<template>
  <el-input
    v-if="readonly"
    :model-value="modelValue"
    readonly
    @paste="emit('paste', $event)"
  />
  <el-select
    v-else
    :model-value="modelValue"
    filterable
    allow-create
    default-first-option
    clearable
    :placeholder="placeholder"
    @change="commit(String($event ?? ''))"
    @paste="emit('paste', $event)"
  >
    <el-option
      v-for="option in props.options"
      :key="option"
      :label="option"
      :value="option"
    />
  </el-select>
</template>
