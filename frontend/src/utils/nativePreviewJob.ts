import { ElMessage } from "element-plus";

import { getNativePreviewStatus, getPreviewCapabilities } from "@/api/preview";
import type { NativePreviewTask, PreviewCapabilities, PrintEngine } from "@/types/api";

/**
 * 台账页（Excel/WPS 表格）与报告页（Office/WPS 文档）共享的原生预览支撑：
 * 引擎能力判定、引擎显示名和“打开-轮询-关闭”任务监听。
 * 两处窗口的轮询节奏、失败重试与消息文案规则必须保持一致，
 * 因此集中在这里，仅由调用方注入文案与退出条件。
 */

export type NativeOfficeFamily = "spreadsheet" | "writer";

/** 轮询上限 16 小时（28800 次 × 2s），期间随页面卸载退出。 */
const MAX_POLL_ATTEMPTS = 28_800;
const POLL_INTERVAL_OPENED = 2000;
const POLL_INTERVAL_STARTING = 500;
const MAX_CONSECUTIVE_FAILURES = 5;

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function fetchPreviewCapabilities(): Promise<PreviewCapabilities | null> {
  try {
    return await getPreviewCapabilities();
  } catch {
    return null;
  }
}

export function isNativeEngineAvailable(
  capabilities: PreviewCapabilities | null,
  engine: PrintEngine,
  family: NativeOfficeFamily,
): boolean {
  if (!capabilities) return true;
  if (engine === "auto") return capabilities.native_preview;
  if (engine === "word") {
    return family === "spreadsheet" ? capabilities.microsoft_spreadsheet : capabilities.microsoft_writer;
  }
  return family === "spreadsheet" ? capabilities.wps_spreadsheet : capabilities.wps_writer;
}

export function nativeEngineLabelFor(
  engine: PrintEngine,
  wordLabel: string,
  autoLabel: string,
): string {
  if (engine === "word") return wordLabel;
  if (engine === "wps") return "WPS";
  return autoLabel;
}

export async function monitorNativePreviewJob(
  task: NativePreviewTask,
  options: {
    isDisposed: () => boolean;
    engineLabel: () => string;
    failedMessage: string;
  },
): Promise<void> {
  let current = task;
  let openedNotified = false;
  let failures = 0;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (options.isDisposed()) return;
    if (current.status === "failed") {
      ElMessage.error(current.error || options.failedMessage);
      return;
    }
    if (current.status === "open" && !openedNotified) {
      openedNotified = true;
      ElMessage.success(`${options.engineLabel()} 原生窗口已打开`);
    }
    if (current.status === "completed") {
      ElMessage.info(`${options.engineLabel()} 原生窗口已关闭`);
      return;
    }
    await sleep(openedNotified ? POLL_INTERVAL_OPENED : POLL_INTERVAL_STARTING);
    if (options.isDisposed()) return;
    try {
      current = await getNativePreviewStatus(task.job_id);
      failures = 0;
    } catch (error) {
      if (options.isDisposed()) return;
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) throw error;
    }
  }
}
