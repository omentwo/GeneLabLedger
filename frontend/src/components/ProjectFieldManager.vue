<script setup lang="ts">
import {
  ArrowDown,
  ArrowUp,
  CopyDocument,
  Delete,
  Document,
  DocumentAdd,
  EditPen,
  Plus,
  Setting,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, reactive, ref, watch } from "vue";

import {
  batchCreateFields,
  createField,
  createProject,
  duplicateProject,
  deleteField,
  deleteProject,
  forceDeleteProject,
  listLedgerTemplates,
  reorderFields,
  replaceFieldOptions,
  updateField,
  updateProject,
} from "@/api/projects";
import { ApiError } from "@/api/client";
import { useAppStore } from "@/stores/app";
import { previewBatchFieldLabels } from "@/utils/batchFields";
import type {
  DataType,
  FieldDefinition,
  FieldValidationRules,
  LedgerTemplate,
  ValidationMode,
} from "@/types/api";

const props = defineProps<{
  modelValue: boolean;
  selectedProjectId: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  changed: [];
  "select-project": [projectId: string];
  "open-templates": [];
}>();

const appStore = useAppStore();
const currentProjectId = ref("");
const projectName = ref("");
const newProjectName = ref("");
const newProjectTemplateId = ref("");
const ledgerTemplates = ref<LedgerTemplate[]>([]);
const workingFields = ref<FieldDefinition[]>([]);
const saving = ref(false);
const fieldDialogVisible = ref(false);
const batchFieldDialogVisible = ref(false);
const batchFieldText = ref("");
const optionsDialogVisible = ref(false);
const validationDialogVisible = ref(false);
const editingOptionsField = ref<FieldDefinition | null>(null);
const editingValidationField = ref<FieldDefinition | null>(null);
const optionsDraft = ref<string[]>([]);
const newField = reactive<{
  label: string;
  data_type: DataType;
  width: number;
  optionsText: string;
  validation_mode: ValidationMode;
  validation_rules: FieldValidationRules;
  default_value: string;
}>({
  label: "",
  data_type: "text",
  width: 120,
  optionsText: "",
  validation_mode: "suggestion",
  validation_rules: {},
  default_value: "",
});
const validationDraft = reactive<{
  mode: ValidationMode;
  rules: FieldValidationRules;
}>({ mode: "suggestion", rules: {} });

const currentProject = computed(() =>
  appStore.projects.find((project) => project.id === currentProjectId.value),
);
const batchFieldPreview = computed(() =>
  previewBatchFieldLabels(batchFieldText.value, workingFields.value),
);

const dataTypeLabels: Record<DataType, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  select: "备选输入",
};
const validationModeLabels: Record<ValidationMode, string> = {
  suggestion: "建议",
  warning: "警告",
  strict: "严格",
};

function cloneFields(fields: FieldDefinition[]): FieldDefinition[] {
  return fields
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((field) => ({
      ...field,
      validation_rules: { ...(field.validation_rules ?? {}) },
      options: field.options.map((option) => ({ ...option })),
    }));
}

function syncCurrentProject(): void {
  const fallback = appStore.projects[0]?.id ?? "";
  if (!appStore.projects.some((project) => project.id === currentProjectId.value)) {
    currentProjectId.value =
      props.selectedProjectId &&
      appStore.projects.some((project) => project.id === props.selectedProjectId)
        ? props.selectedProjectId
        : fallback;
  }
  projectName.value = currentProject.value?.name ?? "";
  workingFields.value = cloneFields(currentProject.value?.fields ?? []);
}

function parseOptions(value: string): string[] {
  const result: string[] = [];
  value
    .split(/\r?\n|,|，/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      if (!result.includes(item)) result.push(item);
    });
  return result;
}

async function reloadAndNotify(): Promise<void> {
  await appStore.reloadProjects();
  syncCurrentProject();
  emit("changed");
}

async function loadLedgerTemplates(): Promise<void> {
  try {
    ledgerTemplates.value = await listLedgerTemplates();
  } catch {
    ledgerTemplates.value = [];
  }
}

function openTemplates(): void {
  emit("update:modelValue", false);
  emit("open-templates");
}

