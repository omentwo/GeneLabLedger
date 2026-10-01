import { apiRequest, jsonBody } from "@/api/client";
import type {
  ProjectRecord,
  RecordBatchNewRecord,
  RecordCellBatchCommitResult,
  RecordCellBatchPreview,
  RecordCellChange,
  RecordComplexQuery,
  RecordCreateInput,
  RecordList,
  RecordIdList,
  RecordOperationApplyInput,
  RecordOperationApplyResult,
  RecordReplacePreview,
  RecordReorderByDatePreview,
  RecordReorderByDateResult,
  RecordUpdateInput,
} from "@/types/api";

export type RecordSearchScope = "current" | "all" | "selected";

export interface RecordQuery {
  project_id?: string;
  include_locked?: boolean;
  scope?: RecordSearchScope;
  project_ids?: string[];
  status?: string;
  search?: string;
  experiment_date?: string;
  report_generated?: boolean;
  limit?: number;
  offset?: number;
}

function queryString(query: RecordQuery): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== "") params.append(key, String(item));
      });
      return;
    }
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function listRecords(query: RecordQuery = {}, signal?: AbortSignal): Promise<RecordList> {
  return apiRequest<RecordList>(`/records${queryString(query)}`, { signal });
}

export function queryRecords(
  query: RecordComplexQuery,
  signal?: AbortSignal,
): Promise<RecordList> {
  return apiRequest<RecordList>("/records/query", {
    method: "POST",
    body: jsonBody(query),
    signal,
  });
}

/** Returns every ID in the query scope, independently of record pagination. */
export function queryRecordIds(
  query: Omit<RecordComplexQuery, "limit" | "offset">,
  signal?: AbortSignal,
): Promise<RecordIdList> {
  return apiRequest<RecordIdList>("/records/query/ids", {
    method: "POST",
    body: jsonBody(Object.fromEntries(Object.entries(query).filter(([key]) => key !== "limit" && key !== "offset"))),
    signal,
  });
}

export function getRecordsByIds(recordIds: string[]): Promise<ProjectRecord[]> {
  return apiRequest<ProjectRecord[]>("/records/by-ids", {
    method: "POST",
    body: jsonBody({ record_ids: recordIds }),
  });
}

export function previewCellBatch(
  projectId: string,
  changes: RecordCellChange[],
  newRecords: RecordBatchNewRecord[] = [],
): Promise<RecordCellBatchPreview> {
  return apiRequest<RecordCellBatchPreview>("/records/cell-batches/preview", {
    method: "POST",
    body: jsonBody({ project_id: projectId, changes, new_records: newRecords }),
  });
}

export function commitCellBatch(
  token: string,
  acceptWarnings = false,
  includeSnapshots = false,
): Promise<RecordCellBatchCommitResult> {
  return apiRequest<RecordCellBatchCommitResult>("/records/cell-batches/commit", {
    method: "POST",
    body: jsonBody({
      token,
      accept_warnings: acceptWarnings,
      include_snapshots: includeSnapshots,
    }),
  });
}

export const FIND_REPLACE_RECORD_LIMIT = 20_000;

export function previewReplace(payload: {
  project_id: string;
  field_id: string;
  record_ids: string[];
  find: string;
  replacement: string;
  match_mode: "substring" | "whole";
  case_sensitive: boolean;
}): Promise<RecordReplacePreview> {
  if (payload.record_ids.length > FIND_REPLACE_RECORD_LIMIT) {
    return Promise.reject(new Error(`当前范围有 ${payload.record_ids.length.toLocaleString("zh-CN")} 条记录，单次查找替换最多 ${FIND_REPLACE_RECORD_LIMIT.toLocaleString("zh-CN")} 条；请缩小筛选或选中范围后重试。`));
  }
  return apiRequest<RecordReplacePreview>("/records/replace/preview", {
    method: "POST",
    body: jsonBody(payload),
  });
}

export function commitReplace(
  token: string,
  acceptWarnings = false,
): Promise<RecordCellBatchCommitResult> {
  return apiRequest<RecordCellBatchCommitResult>("/records/replace/commit", {
    method: "POST",
    body: jsonBody({ token, accept_warnings: acceptWarnings, include_snapshots: false }),
  });
}

