import { apiRequest, apiRequestBlob, jsonBody } from "@/api/client";
import type {
  MappingSourceType,
  PrintEngine,
  PrintEngineStatus,
  Printer,
  ReportPrintResult,
  ReportTemplate,
  ReportTemplateVersion,
} from "@/types/api";

export interface ReportMappingInput {
  placeholder: string;
  source_type: MappingSourceType;
  field_id: string | null;
  fixed_value: string | null;
}

export function listReportTemplates(projectId = ""): Promise<ReportTemplate[]> {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return apiRequest<ReportTemplate[]>(`/report-templates${query}`);
}

export function createReportTemplate(
  projectId: string,
  name: string,
  file: File,
): Promise<ReportTemplate> {
  const form = new FormData();
  form.append("project_id", projectId);
  form.append("name", name);
  form.append("file", file);
  return apiRequest<ReportTemplate>("/report-templates", {
    method: "POST",
    body: form,
  });
}

export function addReportTemplateVersion(
  templateId: string,
  file: File,
): Promise<ReportTemplateVersion> {
  const form = new FormData();
  form.append("file", file);
  return apiRequest<ReportTemplateVersion>(
    `/report-templates/${templateId}/versions`,
    {
      method: "POST",
      body: form,
    },
  );
}

export function replaceReportMappings(
  versionId: string,
  mappings: ReportMappingInput[],
): Promise<ReportTemplateVersion> {
  return apiRequest<ReportTemplateVersion>(
    `/report-template-versions/${versionId}/mappings`,
    {
      method: "PUT",
      body: jsonBody({ mappings }),
    },
  );
}

export async function generateReportDocuments(
  templateVersionId: string,
  recordIds: string[],
): Promise<string> {
  const { blob, filename } = await apiRequestBlob("/reports/documents", {
    method: "POST",
    body: jsonBody({
      template_version_id: templateVersionId,
      items: recordIds.map((projectRecordId) => ({
        project_record_id: projectRecordId,
        experiment_run_id: null,
      })),
    }),
  });
  const resolvedFilename = filename ?? (recordIds.length === 1 ? "报告.docx" : "报告.zip");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = resolvedFilename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
  return resolvedFilename;
}

export function listPrinters(): Promise<Printer[]> {
  return apiRequest<Printer[]>("/printers");
}

export function listPrintEngines(): Promise<PrintEngineStatus[]> {
  return apiRequest<PrintEngineStatus[]>("/print-engines");
}

export function printReports(
  templateVersionId: string,
  recordIds: string[],
  printerName: string,
  printEngine: PrintEngine,
): Promise<ReportPrintResult> {
  return apiRequest<ReportPrintResult>("/reports/print", {
    method: "POST",
    body: jsonBody({
      template_version_id: templateVersionId,
      items: recordIds.map((projectRecordId) => ({
        project_record_id: projectRecordId,
        experiment_run_id: null,
      })),
      printer_name: printerName,
      print_engine: printEngine,
    }),
  });
}

export function deleteReportTemplate(templateId: string): Promise<void> {
  return apiRequest<void>(`/report-templates/${templateId}`, {
    method: "DELETE",
  });
}
