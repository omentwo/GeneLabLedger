<script setup lang="ts">
import { Check } from "@lucide/vue";



export type HighlightMode = "record" | "cell";

/**
 * 台账底色对话框（P2-4）：纯展示组件。
 *
 * Excel 风格调色板是本对话框独有数据，随组件下沉；选中态由 color
 * prop 派生。提交/清除以 emit 上报，目标收集与批量写回
 * （submitHighlight/clearHighlight）保留在视图。
 */
type HighlightColorOption = { label: string; color: string };

const highlightThemeRows: HighlightColorOption[][] = [
  [
    { label: "白色", color: "#FFFFFF" },
    { label: "黑色", color: "#000000" },
    { label: "浅灰", color: "#E7E6E6" },
    { label: "深蓝灰", color: "#44546A" },
    { label: "蓝色", color: "#4472C4" },
    { label: "橙色", color: "#ED7D31" },
    { label: "灰色", color: "#A5A5A5" },
    { label: "黄色", color: "#FFC000" },
    { label: "浅蓝", color: "#5B9BD5" },
    { label: "绿色", color: "#70AD47" },
  ],
  [
    { label: "白色 80%", color: "#F2F2F2" },
    { label: "黑色 50%", color: "#7F7F7F" },
    { label: "浅灰蓝 80%", color: "#D9E1F2" },
    { label: "深蓝灰 80%", color: "#D6E4F0" },
    { label: "蓝色 80%", color: "#D9E2F3" },
    { label: "橙色 80%", color: "#FCE4D6" },
    { label: "灰色 80%", color: "#EDEDED" },
    { label: "黄色 80%", color: "#FFF2CC" },
    { label: "浅蓝 80%", color: "#DDEBF7" },
    { label: "绿色 80%", color: "#E2F0D9" },
  ],
  [
    { label: "白色 60%", color: "#E7E6E6" },
    { label: "黑色 35%", color: "#595959" },
    { label: "浅灰蓝 60%", color: "#B4C6E7" },
    { label: "深蓝灰 60%", color: "#B4C6E7" },
    { label: "蓝色 60%", color: "#B4C6E7" },
    { label: "橙色 60%", color: "#F8CBAD" },
    { label: "灰色 60%", color: "#D9D9D9" },
    { label: "黄色 60%", color: "#FFE699" },
    { label: "浅蓝 60%", color: "#BDD7EE" },
    { label: "绿色 60%", color: "#C6E0B4" },
  ],
  [
    { label: "白色 40%", color: "#D9D9D9" },
    { label: "黑色 25%", color: "#404040" },
    { label: "浅灰蓝 40%", color: "#8EA9DB" },
    { label: "深蓝灰 40%", color: "#8EA9DB" },
    { label: "蓝色 40%", color: "#8EA9DB" },
    { label: "橙色 40%", color: "#F4B183" },
    { label: "灰色 40%", color: "#A6A6A6" },
    { label: "黄色 40%", color: "#FFD966" },
    { label: "浅蓝 40%", color: "#9DC3E6" },
    { label: "绿色 40%", color: "#A9D18E" },
  ],
  [
    { label: "白色 20%", color: "#BFBFBF" },
    { label: "黑色 15%", color: "#262626" },
    { label: "浅灰蓝 20%", color: "#5B9BD5" },
    { label: "深蓝灰 20%", color: "#5B9BD5" },
    { label: "蓝色 20%", color: "#4472C4" },
    { label: "橙色 20%", color: "#C65911" },
    { label: "灰色 20%", color: "#7F7F7F" },
    { label: "黄色 20%", color: "#BF9000" },
    { label: "浅蓝 20%", color: "#2F75B5" },
    { label: "绿色 20%", color: "#548235" },
  ],
  [
    { label: "白色 0%", color: "#7F7F7F" },
    { label: "黑色", color: "#000000" },
    { label: "浅灰蓝", color: "#44546A" },
    { label: "深蓝灰", color: "#2F5597" },
    { label: "蓝色", color: "#2F5597" },
    { label: "橙色", color: "#843C0C" },
    { label: "灰色", color: "#595959" },
    { label: "黄色", color: "#806000" },
    { label: "浅蓝", color: "#1F4E79" },
    { label: "绿色", color: "#375623" },
  ],
];

const highlightStandardColors: HighlightColorOption[] = [
  { label: "深红", color: "#C00000" },
  { label: "红色", color: "#FF0000" },
  { label: "橙色", color: "#FFC000" },
  { label: "黄色", color: "#FFFF00" },
  { label: "浅绿", color: "#92D050" },
  { label: "绿色", color: "#00B050" },
  { label: "青色", color: "#00B0F0" },
  { label: "蓝色", color: "#0070C0" },
  { label: "深蓝", color: "#002060" },
  { label: "紫色", color: "#7030A0" },
];