export function createRecord(payload: RecordCreateInput): Promise<ProjectRecord> {
  return apiRequest<ProjectRecord>("/records", {
    method: "POST",
    body: jsonBody(payload),
  });
}

export function updateRecord(
  recordId: string,
  payload: RecordUpdateInput,
): Promise<ProjectRecord> {
  return apiRequest<ProjectRecord>(`/records/${recordId}`, {
    method: "PATCH",
    body: jsonBody(payload),
  });
}

export function quickCreateRecord(
  projectId: string,
  combinedPathologyNumber: string,
): Promise<ProjectRecord> {
  return apiRequest<ProjectRecord>("/records/quick-create", {
    method: "POST",
    body: jsonBody({
      project_id: projectId,
      combined_pathology_number: combinedPathologyNumber,
    }),
  });
}

export function previewReorderByDate(
  projectId: string,
  experimentDate: string,
): Promise<RecordReorderByDatePreview> {
  return apiRequest<RecordReorderByDatePreview>("/records/reorder-by-date/preview", {
    method: "POST",
    body: jsonBody({ project_id: projectId, experiment_date: experimentDate }),
  });
}

export function applyReorderByDate(
  projectId: string,
  experimentDate: string,
  expectedOrderHash: string,
): Promise<RecordReorderByDateResult> {
  return apiRequest<RecordReorderByDateResult>("/records/reorder-by-date/apply", {
    method: "POST",
    body: jsonBody({
      project_id: projectId,
      experiment_date: experimentDate,
      expected_order_hash: expectedOrderHash,
    }),
  });
}

export function validateNewRecord(
  payload: RecordCreateInput,
): Promise<{ issues: import("@/types/api").RecordValidationIssue[] }> {
  return apiRequest<{ issues: import("@/types/api").RecordValidationIssue[] }>(
    "/records/validate-new",
    {
      method: "POST",
      body: jsonBody(payload),
    },
  );
}

export function applyRecordOperation(
  payload: RecordOperationApplyInput,
): Promise<RecordOperationApplyResult> {
  return apiRequest<RecordOperationApplyResult>("/records/operations/apply", {
    method: "POST",
    body: jsonBody(payload),
  });
}

export function assignExperimentNumbers(
  recordIds: string[],
  prefix: string,
): Promise<ProjectRecord[]> {
  return apiRequest<ProjectRecord[]>("/records/experiment-numbers", {
    method: "POST",
    body: jsonBody({ record_ids: recordIds, prefix }),
  });
}

export function setRecordLock(
  recordId: string,
  locked: boolean,
): Promise<ProjectRecord> {
  return apiRequest<ProjectRecord>(`/records/${recordId}/lock`, {
    method: "PUT",
    body: jsonBody({ locked }),
  });
}

export function deleteRecord(recordId: string): Promise<void> {
  return apiRequest<void>(`/records/${recordId}`, { method: "DELETE" });
}

export function setRecordsReportGenerated(
  recordIds: string[],
  reportGenerated: boolean,
): Promise<ProjectRecord[]> {
  return apiRequest<ProjectRecord[]>("/records/report-status", {
    method: "PUT",
    body: jsonBody({
      record_ids: recordIds,
      report_generated: reportGenerated,
    }),
  });
}

export function setRecordsHighlight(
  recordIds: string[],
  highlightColor: string | null,
): Promise<ProjectRecord[]> {
  return apiRequest<ProjectRecord[]>("/records/highlight", {
    method: "PUT",
    body: jsonBody({
      record_ids: recordIds,
      highlight_color: highlightColor,
    }),
  });
}

export type RecordCellHighlightTarget = { record_id: string; field_id: string };

export function setCellsHighlight(
  cells: RecordCellHighlightTarget[],
  highlightColor: string | null,
): Promise<ProjectRecord[]> {
  return apiRequest<ProjectRecord[]>("/records/cell-highlights", {
    method: "PUT",
    body: jsonBody({
      cells,
      highlight_color: highlightColor,
    }),
  });
}
