<script setup lang="ts">
import { onMounted, onUnmounted, useId } from "vue";

const suggestionClass = `choice-suggestions-${useId().replace(/[^a-z0-9-]/gi, "")}`;
function keepSuggestionFocus(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest(`.${suggestionClass} li`)) {
    event.preventDefault();
  }
}
onMounted(() => document.addEventListener("mousedown", keepSuggestionFocus, true));
onUnmounted(() => document.removeEventListener("mousedown", keepSuggestionFocus, true));

interface ChoiceSuggestion {
  value: string;
}

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

let selectedValue: string | null = null;
function commitTyped(value: string): void {
  if (selectedValue === value) { selectedValue = null; return; }
  selectedValue = null;
  commit(value);
}

function update(value: string | number): void {
  selectedValue = null;
  emit("update:modelValue", String(value ?? ""));
}

function suggestions(
  query: string,
  callback: (items: ChoiceSuggestion[]) => void,
): void {
  const keyword = query.trim().toLocaleLowerCase();
  callback(
    props.options
      .filter((option) => !keyword || option.toLocaleLowerCase().includes(keyword))
      .map((value) => ({ value })),
  );
}

function selectSuggestion(item: ChoiceSuggestion): void {
  selectedValue = item.value;
  commit(item.value);
}
</script>

<template>
  <el-input
    v-if="readonly"
    class="editable-choice-input"
    :model-value="modelValue"
    readonly
    @paste="emit('paste', $event)"
  />
  <el-autocomplete
    v-else
    class="editable-choice-input"
    :model-value="modelValue"
    :fetch-suggestions="suggestions"
    :popper-class="suggestionClass"
    :debounce="0"
    value-key="value"
    clearable
    :placeholder="placeholder"
    @update:model-value="update"
    @change="commitTyped(String($event ?? ''))"
    @select="selectSuggestion"
    @paste="emit('paste', $event)"
  />
</template>

<style scoped>
.editable-choice-input {
  width: 100%;
  max-width: 100%;
}
</style>
