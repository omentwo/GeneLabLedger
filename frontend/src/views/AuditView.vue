<script setup lang="ts">
import { Search } from "@element-plus/icons-vue";
import { onMounted, ref } from "vue";

import { listAuditLogs } from "@/api/system";
import type { AuditLog } from "@/types/api";
import { formatShanghaiDateTime } from "@/utils/datetime";

const search = ref("");
const logs = ref<AuditLog[]>([]);
const PAGE_SIZE = 50;
const currentPage = ref(1);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref("");

const actionLabels: Record<string, string> = {
  "project.create": "添加项目",
  "project.update": "修改项目",
  "project.delete": "删除项目",
  "field.create": "添加表头",
  "field.update": "修改表头",
  "field.delete": "删除表头",
  "field.reorder": "调整表头顺序",
  "field.options.replace": "修改备选项",
  "record.create": "新增台账记录",
  "record.update": "修改台账记录",
  "record.highlight.update": "标记台账底色",
  "record.delete": "删除台账记录",
  "record.lock": "锁定台账记录",
  "record.unlock": "解锁台账记录",
  "record.assign_project": "分配到其他项目",
  "record.experiment_number.update": "回写实验编号",
  "record.bulk_delete": "按日期批量删除台账记录",
  "record.import.create": "导入新增台账记录",
  "record.import.update": "导入更新台账记录",
  "record.import.commit": "提交 Excel 导入",
  "report_template.create": "添加报告模板",
  "report_template.version.create": "添加模板版本",
  "report_template.mappings.replace": "保存模板映射",
  "report_template.delete": "删除报告模板",
  "auto_export.task.create": "添加自动导出任务",
  "auto_export.task.update": "修改自动导出任务",
  "auto_export.task.delete": "删除自动导出任务",
  "auto_export.run.success": "自动导出成功",
  "auto_export.run.failed": "自动导出失败",
  "setting.update": "修改系统设置",
};

const entityLabels: Record<string, string> = {
  project: "检测项目",
  field: "台账表头",
  project_record: "台账记录",
  report_template: "报告模板",
  report_template_version: "模板版本",
  auto_export_task: "自动导出任务",
  app_setting: "系统设置",
};

async function loadLogs(pageNumber = currentPage.value): Promise<void> {
  loading.value = true;
  errorMessage.value = "";
  try {
    currentPage.value = pageNumber;
    const page = await listAuditLogs(search.value, PAGE_SIZE, (pageNumber - 1) * PAGE_SIZE);
    logs.value = page.items;
    total.value = page.total;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "日志读取失败";
  } finally {
    loading.value = false;
  }
}

function resetSearch(): void {
  search.value = "";
  void loadLogs(1);
}

onMounted(() => {
  void loadLogs();
});
</script>

<template>
  <div class="page-stack">
    <section class="page-card">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">日志审计</h2>
          <p class="page-description">按最新操作优先，支持搜索操作人、病理号、对象编号和详情。</p>
        </div>
        <span class="muted">
          {{ loading ? "正在查询" : `${total} 条日志` }}
        </span>
      </div>
      <div class="page-card-body">
        <div class="toolbar">
          <el-input
            v-model="search"
            clearable
            placeholder="搜索操作人、操作类型、病理号、对象编号或详情"
            :prefix-icon="Search"
            style="max-width: 620px"
            @keyup.enter="loadLogs(1)"
            @clear="loadLogs(1)"
          />
          <el-button type="primary" :loading="loading" @click="loadLogs(1)">搜索</el-button>
          <el-button @click="resetSearch">重置</el-button>
        </div>
      </div>
    </section>

    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
    />

    <section class="page-card">
      <el-table
        v-loading="loading"
        :data="logs"
        row-key="id"
        border
        empty-text="暂无审计日志"
        max-height="calc(100vh - 245px)"
      >
        <el-table-column label="时间" width="180">
          <template #default="{ row }: { row: AuditLog }">
            {{ formatShanghaiDateTime(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column prop="actor" label="操作人" width="100">
          <template #default="{ row }: { row: AuditLog }">
            <el-tag effect="plain">{{ row.actor }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="150">
          <template #default="{ row }: { row: AuditLog }">
            <span :title="row.action">{{ actionLabels[row.action] ?? row.action }}</span>
          </template>
        </el-table-column>
        <el-table-column label="数据类型" width="130">
          <template #default="{ row }: { row: AuditLog }">
            {{ entityLabels[row.entity_type] ?? row.entity_type }}
          </template>
        </el-table-column>
        <el-table-column prop="entity_id" label="对象编号" min-width="220">
          <template #default="{ row }: { row: AuditLog }">
            <code>{{ row.entity_id || "—" }}</code>
          </template>
        </el-table-column>
        <el-table-column label="详情" width="110" fixed="right">
          <template #default="{ row }: { row: AuditLog }">
            <el-popover placement="left" :width="460" trigger="click">
              <template #reference>
                <el-button link type="primary">查看详情</el-button>
              </template>
              <pre class="audit-details">{{ JSON.stringify(row.details, null, 2) }}</pre>
            </el-popover>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="total" class="pagination-row">
        <el-pagination
          v-model:current-page="currentPage"
          background
          layout="total, prev, pager, next, jumper"
          :page-size="PAGE_SIZE"
          :total="total"
          :disabled="loading"
          @current-change="loadLogs"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.audit-details {
  max-height: 360px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}

.pagination-row {
  display: flex;
  justify-content: center;
  padding: 12px;
}

code {
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
