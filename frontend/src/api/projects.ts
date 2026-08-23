import { apiRequest, jsonBody } from "@/api/client";
import type {
  DataType,
  FieldDefinition,
  FieldValidationRules,
  LedgerTemplate,
  LedgerViewPreset,
  LedgerViewState,
  Project,
  ProjectForceDeleteResult,
  ValidationMode,
} from "@/types/api";

export function listProjects(): Promise<Project[]> {
  return apiRequest<Project[]>("/projects");
}

export function createProject(name: string, templateId?: string): Promise<Project> {
  return apiRequest<Project>("/projects", {
    method: "POST",
    body: jsonBody({ name, ...(templateId ? { template_id: templateId } : {}) }),
  });
}

export function duplicateProject(projectId: string, name?: string): Promise<Project> {
  return apiRequest<Project>(`/projects/${projectId}/duplicate`, {
    method: "POST",
    body: jsonBody(name ? { name } : {}),
  });
}

export function listLedgerTemplates(): Promise<LedgerTemplate[]> {
  return apiRequest<LedgerTemplate[]>("/ledger-templates");
}

export function createLedgerTemplate(payload: {
  name: string;
  description?: string;
  source_project_id?: string;
  fields?: LedgerTemplate["fields"];
}): Promise<LedgerTemplate> {
  return apiRequest<LedgerTemplate>("/ledger-templates", {
    method: "POST",
    body: jsonBody(payload),
  });
}

export function updateLedgerTemplate(
  templateId: string,
  payload: {
    name?: string;
    description?: string;
    source_project_id?: string;
    fields?: LedgerTemplate["fields"];
  },
): Promise<LedgerTemplate> {
  return apiRequest<LedgerTemplate>(`/ledger-templates/${templateId}`, {
    method: "PATCH",
    body: jsonBody(payload),
  });
}

export function deleteLedgerTemplate(templateId: string): Promise<void> {
  return apiRequest<void>(`/ledger-templates/${templateId}`, { method: "DELETE" });
}

export function updateProject(
  projectId: string,
  payload: { name?: string; sort_order?: number; experiment_enabled?: boolean },
): Promise<Project> {
  return apiRequest<Project>(`/projects/${projectId}`, {
    method: "PATCH",
    body: jsonBody(payload),
  });
}

export function deleteProject(projectId: string): Promise<void> {
  return apiRequest<void>(`/projects/${projectId}`, { method: "DELETE" });
}

export function forceDeleteProject(
  projectId: string,
  confirmName: string,
): Promise<ProjectForceDeleteResult> {
  return apiRequest<ProjectForceDeleteResult>(`/projects/${projectId}/force-delete`, {
    method: "POST",
    body: jsonBody({ confirm_name: confirmName }),
  });
}

export function createField(
  projectId: string,
  payload: {
    label: string;
    data_type: DataType;
    width: number;
    options: string[];
    validation_mode?: ValidationMode;
    validation_rules?: FieldValidationRules;
    default_value?: string | null;
  },
): Promise<FieldDefinition> {
  return apiRequest<FieldDefinition>(`/projects/${projectId}/fields`, {
    method: "POST",
    body: jsonBody(payload),
  });
}

export function updateField(
  fieldId: string,
  payload: {
    label?: string;
    data_type?: DataType;
    sort_order?: number;
    width?: number;
    hidden?: boolean;
    validation_mode?: ValidationMode;
    validation_rules?: FieldValidationRules;
    default_value?: string | null;
  },
): Promise<FieldDefinition> {
  return apiRequest<FieldDefinition>(`/projects/fields/${fieldId}`, {
    method: "PATCH",
    body: jsonBody(payload),
  });
}

export function replaceFieldOptions(
  fieldId: string,
  options: string[],
): Promise<FieldDefinition> {
  return apiRequest<FieldDefinition>(`/projects/fields/${fieldId}/options`, {
    method: "PUT",
    body: jsonBody({ options }),
  });
}

export function reorderFields(
  projectId: string,
  fieldIds: string[],
): Promise<FieldDefinition[]> {
  return apiRequest<FieldDefinition[]>(`/projects/${projectId}/fields/reorder`, {
    method: "PUT",
    body: jsonBody({ field_ids: fieldIds }),
  });
}

export function deleteField(fieldId: string): Promise<void> {
  return apiRequest<void>(`/projects/fields/${fieldId}`, { method: "DELETE" });
}

export function listLedgerViewPresets(projectId: string): Promise<LedgerViewPreset[]> {
  return apiRequest<LedgerViewPreset[]>(`/projects/${projectId}/view-presets`);
}

export function createLedgerViewPreset(
  projectId: string,
  payload: { name: string; state: LedgerViewState; is_default?: boolean },
): Promise<LedgerViewPreset> {
  return apiRequest<LedgerViewPreset>(`/projects/${projectId}/view-presets`, {
    method: "POST",
    body: jsonBody(payload),
  });
}

export function updateLedgerViewPreset(
  presetId: string,
  payload: { name?: string; state?: LedgerViewState; is_default?: boolean },
): Promise<LedgerViewPreset> {
  return apiRequest<LedgerViewPreset>(`/projects/view-presets/${presetId}`, {
    method: "PATCH",
    body: jsonBody(payload),
  });
}

export function setDefaultLedgerViewPreset(presetId: string): Promise<LedgerViewPreset> {
  return apiRequest<LedgerViewPreset>(`/projects/view-presets/${presetId}/default`, {
    method: "POST",
  });
}

export function deleteLedgerViewPreset(presetId: string): Promise<void> {
  return apiRequest<void>(`/projects/view-presets/${presetId}`, { method: "DELETE" });
}
