import { apiRequest, jsonBody } from "@/api/client";
import type { DataType, FieldDefinition, Project } from "@/types/api";

export function listProjects(): Promise<Project[]> {
  return apiRequest<Project[]>("/projects");
}

export function createProject(name: string): Promise<Project> {
  return apiRequest<Project>("/projects", {
    method: "POST",
    body: jsonBody({ name }),
  });
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

export function createField(
  projectId: string,
  payload: { label: string; data_type: DataType; width: number; options: string[] },
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