async function addProject(): Promise<void> {
  const name = newProjectName.value.trim();
  if (!name) {
    ElMessage.warning("请输入项目名称");
    return;
  }
  saving.value = true;
  try {
    const project = await createProject(name, newProjectTemplateId.value || undefined);
    newProjectName.value = "";
    newProjectTemplateId.value = "";
    await appStore.reloadProjects();
    currentProjectId.value = project.id;
    syncCurrentProject();
    emit("select-project", project.id);
    emit("changed");
    ElMessage.success("检测项目已添加");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "项目添加失败");
  } finally {
    saving.value = false;
  }
}

async function renameProject(): Promise<void> {
  if (!currentProject.value) return;
  const name = projectName.value.trim();
  if (!name) {
    ElMessage.warning("项目名称不能为空");
    return;
  }
  saving.value = true;
  try {
    await updateProject(currentProject.value.id, { name });
    await reloadAndNotify();
    ElMessage.success("项目名称已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "项目修改失败");
  } finally {
    saving.value = false;
  }
}

async function duplicateCurrentProject(): Promise<void> {
  const project = currentProject.value;
  if (!project) return;
  try {
    const result = await ElMessageBox.prompt("请输入复制后的台账名称", "复制整个台账", {
      inputValue: `${project.name} - 副本`,
      inputValidator: (value) => (value.trim() ? true : "名称不能为空"),
      confirmButtonText: "复制",
      cancelButtonText: "取消",
    });
    saving.value = true;
    const copied = await duplicateProject(project.id, result.value.trim());
    await appStore.reloadProjects();
    currentProjectId.value = copied.id;
    syncCurrentProject();
    emit("select-project", copied.id);
    emit("changed");
    ElMessage.success("台账已完整复制");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "复制台账失败");
  } finally {
    saving.value = false;
  }
}

