import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { TableV2Instance } from "element-plus";

import { useAppStore } from "@/stores/app";
import type { FieldDefinition, Project, ProjectRecord } from "@/types/api";

/**
 * 台账共享状态包：项目选择、记录数据、表头与表格实例。
 *
 * 这是后续所有台账 composables（records / grid selection /
 * clipboard & fill / cell save）的共同依赖底座，它们只接收
 * 这一个 context 参数，避免每个 composable 摊开七八个 ref。
 *
 * 边界约定：
 * 1. 只收“跨区块共享”的状态。单一区块私有状态（查找替换表单、
 *    高亮对话框草稿等）必须留在使用它的组件里，不要加进来。
 *    `tableRows` / `tableRowIndexById` 依赖草稿行、排序与筛选，
 *    由 P1-2（useLedgerRecords）收编后再进入 context。
 * 2. 返回值一律是散装 ref / computed / 函数。调用方必须在
 *    `<script setup>` 顶层解构（`const { records } = useLedgerContext()`），
 *    不能改成命名空间调用——组件测试通过 `_instance.setupState`
 *    直接读取这些成员，命名空间化会让它们从 setupState 消失。
 * 3. 不要返回 `reactive()` 对象：顶层解构会丢失响应性。
 */
export interface LedgerContext {
  /** 用户在项目标签中选中的项目 id。 */
  activeProjectId: Ref<string>;
  currentProject: ComputedRef<Project | undefined>;
  /**
   * 表格当前呈现的项目 id。加载下一项目期间保持上一项目的表头，
   * 避免 Element Plus 先按旧行布局新列、接口返回后再布局一次。
   */
  tableProjectId: Ref<string>;
  tableProject: ComputedRef<Project | undefined>;
  fields: ComputedRef<FieldDefinition[]>;
  fieldById: ComputedRef<Map<string, FieldDefinition>>;
  records: Ref<ProjectRecord[]>;
  /** 虚拟表格组件实例，用于滚动定位等命令式操作。 */
  tableRef: Ref<TableV2Instance | null>;
}

export function useLedgerContext(): LedgerContext {
  const appStore = useAppStore();
  const activeProjectId = ref("");
  const tableProjectId = ref("");
  const records = ref<ProjectRecord[]>([]);
  const tableRef = ref<TableV2Instance | null>(null);
  const currentProject = computed(() => appStore.projectById(activeProjectId.value));
  const tableProject = computed(() => appStore.projectById(tableProjectId.value));
  const fields = computed(() =>
    (tableProject.value?.fields ?? [])
      .filter((field) => !field.hidden)
      .slice()
      .sort((left, right) => left.sort_order - right.sort_order),
  );
  const fieldById = computed(() => new Map(fields.value.map((field) => [field.id, field])));
  return {
    activeProjectId,
    currentProject,
    tableProjectId,
    tableProject,
    fields,
    fieldById,
    records,
    tableRef,
  };
}
