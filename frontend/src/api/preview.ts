import { apiRequest } from "@/api/client";
import type {
  NativePreviewTask,
  PreviewCapabilities,
  PrintEngine,
} from "@/types/api";

export type LedgerPreviewScope = "selection" | "project" | "filtered" | "all";

export const DEFAULT_LEDGER_PREVIEW_SCOPE: LedgerPreviewScope = "project";

export function getPreviewCapabilities(): Promise<PreviewCapabilities> {
  return apiRequest<PreviewCapabilities>("/preview/capabilities");
}

export function createLedgerNativePreview(
  ledgerId: string,
  payload: {
    scope: LedgerPreviewScope;
    include_locked?: boolean;
    cells?: Array<{ record_id: string; field_id: string }>;
    /** WYSIWYG：当前筛选/显示范围下的记录 id 集合（scope="project" 时使用）。 */
    record_ids?: string[];
    search?: string;
    status?: string;
    experiment_date?: string;
    print_engine?: PrintEngine;
  },
): Promise<NativePreviewTask> {
  return apiRequest<NativePreviewTask>(`/ledgers/${ledgerId}/native-preview`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getNativePreviewStatus(jobId: string): Promise<NativePreviewTask> {
  return apiRequest<NativePreviewTask>(`/native-preview/${jobId}`);
}
