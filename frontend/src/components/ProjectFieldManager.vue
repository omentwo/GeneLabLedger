<script setup lang="ts">
import {
  ArrowDown,
  ArrowUp,
  Delete,
  EditPen,
  Plus,
  Setting,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, reactive, ref, watch } from "vue";

import {
  createField,
  createProject,
  deleteField,
  deleteProject,
  reorderFields,
  replaceFieldOptions,
  updateField,
  updateProject,
} from "@/api/projects";
import { useAppStore } from "@/stores/app";
import type { DataType, FieldDefinition } from "@/types/api";

const props = defineProps<{
  modelValue: boolean;
  selectedProjectId: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  changed: [];
  "select-project": [projectId: string];
}>();

const appStore = useAppStore();
const currentProjectId = ref("");
const projectName = ref("");
const newProjectName = ref("");
const workingFields = ref<FieldDefinition[]>([]);
const saving = ref(false);
const fieldDialogVisible = ref(false);
const optionsDialogVisible = ref(false);
const editingOptionsField = ref<FieldDefinition | null>(null);
const optionsText = ref("");
const newField = reactive<{
  label: string;
  data_type: DataType;
  width: number;
  optionsText: string;
}>({
  label: "",
  data_type: "text",
  width: 120,
  optionsText: "",
});

const currentProject = computed(() =>
  appStore.projects.find((project) => project.id === currentProjectId.value),
);

const dataTypeLabels: Record<DataType, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  select: "备选输入",
};

function cloneFields(fields: FieldDefinition[]): FieldDefinition[] {
  return fields
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((field) => ({
      ...field,
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

async function addProject(): Promise<void> {
  const name = newProjectName.value.trim();
  if (!name) {
    ElMessage.warning("请输入项目名称");
    return;
  }
  saving.value = true;
  try {
    const project = await createProject(name);
    newProjectName.value = "";
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
  if (!currentProject.value) return;
  try {
    await ElMessageBox.confirm(
      `确认删除项目“${currentProject.value.name}”？只有没有台账记录和报告模板的项目才能删除。`,
      "删除检测项目",
      {
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    await deleteProject(currentProject.value.id);
    currentProjectId.value = "";
    await reloadAndNotify();
    if (currentProjectId.value) emit("select-project", currentProjectId.value);
    ElMessage.success("项目已删除");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
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
  });
  fieldDialogVisible.value = true;
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
  optionsText.value = field.options
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((option) => option.value)
    .join("\n");
  optionsDialogVisible.value = true;
}

async function saveOptions(): Promise<void> {
  if (!editingOptionsField.value) return;
  saving.value = true;
  try {
    await replaceFieldOptions(
      editingOptionsField.value.id,
      parseOptions(optionsText.value),
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
    width="1040px"
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
            <span class="project-list-name">{{ project.name }}</span>
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
          <el-button :icon="Plus" @click="addProject">添加项目</el-button>
        </div>
      </aside>

      <section class="field-panel">
        <div v-if="currentProject" class="project-name-row">
          <el-input v-model="projectName" maxlength="120" />
          <el-button :icon="EditPen" @click="renameProject">保存名称</el-button>
          <el-button type="danger" plain :icon="Delete" @click="removeProject">
            删除项目
          </el-button>
        </div>

        <div class="field-heading">
          <div>
            <strong>当前项目表头</strong>
            <p>修改后即时生效；上下移动用于调整显示和导出顺序，隐藏不会删除数据。</p>
          </div>
          <el-button type="primary" :icon="Plus" @click="openAddField">
            添加表头
          </el-button>
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
          <el-table-column label="操作" width="190" fixed="right">
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
    v-model="optionsDialogVisible"
    :title="`备选项：${editingOptionsField?.label ?? ''}`"
    width="520px"
    append-to-body
  >
    <el-input
      v-model="optionsText"
      type="textarea"
      :rows="8"
      placeholder="每行一个备选项"
    />
    <p class="form-help">可以为空；表格输入框始终允许直接输入和粘贴。</p>
    <template #footer>
      <el-button @click="optionsDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveOptions">保存备选项</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.manager-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  min-height: 520px;
  gap: 18px;
}

.project-panel {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  border-right: 1px solid var(--app-border);
  padding-right: 16px;
}

.section-label {
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 700;
}

.project-panel :deep(.el-menu) {
  border-right: 0;
}

.project-panel :deep(.el-menu-item) {
  display: flex;
  height: 40px;
  border-radius: 7px;
  line-height: 40px;
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
</style>
