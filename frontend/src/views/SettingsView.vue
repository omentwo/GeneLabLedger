<script setup lang="ts">
import { FolderOpened, RefreshRight } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";

import { desktopBridge } from "@/utils/desktop";

const bridge = desktopBridge();
const currentDirectory = ref(bridge?.dataDirectory ?? "");
const pendingDirectory = ref("");
const changing = ref(false);
const isDesktop = computed(() => Boolean(bridge));

async function changeDataDirectory(): Promise<void> {
  if (!bridge) return;
  try {
    await ElMessageBox.confirm(
      "更改位置不会搬移当前数据库。选择空目录会得到一套新数据；选择原数据目录可切换回来。是否继续？",
      "更改业务数据目录",
      {
        confirmButtonText: "继续选择目录",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    throw error;
  }

  changing.value = true;
  try {
    const result = await bridge.changeDataDirectory();
    if (!result.changed) return;
    pendingDirectory.value = result.directory;
    ElMessage.success("新数据目录已保存，重启后生效");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "数据目录更改失败");
  } finally {
    changing.value = false;
  }
}

async function restartApplication(): Promise<void> {
  if (!bridge) return;
  await bridge.restart();
}
</script>

<template>
  <div class="grid gap-4">
    <section class="page-card overflow-hidden">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">业务数据目录</h2>
          <p class="page-description">数据库、报告模板和内部临时文件统一存放于此。</p>
        </div>
        <el-tag :type="isDesktop ? 'success' : 'info'">
          {{ isDesktop ? "Electron 桌面版" : "浏览器开发模式" }}
        </el-tag>
      </div>
      <div class="grid gap-4 p-5">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="软件只记录目录位置，不会自动迁移或删除任何数据库文件。共享盘必须保证稳定连接和可靠备份。"
        />
        <div class="grid gap-2">
          <span class="text-xs font-semibold text-slate-500">当前正在使用</span>
          <code class="break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
            {{ currentDirectory || "仅 Electron 桌面版可查看" }}
          </code>
        </div>
        <div v-if="pendingDirectory" class="grid gap-2">
          <span class="text-xs font-semibold text-amber-700">重启后切换到</span>
          <code class="break-all rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {{ pendingDirectory }}
          </code>
        </div>
        <div class="flex flex-wrap gap-2">
          <el-button
            type="primary"
            :icon="FolderOpened"
            :loading="changing"
            :disabled="!isDesktop"
            @click="changeDataDirectory"
          >
            选择其他数据目录
          </el-button>
          <el-button
            v-if="pendingDirectory"
            type="warning"
            :icon="RefreshRight"
            @click="restartApplication"
          >
            立即重启并切换
          </el-button>
        </div>
      </div>
    </section>

    <section class="page-card p-5">
      <h2 class="page-card-title">数据安全说明</h2>
      <ul class="mt-3 grid list-disc gap-2 pl-5 text-sm leading-6 text-slate-600">
        <li>每条台账记录使用独立 UUID；病理号相同也不会互相覆盖或联动。</li>
        <li>更换目录后原目录保持原样，软件不会自动复制、移动或删除文件。</li>
        <li>数据库文件名为 ledger.db；备份时应同时备份 templates 目录。</li>
      </ul>
    </section>
  </div>
</template>
