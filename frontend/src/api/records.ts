import { apiRequest, jsonBody } from "@/api/client";
import type {
  BulkDeleteFilter,
  BulkDeletePreview,
  BulkDeleteResult,
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
  RecordUpdateInput,
} from "@/types/api";

export type RecordSearchScope = "current" | "all" | "selected";

export interface RecordQuery {
  project_id?: string;
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

export function queryRecordIds(
  query: RecordComplexQuery,
  signal?: AbortSignal,
): Promise<RecordIdList> {
  return apiRequest<RecordIdList>("/records/query/ids", {
    method: "POST",
    body: jsonBody(query),
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

export function previewReplace(payload: {
  project_id: string;
  field_id: string;
  record_ids: string[];
  find: string;
  replacement: string;
  match_mode: "substring" | "whole";
  case_sensitive: boolean;
}): Promise<RecordReplacePreview> {
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

export function getRecord(recordId: string): Promise<ProjectRecord> {
  return apiRequest<ProjectRecord>(`/records/${recordId}`);
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

export function assignRecordProject(
  recordId: string,
  targetProjectId: string,
): Promise<ProjectRecord> {
  return apiRequest<ProjectRecord>(`/records/${recordId}/assign-project`, {
    method: "POST",
    body: jsonBody({ target_project_id: targetProjectId }),
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

export function previewBulkDelete(
  filter: BulkDeleteFilter,
): Promise<BulkDeletePreview> {
  return apiRequest<BulkDeletePreview>("/records/bulk-delete/preview", {
    method: "POST",
    body: jsonBody(filter),
  });
}

export function executeBulkDelete(
  filter: BulkDeleteFilter,
  expectedRecordIds: string[],
): Promise<BulkDeleteResult> {
  return apiRequest<BulkDeleteResult>("/records/bulk-delete/execute", {
    method: "POST",
    body: jsonBody({
      filter,
      expected_record_ids: expectedRecordIds,
    }),
  });
}
