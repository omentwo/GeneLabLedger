<script setup lang="ts">
import { FolderOpen as FolderOpened, RotateCw as RefreshRight, Settings2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";

import {
  getDatabaseBackupSettings,
  getDatabaseBackupStatus,
  listDatabaseBackups,
  prepareDatabaseBackupRestore,
  runDatabaseBackup,
  updateDatabaseBackupSettings,
  type DatabaseBackupItem,
  type DatabaseBackupSettings,
  type DatabaseBackupStatus,
} from "@/api/databaseBackups";
import {
  DEFAULT_LEDGER_DISPLAY_SETTINGS,
  LEDGER_FONT_FAMILY_OPTIONS,
  LEDGER_FONT_SIZE_MAX,
  LEDGER_FONT_SIZE_MIN,
  LEDGER_FONT_SIZE_STEP,
  LEDGER_EDITOR_HEIGHT_MIN,
  LEDGER_EDITOR_SIZE_MAX,
  LEDGER_EDITOR_SIZE_STEP,
  LEDGER_EDITOR_WIDTH_MIN,
  LEDGER_DISPLAY_SETTINGS_KEY,
  LEDGER_ROW_PADDING_MAX,
  LEDGER_ROW_PADDING_MIN,
  LEDGER_ZOOM_MAX,
  LEDGER_ZOOM_MIN,
  LEDGER_ZOOM_STEP,
  getSetting,
  normalizeLedgerDisplaySettings,
  putSetting,
  type LedgerDisplaySettings,
} from "@/api/system";
import { desktopBridge } from "@/utils/desktop";
import { currentTheme, setTheme, THEME_OPTIONS, type ThemeId } from "@/utils/themePreference";

function selectTheme(theme: ThemeId): void {
  if (!setTheme(theme)) {
    ElMessage.warning("配色已切换，但本机存储不可用，关闭窗口后可能无法保留。");
  }
}

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
const backupSettings = reactive<DatabaseBackupSettings>({
  enabled: true,
  directory: "",
  interval_hours: 1,
  retention_backup_days: 7,
  copies_per_day: 30,
  backup_on_shutdown: true,
});
const backupStatus = ref<DatabaseBackupStatus | null>(null);
const backupHistory = ref<DatabaseBackupItem[]>([]);
const backupLoading = ref(false);
const backupSaving = ref(false);
const backupRunning = ref(false);
const backupRestoring = ref(false);

function formatBackupTime(value: string | null | undefined): string {
  if (!value) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatBackupSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function loadBackupData(): Promise<void> {
  backupLoading.value = true;
  try {
    const [settings, status, history] = await Promise.all([
      getDatabaseBackupSettings(),
      getDatabaseBackupStatus(),
      listDatabaseBackups(),
    ]);
    Object.assign(backupSettings, settings);
    backupStatus.value = status;
    backupHistory.value = history;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "备份设置读取失败");
  } finally {
    backupLoading.value = false;
  }
}

async function chooseBackupDirectory(): Promise<void> {
  if (!bridge) return;
  const result = await bridge.chooseDirectory(backupSettings.directory);
  if (result.selected) backupSettings.directory = result.directory;
}

async function saveBackupSettings(): Promise<void> {
  backupSaving.value = true;
  try {
    const result = await updateDatabaseBackupSettings({ ...backupSettings });
    Object.assign(backupSettings, result);
    backupStatus.value = await getDatabaseBackupStatus();
    ElMessage.success("自动备份设置已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "自动备份设置保存失败");
  } finally {
    backupSaving.value = false;
  }
}

async function runBackupNow(): Promise<void> {
  backupRunning.value = true;
  try {
    await runDatabaseBackup();
    await loadBackupData();
    ElMessage.success("完整业务备份已完成");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "立即备份失败");
  } finally {
    backupRunning.value = false;
  }
}

async function restoreBackup(): Promise<void> {
  if (!bridge) return;
  const selected = await bridge.chooseBackupFile(backupSettings.directory);
  if (!selected.selected) return;
  try {
    await ElMessageBox.prompt(
      "恢复会先创建当前数据的安全备份，然后在重启时替换数据库和报告模板。请输入“恢复”继续。",
      "恢复完整业务备份",
      {
        confirmButtonText: "准备恢复并重启",
        cancelButtonText: "取消",
        type: "warning",
        inputPlaceholder: "请输入：恢复",
        inputValidator: (value) => value.trim() === "恢复" || "请输入“恢复”确认",
      },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    throw error;
  }
  backupRestoring.value = true;
  try {
    const result = await prepareDatabaseBackupRestore(selected.path);
    ElMessage.success(`恢复任务已准备；当前数据安全备份位于：${result.safety_backup_path}`);
    await bridge.restart();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "备份恢复准备失败");
  } finally {
    backupRestoring.value = false;
  }
}

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
  void loadBackupData();
});
</script>

