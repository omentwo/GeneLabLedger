import { apiRequest, jsonBody } from "@/api/client";
import type { WorkbookImportPreview, WorkbookImportRow } from "@/types/api";

export function previewWorkbookImport(
  projectId: string,
  file: File,
  sheetName = "",
): Promise<WorkbookImportPreview> {
  const form = new FormData();
  form.append("project_id", projectId);
  if (sheetName) form.append("sheet_name", sheetName);
  form.append("file", file);
  return apiRequest<WorkbookImportPreview>("/imports/workbook/preview", {
    method: "POST",
    body: form,
  });
}

export function commitWorkbookImport(
  projectId: string,
  rows: WorkbookImportRow[],
  acceptWarnings = false,
): Promise<{ created: number; updated: number; record_ids: string[] }> {
  return apiRequest("/imports/workbook/commit", {
    method: "POST",
    body: jsonBody({ project_id: projectId, rows, accept_warnings: acceptWarnings }),
  });
}
