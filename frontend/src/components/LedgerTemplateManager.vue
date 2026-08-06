<script setup lang="ts">
import { Delete, EditPen, Plus } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, reactive, ref, watch } from "vue";

import {
  createLedgerTemplate,
  deleteLedgerTemplate,
  listLedgerTemplates,
  updateLedgerTemplate,
} from "@/api/projects";
import { useAppStore } from "@/stores/app";
import type { LedgerTemplate, LedgerTemplateField } from "@/types/api";

const props = defineProps<{ modelValue: boolean; selectedProjectId: string }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; changed: [] }>();

const appStore = useAppStore();
const templates = ref<LedgerTemplate[]>([]);
const loading = ref(false);
const dialogVisible = ref(false);
const editingTemplateId = ref<string | null>(null);
const draftFields = ref<LedgerTemplateField[]>([]);
const form = reactive({ name: "", description: "", sourceProjectId: "" });

const sourceProject = computed(() =>
  appStore.projects.find((project) => project.id === form.sourceProjectId),
);

function fieldsFromSource(): LedgerTemplateField[] {
  return (sourceProject.value?.fields ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((field) => ({
      key: field.key,
      label: field.label,
      data_type: field.data_type,
      system_key: field.system_key,
      is_core: field.is_core,
      hidden: field.hidden,
      sort_order: field.sort_order,
      width: field.width,
      options: field.options
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((option) => option.value),
    }));
}

function cloneTemplateFields(fields: LedgerTemplateField[]): LedgerTemplateField[] {
  return fields.map((field, index) => ({
    ...field,
    sort_order: index,
    options: [...field.options],
  }));
}

async function loadTemplates(): Promise<void> {
  loading.value = true;
  try {
    templates.value = await listLedgerTemplates();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "无法加载台账模板");
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingTemplateId.value = null;
  form.name = "";
  form.description = "";
  form.sourceProjectId = props.selectedProjectId || appStore.projects[0]?.id || "";
  draftFields.value = fieldsFromSource();
  dialogVisible.value = true;
}

function openEdit(template: LedgerTemplate): void {
  editingTemplateId.value = template.id;
  form.name = template.name;
  form.description = template.description;
  form.sourceProjectId = props.selectedProjectId || appStore.projects[0]?.id || "";
  draftFields.value = cloneTemplateFields(template.fields);
  dialogVisible.value = true;
}

function syncDraftFields(): void {
  draftFields.value = fieldsFromSource();
}

function addDraftField(): void {
  const index = draftFields.value.length;
  draftFields.value.push({
    key: `custom_${Date.now()}_${index}`,
    label: `新字段 ${index + 1}`,
    data_type: "text",
    system_key: null,
    is_core: false,
    hidden: false,
    sort_order: index,
    width: 120,
    options: [],
  });
}

function removeDraftField(index: number): void {
  draftFields.value.splice(index, 1);
  draftFields.value.forEach((field, fieldIndex) => {
    field.sort_order = fieldIndex;
  });
}

async function saveTemplate(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning("请输入模板名称");
    return;
  }
  if (!draftFields.value.length) {
    ElMessage.warning("模板至少需要一个表头字段");
    return;
  }
  loading.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      fields: cloneTemplateFields(draftFields.value),
    };
    if (editingTemplateId.value) {
      await updateLedgerTemplate(editingTemplateId.value, payload);
    } else {
      await createLedgerTemplate(payload);
    }
    dialogVisible.value = false;
    await loadTemplates();
    emit("changed");
    ElMessage.success("台账模板已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存台账模板失败");
  } finally {
    loading.value = false;
  }
}

async function removeTemplate(template: LedgerTemplate): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除模板“${template.name}”？已有台账不会受影响。`, "删除台账模板", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
    loading.value = true;
    await deleteLedgerTemplate(template.id);
    await loadTemplates();
    emit("changed");
    ElMessage.success("台账模板已删除");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "删除台账模板失败");
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) void loadTemplates();
  },
);
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="台账表头模板"
    width="min(900px, 94vw)"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-loading="loading" class="ledger-template-manager">
      <div class="template-toolbar">
        <span class="form-help">模板属于当前本地软件，修改模板不会改变已经创建的台账。</span>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增模板</el-button>
      </div>
      <el-table :data="templates" border empty-text="暂无台账模板">
        <el-table-column prop="name" label="模板名称" min-width="180" />
        <el-table-column prop="description" label="说明" min-width="220" />
        <el-table-column label="表头数量" width="110" align="center">
          <template #default="{ row }: { row: LedgerTemplate }">{{ row.fields.length }}</template>
        </el-table-column>
        <el-table-column label="预览" min-width="280">
          <template #default="{ row }: { row: LedgerTemplate }">
            <span class="template-fields">{{ row.fields.map((field) => field.label).join("、") }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }: { row: LedgerTemplate }">
            <el-button link type="primary" :icon="EditPen" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" :icon="Delete" @click="removeTemplate(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">完成</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="dialogVisible" :title="editingTemplateId ? '编辑台账模板' : '新增台账模板'" width="520px" append-to-body>
    <el-form label-position="top">
      <el-form-item label="模板名称">
        <el-input v-model="form.name" maxlength="120" />
      </el-form-item>
      <el-form-item label="说明">
        <el-input v-model="form.description" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
      <el-form-item label="表头来源台账">
        <el-select v-model="form.sourceProjectId" filterable style="width: 100%">
          <el-option
            v-for="project in appStore.projects"
            :key="project.id"
            :label="project.name"
            :value="project.id"
          />
        </el-select>
        <el-button link type="primary" @click="syncDraftFields">从来源台账同步字段</el-button>
        <div class="form-help">可以直接编辑下面的字段；同步会覆盖当前字段草稿。</div>
      </el-form-item>
      <div class="template-field-editor">
        <div v-for="(field, index) in draftFields" :key="field.key" class="template-field-row">
          <el-input v-model="field.label" maxlength="120" placeholder="字段名称" />
          <el-select v-model="field.data_type" style="width: 110px">
            <el-option label="文本" value="text" />
            <el-option label="数字" value="number" />
            <el-option label="日期" value="date" />
            <el-option label="选择" value="select" />
          </el-select>
          <el-input-number v-model="field.width" :min="58" :max="600" controls-position="right" />
          <el-button link type="danger" @click="removeDraftField(index)">删除</el-button>
        </div>
        <el-button plain :icon="Plus" @click="addDraftField">添加字段</el-button>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="saveTemplate">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ledger-template-manager { min-height: 280px; }
.template-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.form-help { color: var(--app-muted); font-size: 12px; }
.template-fields { color: var(--app-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
.template-field-editor { display: grid; gap: 8px; max-height: 320px; overflow-y: auto; }
.template-field-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(88px, 110px) minmax(96px, 120px) 48px;
  gap: 8px;
  align-items: center;
}
.template-field-row > * { min-width: 0; }
.template-field-row :deep(.el-select),
.template-field-row :deep(.el-input-number) { width: 100%; }
.template-field-row :deep(.el-button) { width: 48px; padding: 0; justify-self: end; }

@media (max-width: 600px) {
  .template-field-row {
    grid-template-columns: minmax(0, 1fr) 86px 92px 42px;
    gap: 6px;
  }
  .template-field-row :deep(.el-button) { width: 42px; }
}
</style>
