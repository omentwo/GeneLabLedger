import { apiRequest, jsonBody } from "@/api/client";
import type {
  MappingSourceType,
  NativePreviewAction,
  NativePreviewTask,
  PrintEngine,
  PrintEngineStatus,
  Printer,
  ReportPrintResult,
  ReportTemplate,
  ReportTemplateDeleteResult,
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
    timeoutMs: 600_000,
    method: "POST",
    body: jsonBody({
      template_version_id: templateVersionId,
      items: recordIds.map((projectRecordId) => ({
        project_record_id: projectRecordId,
      })),
      printer_name: printerName,
      print_engine: printEngine,
    }),
  });
}

export function nativePreviewReport(
  templateVersionId: string,
  recordId: string,
  printEngine: PrintEngine,
  action: NativePreviewAction,
): Promise<NativePreviewTask> {
  return apiRequest<NativePreviewTask>(
    `/report-template-versions/${templateVersionId}/native-preview`,
    {
      method: "POST",
      body: jsonBody({
        template_version_id: templateVersionId,
        record_ids: [recordId],
        print_engine: printEngine,
        action,
      }),
    },
  );
}

export function deleteReportTemplate(templateId: string): Promise<ReportTemplateDeleteResult> {
  return apiRequest<ReportTemplateDeleteResult>(`/report-templates/${templateId}`, {
    method: "DELETE",
  });
}