async function moveProject(index: number, offset: -1 | 1): Promise<void> {
  const targetIndex = index + offset;
  const current = appStore.projects[index];
  const target = appStore.projects[targetIndex];
  if (!current || !target) return;
  saving.value = true;
  try {
    await Promise.all([
      updateProject(current.id, { sort_order: target.sort_order }),
      updateProject(target.id, { sort_order: current.sort_order }),
    ]);
    await appStore.reloadProjects();
    emit("changed");
    ElMessage.success("项目优先顺序已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "项目顺序保存失败");
  } finally {
    saving.value = false;
  }
}

async function removeProject(): Promise<void> {
  const project = currentProject.value;
  if (!project) return;
  try {
    await ElMessageBox.confirm(
      `确认删除项目“${project.name}”？没有台账记录和报告模板时会直接删除；如果存在数据，确认后可再输入名称进行强制删除。`,
      "删除检测项目",
      {
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    await deleteProject(project.id);
    currentProjectId.value = "";
    await reloadAndNotify();
    if (currentProjectId.value) emit("select-project", currentProjectId.value);
    ElMessage.success("项目已删除");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    if (error instanceof ApiError && error.status === 409) {
      try {
        const confirmation = await ElMessageBox.prompt(
          `项目“${project.name}”包含台账记录、表头数据或报告模板。强制删除会永久删除该项目及其所属数据，且无法撤销。请输入完整项目名称确认。`,
          "强制删除项目",
          {
            inputPlaceholder: project.name,
            inputValidator: (value) =>
              value.trim() === project.name ? true : "请输入与项目名称完全一致的内容",
            confirmButtonText: "永久删除",
            cancelButtonText: "取消",
            type: "error",
          },
        );
        saving.value = true;
        const result = await forceDeleteProject(project.id, confirmation.value.trim());
        currentProjectId.value = "";
        await reloadAndNotify();
        if (currentProjectId.value) emit("select-project", currentProjectId.value);
        const warning = result.cleanup_warnings.length ? `（${result.cleanup_warnings.join("；")}）` : "";
        ElMessage.success(
          `项目已强制删除：${result.deleted_records} 条记录、${result.deleted_fields} 个表头${warning}`,
        );
      } catch (forceError) {
        if (forceError !== "cancel" && forceError !== "close") {
          ElMessage.error(forceError instanceof Error ? forceError.message : "强制删除失败");
        }
      } finally {
        saving.value = false;
      }
      return;
    }
    ElMessage.error(error instanceof Error ? error.message : "项目删除失败");
  }
}

async function saveField(field: FieldDefinition): Promise<void> {
  const label = field.label.trim();
  if (!label) {
    ElMessage.warning("表头名称不能为空");
    return;
  }
  saving.value = true;
  try {
    await updateField(field.id, {
      label,
      data_type: field.data_type,
      width: Number(field.width),
      hidden: field.hidden,
      ...(field.is_core
        ? {}
        : {
            validation_mode: field.validation_mode,
            validation_rules: field.validation_rules,
            default_value: field.default_value,
          }),
    });
    await reloadAndNotify();
    ElMessage.success(`“${label}”已保存`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "表头保存失败");
  } finally {
    saving.value = false;
  }
}

async function moveField(index: number, offset: -1 | 1): Promise<void> {
  const target = index + offset;
  if (!currentProject.value || target < 0 || target >= workingFields.value.length) return;
  const reordered = workingFields.value.slice();
  const [field] = reordered.splice(index, 1);
  if (!field) return;
  reordered.splice(target, 0, field);
  workingFields.value = reordered;
  saving.value = true;
  try {
    await reorderFields(
      currentProject.value.id,
      reordered.map((item) => item.id),
    );
    await reloadAndNotify();
  } catch (error) {
    syncCurrentProject();
    ElMessage.error(error instanceof Error ? error.message : "表头顺序保存失败");
  } finally {
    saving.value = false;
  }
}

function openAddField(): void {
  Object.assign(newField, {
    label: "",
    data_type: "text",
    width: 120,
    optionsText: "",
    validation_mode: "suggestion",
    validation_rules: {},
    default_value: "",
  });
  fieldDialogVisible.value = true;
}

function openBatchFields(): void {
  batchFieldText.value = "";
  batchFieldDialogVisible.value = true;
}

async function addBatchFields(): Promise<void> {
  const project = currentProject.value;
  const preview = batchFieldPreview.value;
  if (!project || !preview.labels.length) {
    ElMessage.warning("请按每行一个名称录入表头");
    return;
  }
  if (preview.hasErrors) {
    ElMessage.warning("请先处理名单中的重复或冲突项");
    return;
  }
  saving.value = true;
  try {
    const result = await batchCreateFields(project.id, preview.labels);
    batchFieldDialogVisible.value = false;
    await reloadAndNotify();
    if (result.created.length) {
      ElMessage.success(`已新增 ${result.created.length} 个表头，已有表头保持不变`);
    } else {
      ElMessage.info("名单中的表头均已存在，没有新增内容");
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "快速录入表头失败");
  } finally {
    saving.value = false;
  }
}

function batchFieldStatusType(status: string): "success" | "info" | "warning" | "danger" {
  if (status === "new") return "success";
  if (status === "existing" || status === "existing-core") return "info";
  return status === "duplicate" ? "warning" : "danger";
}

async function addField(): Promise<void> {
  if (!currentProject.value || !newField.label.trim()) {
    ElMessage.warning("请输入表头名称");
    return;
  }
  saving.value = true;
  try {
    await createField(currentProject.value.id, {
      label: newField.label.trim(),
      data_type: newField.data_type,
      width: Number(newField.width),
      options: parseOptions(newField.optionsText),
      validation_mode: newField.validation_mode,
      validation_rules: newField.validation_rules,
      default_value: newField.default_value.trim() || null,
    });
    fieldDialogVisible.value = false;
    await reloadAndNotify();
    ElMessage.success("表头已添加到当前项目");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "表头添加失败");
  } finally {
    saving.value = false;
  }
}

function editOptions(field: FieldDefinition): void {
  editingOptionsField.value = field;
  optionsDraft.value = field.options
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((option) => option.value)
  if (!optionsDraft.value.length) optionsDraft.value.push("");
  optionsDialogVisible.value = true;
}

function addOptionDraft(): void {
  optionsDraft.value.push("");
}

function removeOptionDraft(index: number): void {
  optionsDraft.value.splice(index, 1);
  if (!optionsDraft.value.length) optionsDraft.value.push("");
}

async function saveOptions(): Promise<void> {
  if (!editingOptionsField.value) return;
  saving.value = true;
  try {
    await replaceFieldOptions(
      editingOptionsField.value.id,
      parseOptions(optionsDraft.value.join("\n")),
    );
    optionsDialogVisible.value = false;
    await reloadAndNotify();
    ElMessage.success("备选项已保存；表格中仍可输入任意内容");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "备选项保存失败");
  } finally {
    saving.value = false;
  }
}

function editValidation(field: FieldDefinition): void {
  editingValidationField.value = field;
  validationDraft.mode = field.validation_mode ?? "suggestion";
  validationDraft.rules = { ...(field.validation_rules ?? {}) };
  validationDialogVisible.value = true;
}

async function saveValidation(): Promise<void> {
  const field = editingValidationField.value;
  if (!field || field.is_core) return;
  saving.value = true;
  try {
    await updateField(field.id, {
      validation_mode: validationDraft.mode,
      validation_rules: validationDraft.rules,
    });
    validationDialogVisible.value = false;
    await reloadAndNotify();
    ElMessage.success("验证规则已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "验证规则保存失败");
  } finally {
    saving.value = false;
  }
}

async function removeField(field: FieldDefinition): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认真正删除表头“${field.label}”及该列的全部台账数据？此操作不能撤销。`,
      "删除表头与数据",
      {
        confirmButtonText: "删除表头及数据",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    await deleteField(field.id);
    await reloadAndNotify();
    ElMessage.success("表头及该列数据已删除");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "表头删除失败");
  }
}

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    currentProjectId.value = props.selectedProjectId;
    syncCurrentProject();
    void loadLedgerTemplates();
  },
);

watch(currentProjectId, () => {
  syncCurrentProject();
});

watch(
  () => appStore.projects,
  () => {
    if (props.modelValue) syncCurrentProject();
  },
  { deep: true },
);
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="管理检测项目与独立表头"
    width="min(1120px, 94vw)"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="manager-layout" v-loading="saving">
      <aside class="project-panel">
        <div class="section-label">检测项目</div>
        <el-menu :default-active="currentProjectId" @select="currentProjectId = $event">
          <el-menu-item
            v-for="(project, index) in appStore.projects"
            :key="project.id"
            :index="project.id"
          >
            <span class="project-symbol" aria-hidden="true">🧬</span>
            <span class="project-list-name">{{ project.name }}</span>
            <span class="project-count">{{ project.fields.length }}</span>
            <span class="project-order-actions">
              <el-button
                link
                :icon="ArrowUp"
                :disabled="index === 0"
                title="项目上移"
                @click.stop="moveProject(index, -1)"
              />
              <el-button
                link
                :icon="ArrowDown"
                :disabled="index === appStore.projects.length - 1"
                title="项目下移"
                @click.stop="moveProject(index, 1)"
              />
            </span>
          </el-menu-item>
        </el-menu>
        <div class="new-project">
          <el-input
            v-model="newProjectName"
            placeholder="新项目名称"
            @keyup.enter="addProject"
          />
          <el-select v-model="newProjectTemplateId" clearable placeholder="空白台账或套用表头模板">
            <el-option label="空白台账（默认表头）" value="" />
            <el-option
              v-for="template in ledgerTemplates"
              :key="template.id"
              :label="`模板：${template.name}`"
              :value="template.id"
            />
          </el-select>
          <el-button :icon="Plus" @click="addProject">添加项目</el-button>
        </div>
      </aside>

      <section class="field-panel">
        <div v-if="currentProject" class="project-name-row">
          <el-input v-model="projectName" maxlength="120" />
          <el-button :icon="EditPen" @click="renameProject">重命名台账</el-button>
          <el-button :icon="CopyDocument" @click="duplicateCurrentProject">复制台账</el-button>
          <el-button type="danger" plain :icon="Delete" @click="removeProject">
            删除项目
          </el-button>
        </div>

        <div class="field-heading">
          <div>
            <strong>当前项目表头</strong>
            <p>“新记录默认值”只用于以后新增的记录，不会改动已有数据。</p>
          </div>
          <div class="field-heading-actions">
            <el-button :icon="Document" @click="openTemplates">台账模板</el-button>
            <el-button :icon="DocumentAdd" @click="openBatchFields">快速录入表头</el-button>
            <el-button type="primary" :icon="Plus" @click="openAddField">添加表头</el-button>
          </div>
        </div>

        <el-table :data="workingFields" row-key="id" border max-height="480">
          <el-table-column label="顺序" width="92" align="center">
            <template #default="{ $index }">
              <el-button
                link
                :icon="ArrowUp"
                :disabled="$index === 0"
                title="向前移动"
                @click="moveField($index, -1)"
              />
              <el-button
                link
                :icon="ArrowDown"
                :disabled="$index === workingFields.length - 1"
                title="向后移动"
                @click="moveField($index, 1)"
              />
            </template>
          </el-table-column>
          <el-table-column label="表头名称" min-width="180">
            <template #default="{ row }: { row: FieldDefinition }">
              <el-input v-model="row.label" maxlength="120" />
            </template>
          </el-table-column>
          <el-table-column label="输入类型" width="140">
            <template #default="{ row }: { row: FieldDefinition }">
              <el-select v-model="row.data_type" :disabled="row.is_core">
                <el-option
                  v-for="(label, value) in dataTypeLabels"
                  :key="value"
                  :label="label"
                  :value="value"
                />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="列宽" width="125">
            <template #default="{ row }: { row: FieldDefinition }">
              <el-input-number
                v-model="row.width"
                :min="58"
                :max="600"
                :step="10"
                controls-position="right"
              />
            </template>
          </el-table-column>
          <el-table-column label="显示" width="90" align="center">
            <template #default="{ row }: { row: FieldDefinition }">
              <el-switch
                :model-value="!row.hidden"
                @update:model-value="row.hidden = !$event"
              />
            </template>
          </el-table-column>
          <el-table-column label="备选项" min-width="150">
            <template #default="{ row }: { row: FieldDefinition }">
              <span class="option-summary">
                {{
                  row.options.length
                    ? row.options.map((option) => option.value).join("、")
                    : "无"
                }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="验证" width="90" align="center">
            <template #default="{ row }: { row: FieldDefinition }">
              <span v-if="row.is_core">固定</span>
              <el-button v-else link type="primary" @click="editValidation(row)">
                {{ validationModeLabels[row.validation_mode ?? 'suggestion'] }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="新记录默认值" min-width="170">
            <template #default="{ row }: { row: FieldDefinition }">
              <span v-if="row.is_core">—</span>
              <el-input
                v-else
                :model-value="row.default_value ?? ''"
                clearable
                placeholder="未设置"
                @update:model-value="row.default_value = String($event || '') || null"
              />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="230" fixed="right">
            <template #default="{ row }: { row: FieldDefinition }">
              <el-button link type="primary" @click="saveField(row)">保存</el-button>
              <el-button
                link
                :icon="Setting"
                :disabled="row.system_key === 'status'"
                @click="editOptions(row)"
              >
                备选项
              </el-button>
              <el-button
                link
                :disabled="row.is_core"
                @click="editValidation(row)"
              >
                验证
              </el-button>
              <el-button
                link
                type="danger"
                :disabled="row.is_core"
                @click="removeField(row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">完成</el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="fieldDialogVisible"
    title="为当前项目添加表头"
    width="560px"
    append-to-body
  >
    <el-form label-position="top">
      <el-form-item label="表头名称">
        <el-input v-model="newField.label" maxlength="120" placeholder="例如：DNA浓度" />
      </el-form-item>
      <div class="two-column-form">
        <el-form-item label="输入类型">
          <el-select v-model="newField.data_type">
            <el-option
              v-for="(label, value) in dataTypeLabels"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="初始列宽">
          <el-input-number
            v-model="newField.width"
            :min="58"
            :max="600"
            :step="10"
          />
        </el-form-item>
      </div>
      <el-form-item label="验证模式">
        <el-select v-model="newField.validation_mode">
          <el-option label="建议（允许输入，仅提示）" value="suggestion" />
          <el-option label="警告（提交前确认）" value="warning" />
          <el-option label="严格（不符合时阻止）" value="strict" />
        </el-select>
      </el-form-item>
      <el-form-item label="新记录默认值（可选）">
        <el-input
          v-model="newField.default_value"
          clearable
          :placeholder="newField.data_type === 'date' ? '例如：2026-08-12' : '例如：20260812'"
        />
        <div class="form-help">只预填以后新增的记录；已有记录不会变化。</div>
      </el-form-item>
      <div class="two-column-form">
        <el-form-item label="必填">
          <el-switch v-model="newField.validation_rules.required" />
        </el-form-item>
        <el-form-item label="最大字符数">
          <el-input-number
            v-model="newField.validation_rules.max_length"
            :min="1"
            :max="10000"
            controls-position="right"
          />
        </el-form-item>
      </div>
      <div v-if="newField.data_type === 'number'" class="two-column-form">
        <el-form-item label="最小值">
          <el-input-number v-model="newField.validation_rules.min_number" controls-position="right" />
        </el-form-item>
        <el-form-item label="最大值">
          <el-input-number v-model="newField.validation_rules.max_number" controls-position="right" />
        </el-form-item>
      </div>
      <el-form-item v-if="newField.data_type === 'number'" label="最多小数位">
        <el-input-number
          v-model="newField.validation_rules.decimal_places"
          :min="0"
          :max="12"
          controls-position="right"
        />
      </el-form-item>
      <div v-if="newField.data_type === 'date'" class="two-column-form">
        <el-form-item label="最早日期">
          <el-date-picker
            v-model="newField.validation_rules.min_date"
            type="date"
            value-format="YYYY-MM-DD"
          />
        </el-form-item>
        <el-form-item label="最晚日期">
          <el-date-picker
            v-model="newField.validation_rules.max_date"
            type="date"
            value-format="YYYY-MM-DD"
          />
        </el-form-item>
      </div>
      <el-form-item label="备选项（可选，每行一个）">
        <el-input
          v-model="newField.optionsText"
          type="textarea"
          :rows="5"
          placeholder="例如：&#10;男&#10;女"
        />
        <div class="form-help">备选项只用于提示，台账里仍可手输或粘贴其他内容。</div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="fieldDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="addField">添加</el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="batchFieldDialogVisible"
    title="快速录入表头"
    width="min(720px, 92vw)"
    append-to-body
  >
    <el-input
      v-model="batchFieldText"
      type="textarea"
      :rows="8"
      placeholder="每行一个表头，可直接粘贴 Excel/WPS 中的一列，例如：&#10;日期&#10;病理号&#10;蜡块号&#10;检测结果&#10;备注"
    />
    <p class="form-help batch-field-help">
      已有表头只会保留；新表头将按输入顺序追加。空行会自动忽略，一次最多 100 个。
    </p>
    <div v-if="batchFieldPreview.rows.length" class="batch-field-preview">
      <div
        v-for="row in batchFieldPreview.rows"
        :key="`${row.index}-${row.label}`"
        class="batch-field-preview-row"
        :class="`is-${row.status}`"
      >
        <span class="batch-field-index">{{ row.index }}.</span>
        <span class="batch-field-label">{{ row.label }}</span>
        <el-tag :type="batchFieldStatusType(row.status)" effect="plain" size="small">
          {{ row.message }}
        </el-tag>
      </div>
    </div>
    <template #footer>
      <el-button @click="batchFieldDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="saving"
        :disabled="!batchFieldPreview.labels.length || batchFieldPreview.hasErrors"
        @click="addBatchFields"
      >
        {{ batchFieldPreview.newCount ? `新增 ${batchFieldPreview.newCount} 个表头` : '确认名单' }}
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="validationDialogVisible"
    :title="`验证规则：${editingValidationField?.label ?? ''}`"
    width="620px"
    append-to-body
  >
    <el-form label-position="top">
      <el-form-item label="验证模式">
        <el-radio-group v-model="validationDraft.mode">
          <el-radio-button value="suggestion">建议</el-radio-button>
          <el-radio-button value="warning">警告</el-radio-button>
          <el-radio-button value="strict">严格</el-radio-button>
        </el-radio-group>
        <div class="form-help">
          建议模式只提示；警告模式提交前确认；严格模式会阻止整批提交。
        </div>
      </el-form-item>
      <div class="two-column-form">
        <el-form-item label="必填">
          <el-switch v-model="validationDraft.rules.required" />
        </el-form-item>
        <el-form-item label="最大字符数">
          <el-input-number
            v-model="validationDraft.rules.max_length"
            :min="1"
            :max="10000"
            controls-position="right"
          />
        </el-form-item>
      </div>
      <template v-if="editingValidationField?.data_type === 'number'">
        <div class="two-column-form">
          <el-form-item label="最小值">
            <el-input-number v-model="validationDraft.rules.min_number" controls-position="right" />
          </el-form-item>
          <el-form-item label="最大值">
            <el-input-number v-model="validationDraft.rules.max_number" controls-position="right" />
          </el-form-item>
        </div>
        <el-form-item label="最多小数位">
          <el-input-number
            v-model="validationDraft.rules.decimal_places"
            :min="0"
            :max="12"
            controls-position="right"
          />
        </el-form-item>
      </template>
      <div v-if="editingValidationField?.data_type === 'date'" class="two-column-form">
        <el-form-item label="最早日期">
          <el-date-picker
            v-model="validationDraft.rules.min_date"
            type="date"
            value-format="YYYY-MM-DD"
          />
        </el-form-item>
        <el-form-item label="最晚日期">
          <el-date-picker
            v-model="validationDraft.rules.max_date"
            type="date"
            value-format="YYYY-MM-DD"
          />
        </el-form-item>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="validationDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveValidation">保存规则</el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="optionsDialogVisible"
    :title="`备选项：${editingOptionsField?.label ?? ''}`"
    width="520px"
    append-to-body
  >
    <div class="options-editor">
      <div v-for="(_, index) in optionsDraft" :key="index" class="option-row">
        <el-input v-model="optionsDraft[index]" :placeholder="`备选项 ${index + 1}`" />
        <el-button link type="danger" @click="removeOptionDraft(index)">删除</el-button>
      </div>
      <el-button plain :icon="Plus" @click="addOptionDraft">添加备选项</el-button>
    </div>
    <p class="form-help">每行一个；可以留空。表格输入框仍允许直接输入和粘贴其他内容。</p>
    <template #footer>
      <el-button @click="optionsDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveOptions">保存备选项</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.manager-layout {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  min-height: 600px;
  gap: 22px;
}

.project-panel {
  display: flex;
  min-width: 0;
  max-height: 600px;
  flex-direction: column;
  gap: 10px;
  border-right: 1px solid var(--app-border);
  padding-right: 20px;
}

.section-label {
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 700;
}

.project-panel :deep(.el-menu) {
  min-height: 0;
  flex: 1;
  border-right: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 6px;
}

.project-panel :deep(.el-menu-item) {
  display: flex;
  height: 52px;
  margin-bottom: 8px;
  border: 1px solid #eaecf0;
  border-radius: 12px;
  background: #fff;
  line-height: 52px;
}

.project-panel :deep(.el-menu-item.is-active) {
  border-color: #b2ddff;
  color: #1570ef;
  background: #eff8ff;
}

.project-symbol {
  margin-right: 8px;
  font-size: 18px;
}

.project-count {
  min-width: 24px;
  height: 24px;
  margin-left: 8px;
  border-radius: 999px;
  color: #475467;
  background: #f2f4f7;
  font-size: 12px;
  line-height: 24px;
  text-align: center;
}

.project-list-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-order-actions {
  display: flex;
  align-items: center;
}

.project-order-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.new-project {
  display: grid;
  gap: 8px;
  margin-top: auto;
}

.field-panel {
  min-width: 0;
}

.project-name-row,
.field-heading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.project-name-row {
  margin-bottom: 18px;
}

.field-heading {
  justify-content: space-between;
  margin-bottom: 10px;
}

.field-heading-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.field-heading p,
.form-help {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 12px;
}

.option-summary {
  display: block;
  overflow: hidden;
  color: var(--app-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.two-column-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.options-editor {
  display: grid;
  gap: 8px;
}

.batch-field-help {
  margin-bottom: 12px;
}

.batch-field-preview {
  display: grid;
  max-height: 300px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow-y: auto;
}

.batch-field-preview-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
}

.batch-field-preview-row + .batch-field-preview-row {
  border-top: 1px solid var(--app-border);
}

.batch-field-preview-row.is-duplicate,
.batch-field-preview-row.is-conflict {
  background: #fff7ed;
}

.batch-field-index {
  color: var(--app-muted);
  text-align: right;
}

.batch-field-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.option-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}
</style>
