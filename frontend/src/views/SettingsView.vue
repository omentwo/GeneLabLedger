<script setup lang="ts">
import { FolderOpened, RefreshRight } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";

import {
  DEFAULT_LEDGER_DISPLAY_SETTINGS,
  LEDGER_EDITOR_HEIGHT_MIN,
  LEDGER_EDITOR_SIZE_MAX,
  LEDGER_EDITOR_SIZE_STEP,
  LEDGER_EDITOR_WIDTH_MIN,
  LEDGER_DISPLAY_SETTINGS_KEY,
  LEDGER_ROW_PADDING_MAX,
  LEDGER_ROW_PADDING_MIN,
  getSetting,
  normalizeLedgerDisplaySettings,
  putSetting,
  type LedgerDisplaySettings,
} from "@/api/system";
import { desktopBridge } from "@/utils/desktop";

const bridge = desktopBridge();
const currentDirectory = ref(bridge?.dataDirectory ?? "");
const pendingDirectory = ref("");
const changing = ref(false);
const isDesktop = computed(() => Boolean(bridge));
const alwaysOnTop = ref(false);
const alwaysOnTopLoading = ref(false);
const ledgerDisplaySettings = reactive<LedgerDisplaySettings>({
  ...DEFAULT_LEDGER_DISPLAY_SETTINGS,
});
const ledgerDisplayLoading = ref(false);
const ledgerDisplaySaving = ref(false);

async function loadLedgerDisplaySettings(): Promise<void> {
  ledgerDisplayLoading.value = true;
  try {
    const result = await getSetting<Partial<LedgerDisplaySettings>>(LEDGER_DISPLAY_SETTINGS_KEY);
    Object.assign(ledgerDisplaySettings, normalizeLedgerDisplaySettings(result.value));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "台账显示设置读取失败");
  } finally {
    ledgerDisplayLoading.value = false;
  }
}

async function saveLedgerDisplaySettings(): Promise<void> {
  ledgerDisplaySaving.value = true;
  try {
    const value = normalizeLedgerDisplaySettings(ledgerDisplaySettings);
    const result = await putSetting(LEDGER_DISPLAY_SETTINGS_KEY, value);
    Object.assign(ledgerDisplaySettings, normalizeLedgerDisplaySettings(result.value));
    ElMessage.success("台账显示设置已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "台账显示设置保存失败");
  } finally {
    ledgerDisplaySaving.value = false;
  }
}

function resetLedgerDisplaySettings(): void {
  Object.assign(ledgerDisplaySettings, DEFAULT_LEDGER_DISPLAY_SETTINGS);
}

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

async function loadAlwaysOnTop(): Promise<void> {
  if (!bridge) return;
  alwaysOnTopLoading.value = true;
  try {
    alwaysOnTop.value = await bridge.getAlwaysOnTop();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "置顶状态读取失败");
  } finally {
    alwaysOnTopLoading.value = false;
  }
}

async function updateAlwaysOnTop(value: string | number | boolean): Promise<void> {
  if (!bridge) return;
  const nextValue = Boolean(value);
  alwaysOnTopLoading.value = true;
  try {
    alwaysOnTop.value = await bridge.setAlwaysOnTop(nextValue);
    ElMessage.success(alwaysOnTop.value ? "窗口已始终保持最顶层" : "已关闭始终保持最顶层");
  } catch (error) {
    alwaysOnTop.value = !nextValue;
    ElMessage.error(error instanceof Error ? error.message : "置顶设置保存失败");
  } finally {
    alwaysOnTopLoading.value = false;
  }
}

onMounted(() => {
  void loadLedgerDisplaySettings();
  void loadAlwaysOnTop();
});
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

    <section class="page-card overflow-hidden">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">窗口显示</h2>
          <p class="page-description">控制应用窗口是否始终显示在其他窗口上方。</p>
        </div>
        <el-tag :type="isDesktop ? 'success' : 'info'">
          {{ isDesktop ? "Electron 可用" : "浏览器模式不可用" }}
        </el-tag>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-4 p-5">
        <div class="grid gap-1">
          <span class="text-sm font-semibold text-slate-700">始终保持最顶层</span>
          <span class="text-xs leading-5 text-slate-500">
            开启后窗口会保持在其他应用窗口上方，也可以使用 Ctrl+Shift+T 快速切换。
          </span>
        </div>
        <el-switch
          v-model="alwaysOnTop"
          :loading="alwaysOnTopLoading"
          :disabled="!isDesktop"
          active-text="开启"
          inactive-text="关闭"
          @change="updateAlwaysOnTop"
        />
      </div>
    </section>

    <section class="page-card overflow-hidden">
      <div class="page-card-header">
        <div>
          <h2 class="page-card-title">台账显示</h2>
          <p class="page-description">调整记录之间的间隔，以及输入框在单元格中的宽度和高度。</p>
        </div>
        <el-tag type="info">全局设置</el-tag>
      </div>
      <div class="grid gap-5 p-5">
        <div class="grid max-w-2xl gap-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-semibold text-slate-700">记录之间间距</span>
            <span class="text-sm text-slate-500">间隔 {{ ledgerDisplaySettings.rowPaddingY }} px</span>
          </div>
          <el-slider
            v-model="ledgerDisplaySettings.rowPaddingY"
            :min="LEDGER_ROW_PADDING_MIN"
            :max="LEDGER_ROW_PADDING_MAX"
            :step="1"
            :disabled="ledgerDisplayLoading || ledgerDisplaySaving"
            show-input
          />
          <p class="text-xs leading-5 text-slate-500">数值越大，记录之间的空白越大；输入内容会保持垂直居中。</p>
        </div>

        <div class="grid max-w-4xl gap-5 lg:grid-cols-2">
          <div class="grid gap-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm font-semibold text-slate-700">输入框宽度占比</span>
              <span class="text-sm text-slate-500">{{ ledgerDisplaySettings.editorWidthPercent }}%</span>
            </div>
            <el-slider
              v-model="ledgerDisplaySettings.editorWidthPercent"
              :min="LEDGER_EDITOR_WIDTH_MIN"
              :max="LEDGER_EDITOR_SIZE_MAX"
              :step="LEDGER_EDITOR_SIZE_STEP"
              :disabled="ledgerDisplayLoading || ledgerDisplaySaving"
              show-input
            />
            <p class="text-xs leading-5 text-slate-500">控制输入框占当前字段单元格可用宽度的比例。</p>
          </div>

          <div class="grid gap-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm font-semibold text-slate-700">输入框高度占比</span>
              <span class="text-sm text-slate-500">{{ ledgerDisplaySettings.editorHeightPercent }}%</span>
            </div>
            <el-slider
              v-model="ledgerDisplaySettings.editorHeightPercent"
              :min="LEDGER_EDITOR_HEIGHT_MIN"
              :max="LEDGER_EDITOR_SIZE_MAX"
              :step="LEDGER_EDITOR_SIZE_STEP"
              :disabled="ledgerDisplayLoading || ledgerDisplaySaving"
              show-input
            />
            <p class="text-xs leading-5 text-slate-500">控制输入框占当前字段单元格可用高度的比例。</p>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <el-button
            type="primary"
            :loading="ledgerDisplaySaving"
            :disabled="ledgerDisplayLoading"
            @click="saveLedgerDisplaySettings"
          >
            保存台账显示设置
          </el-button>
          <el-button :disabled="ledgerDisplayLoading || ledgerDisplaySaving" @click="resetLedgerDisplaySettings">
            恢复默认
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
