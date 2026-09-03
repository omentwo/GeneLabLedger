import { apiRequest } from "@/api/client";
import type {
  NativePreviewAction,
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
    action: NativePreviewAction;
    scope: LedgerPreviewScope;
    cells?: Array<{ record_id: string; field_id: string }>;
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