<template>
  <div class="grid gap-4 workspace-page settings-page">
    <header class="workspace-heading">
      <Settings2 :stroke-width="1.6" aria-hidden="true" />
      <div><h1>数据与设置</h1><p>调整工作习惯，管理本机数据与显示偏好。</p></div>
    </header>
    <section class="page-card overflow-hidden" aria-labelledby="theme-heading">
      <div class="page-card-header">
        <div>
          <h2 id="theme-heading" class="page-card-title">配色风格</h2>
          <p class="page-description">选择后立即生效并自动记住，下次打开沿用；快速录入窗口同步切换。</p>
        </div>
      </div>
      <div class="theme-options" role="radiogroup" aria-labelledby="theme-heading">
        <label v-for="theme in THEME_OPTIONS" :key="theme.id" class="theme-option" :class="{ 'is-selected': currentTheme === theme.id }">
          <input type="radio" name="color-theme" :value="theme.id" :checked="currentTheme === theme.id" @change="selectTheme(theme.id)" />
          <span class="theme-option-body">
            <span class="theme-swatches" aria-hidden="true">
              <span v-for="color in theme.colors" :key="color" :style="{ backgroundColor: color }" />
            </span>
            <strong>{{ theme.name }}</strong>
            <span class="theme-description">{{ theme.description }}</span>
            <span class="theme-selection">{{ currentTheme === theme.id ? "当前使用" : "选择此风格" }}</span>
          </span>
        </label>
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
        <div class="grid max-w-4xl gap-5 lg:grid-cols-2">
          <div class="grid gap-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm font-semibold text-slate-700">台账字体</span>
              <span class="text-sm text-slate-500">{{ ledgerDisplaySettings.fontSizePx }} px</span>
            </div>
            <el-select
              v-model="ledgerDisplaySettings.fontFamily"
              :disabled="ledgerDisplayLoading || ledgerDisplaySaving"
            >
              <el-option
                v-for="option in LEDGER_FONT_FAMILY_OPTIONS"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
            <el-slider
              v-model="ledgerDisplaySettings.fontSizePx"
              :min="LEDGER_FONT_SIZE_MIN"
              :max="LEDGER_FONT_SIZE_MAX"
              :step="LEDGER_FONT_SIZE_STEP"
              :disabled="ledgerDisplayLoading || ledgerDisplaySaving"
              show-input
            />
          </div>

          <div class="grid gap-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm font-semibold text-slate-700">台账缩放</span>
              <span class="text-sm text-slate-500">{{ ledgerDisplaySettings.zoomPercent }}%</span>
            </div>
            <el-slider
              v-model="ledgerDisplaySettings.zoomPercent"
              :min="LEDGER_ZOOM_MIN"
              :max="LEDGER_ZOOM_MAX"
              :step="LEDGER_ZOOM_STEP"
              :disabled="ledgerDisplayLoading || ledgerDisplaySaving"
              show-input
            />
            <p class="text-xs leading-5 text-slate-500">
              只调整台账表格区域，不改变其他页面。
            </p>
          </div>
        </div>

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
          <h2 class="page-card-title">完整业务自动备份</h2>
          <p class="page-description">同时备份数据库和报告模板，可选择其他硬盘或可靠的同步目录。</p>
        </div>
        <el-tag :type="backupStatus?.last_error ? 'danger' : 'success'">
          {{ backupStatus?.running ? "正在备份" : backupStatus?.last_error ? "最近失败" : "运行正常" }}
        </el-tag>
      </div>
      <div v-loading="backupLoading" class="grid gap-5 p-5">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="默认每隔 1 小时备份一次；每个有备份的日期单独建文件夹，每天最多保留 30 份，只保留最近 7 个实际产生过备份的日期。"
        />

        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="grid gap-1">
            <span class="text-sm font-semibold text-slate-700">定时自动备份</span>
            <span class="text-xs text-slate-500">关闭后仍可手动备份，退出备份由下方开关单独控制。</span>
          </div>
          <el-switch v-model="backupSettings.enabled" active-text="开启" inactive-text="关闭" />
        </div>

        <div class="grid gap-2">
          <span class="text-sm font-semibold text-slate-700">备份位置</span>
          <div class="flex flex-wrap gap-2">
            <el-input v-model="backupSettings.directory" class="min-w-0 flex-1" readonly />
            <el-button :icon="FolderOpened" :disabled="!isDesktop" @click="chooseBackupDirectory">
              选择文件夹
            </el-button>
          </div>
        </div>

        <div class="grid gap-4 lg:grid-cols-3">
          <el-form-item label="备份间隔（小时）" class="mb-0">
            <el-input-number v-model="backupSettings.interval_hours" :min="1" :max="168" />
          </el-form-item>
          <el-form-item label="保留有备份的日期数" class="mb-0">
            <el-input-number v-model="backupSettings.retention_backup_days" :min="1" :max="365" />
          </el-form-item>
          <el-form-item label="每天最多保留份数" class="mb-0">
            <el-input-number v-model="backupSettings.copies_per_day" :min="1" :max="1000" />
          </el-form-item>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="grid gap-1">
            <span class="text-sm font-semibold text-slate-700">关闭软件时自动备份</span>
            <span class="text-xs text-slate-500">正常退出会等待备份完成；强制结束进程或断电无法保证执行。</span>
          </div>
          <el-switch
            v-model="backupSettings.backup_on_shutdown"
            active-text="开启"
            inactive-text="关闭"
          />
        </div>

        <div class="grid gap-2 rounded-lg bg-slate-100 p-4 text-sm text-slate-700 lg:grid-cols-2">
          <span>上次成功：{{ formatBackupTime(backupStatus?.last_success_at) }}</span>
          <span>下次计划：{{ formatBackupTime(backupStatus?.next_run_at) }}</span>
          <span class="break-all lg:col-span-2">最近文件：{{ backupStatus?.last_path || "尚无备份" }}</span>
          <span v-if="backupStatus?.last_error" class="text-red-600 lg:col-span-2">
            最近错误：{{ backupStatus.last_error }}
          </span>
        </div>

        <div class="flex flex-wrap gap-2">
          <el-button
            type="primary"
            :loading="backupSaving"
            :disabled="backupRunning || backupRestoring"
            @click="saveBackupSettings"
          >
            保存备份设置
          </el-button>
          <el-button
            :loading="backupRunning"
            :disabled="backupSaving || backupRestoring"
            @click="runBackupNow"
          >
            立即完整备份
          </el-button>
          <el-button
            type="warning"
            plain
            :loading="backupRestoring"
            :disabled="!isDesktop || backupSaving || backupRunning"
            @click="restoreBackup"
          >
            从备份恢复
          </el-button>
        </div>

        <div v-if="backupHistory.length" class="grid gap-2">
          <span class="text-sm font-semibold text-slate-700">最近备份</span>
          <el-table :data="backupHistory.slice(0, 10)" size="small" max-height="320">
            <el-table-column prop="backup_date" label="备份日期" width="120" />
            <el-table-column label="创建时间" width="190">
              <template #default="{ row }: { row: DatabaseBackupItem }">
                {{ formatBackupTime(row.created_at) }}
              </template>
            </el-table-column>
            <el-table-column prop="filename" label="文件" min-width="260" show-overflow-tooltip />
            <el-table-column label="大小" width="100" align="right">
              <template #default="{ row }: { row: DatabaseBackupItem }">
                {{ formatBackupSize(row.size_bytes) }}
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </section>

    <section class="page-card p-5">
      <h2 class="page-card-title">数据安全说明</h2>
      <ul class="mt-3 grid list-disc gap-2 pl-5 text-sm leading-6 text-slate-600">
        <li>每条台账记录使用独立 UUID；病理号相同也不会互相覆盖或联动。</li>
        <li>更换目录后原目录保持原样，软件不会自动复制、移动或删除文件。</li>
        <li>完整业务备份包同时包含 ledger.db 和 templates 目录，并在恢复前校验文件清单与数据库完整性。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.theme-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; padding: 20px; }