const highlightPalette = [
  ...new Set(
    [...highlightThemeRows.flat(), ...highlightStandardColors].map(({ color }) => color),
  ),
];

const props = defineProps<{
  visible: boolean;
  mode: HighlightMode;
  cellCount: number;
  recordCount: number;
  loading: boolean;
  color: string;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  "update:color": [value: string];
  clear: [];
  submit: [];
}>();

function isSelected(candidate: string): boolean {
  return props.color.toLowerCase() === candidate.toLowerCase();
}
</script>

<template>
  <el-dialog
    class="ledger-dialog"
    :model-value="visible"
    @update:model-value="emit('update:visible', $event)"
    :title="
      mode === 'cell'
        ? `设置单元格底色（${cellCount} 个）`
        : `设置记录底色（${recordCount} 条）`
    "
    width="430px"
    destroy-on-close
  >
    <div class="highlight-dialog-body">
      <p class="dialog-note">
        <template v-if="mode === 'cell'">
          选择一种底色后，会应用到当前选中的单元格；矩形选区中的草稿行不会写入台账。
        </template>
        <template v-else>
          选择一种底色后，会应用到当前选中的记录；锁定记录也可以设置或清除底色标记。
        </template>
      </p>
      <div class="highlight-palette-section">
        <div class="highlight-palette-title">主题颜色</div>
        <div class="highlight-palette-grid">
          <template v-for="(row, rowIndex) in highlightThemeRows" :key="`theme-${rowIndex}`">
            <button
              v-for="item in row"
              :key="item.label"
              type="button"
              class="highlight-color-swatch"
              :class="{ 'is-selected': isSelected(item.color) }"
              :style="{ backgroundColor: item.color }"
              :aria-label="item.label"
              :aria-pressed="isSelected(item.color)"
              :title="item.label"
              @click="emit('update:color', item.color)"
            >
              <span v-if="isSelected(item.color)" class="highlight-swatch-mark">
                <Check :size="16" :stroke-width="2" aria-hidden="true" />
              </span>
            </button>
          </template>
        </div>
      </div>
      <div class="highlight-palette-section">
        <div class="highlight-palette-title">标准色</div>
        <div class="highlight-palette-grid">
          <button
            v-for="item in highlightStandardColors"
            :key="item.label"
            type="button"
            class="highlight-color-swatch"
            :class="{ 'is-selected': isSelected(item.color) }"
            :style="{ backgroundColor: item.color }"
            :aria-label="item.label"
            :aria-pressed="isSelected(item.color)"
            :title="item.label"
            @click="emit('update:color', item.color)"
          >
            <span v-if="isSelected(item.color)" class="highlight-swatch-mark">
              <Check :size="16" :stroke-width="2" aria-hidden="true" />
            </span>
          </button>
        </div>
      </div>
      <div class="highlight-picker-row">
        <span class="field-label">更多颜色</span>
        <el-color-picker
          :model-value="color"
          @update:model-value="emit('update:color', $event)"
          :predefine="highlightPalette"
        />
        <span
          class="highlight-preview"
          :style="{ backgroundColor: color }"
          aria-label="底色预览"
        />
        <code>{{ color }}</code>
      </div>
    </div>
    <template #footer>
      <el-button :disabled="loading" @click="emit('update:visible', false)">
        取消
      </el-button>
      <el-button :loading="loading" @click="emit('clear')">清除底色</el-button>
      <el-button
        type="primary"
        :loading="loading"
        @click="emit('submit')"
      >
        应用底色
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-note {
  margin: 0 0 var(--app-space-4);
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
}

.field-label {
  color: var(--app-muted);
  font-size: 12px;
}

.highlight-dialog-body {
  padding: var(--app-space-optical) 0 var(--app-space-2);
}

.highlight-palette-section {
  display: flex;
  flex-direction: column;
  gap: var(--app-space-2);
}

.highlight-palette-section + .highlight-palette-section {
  margin-top: var(--app-space-3);
}

.highlight-palette-title {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 700;
}

.highlight-palette-grid {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: var(--app-space-1);
}

.highlight-color-swatch {
  position: relative;
  min-width: 0;
  height: 27px;
  border: 1px solid var(--app-border-strong);
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease;
}

.highlight-color-swatch:hover {
  z-index: 1;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgb(16 24 40 / 20%);
}

.highlight-color-swatch.is-selected {
  z-index: 2;
  outline: 2px solid var(--app-primary);
  outline-offset: 1px;
}

.highlight-swatch-mark {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  color: var(--app-bg);
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
  text-shadow: 0 1px 2px rgb(0 0 0 / 75%);
}

.highlight-picker-row {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  margin-top: var(--app-space-3);
}

.highlight-picker-row .field-label {
  min-width: 62px;
}

.highlight-preview {
  width: 44px;
  height: 28px;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-control);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 60%);
}

.highlight-picker-row code {
  color: var(--app-muted);
  font-size: 12px;
}
</style>