.theme-option { display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding: 16px; border: 1px solid var(--app-border-strong); border-radius: 12px; background: var(--app-bg); cursor: pointer; }
.theme-option:hover { background: var(--app-hover); }
.theme-option.is-selected { border-color: var(--app-primary); box-shadow: inset 0 0 0 1px var(--app-primary); background: var(--app-primary-soft); }
.theme-option:focus-within { outline: 2px solid var(--app-primary); outline-offset: 3px; }
.theme-option input { margin: 4px 0 0; accent-color: var(--app-primary); }
.theme-option-body { display: grid; gap: 9px; min-width: 0; }
.theme-swatches { display: flex; gap: 6px; }
.theme-swatches > span { width: 28px; height: 28px; border: 1px solid var(--app-border-strong); border-radius: 50%; }
.theme-description { color: var(--app-muted); font-size: 12px; line-height: 1.7; }
.theme-selection { color: var(--app-primary-text); font-size: 12px; font-weight: 600; }
.settings-page .text-slate-500, .settings-page .text-slate-600 { color: var(--app-muted); }
.settings-page .text-slate-700 { color: var(--app-text); }
.settings-page .bg-slate-100 { background: var(--app-surface-soft); }
@media (max-width: 800px) { .theme-options { grid-template-columns: minmax(0, 1fr); } }
</style>
