import { apiRequest, jsonBody } from "@/api/client";
import type {
  AutoExportConfig,
  AutoExportRun,
  AutoExportTask,
  AutoExportTaskInput,
} from "@/types/api";

export function getAutoExportConfig(): Promise<AutoExportConfig> {
  return apiRequest<AutoExportConfig>("/auto-export/config");
}

export function listAutoExportTasks(): Promise<AutoExportTask[]> {
  return apiRequest<AutoExportTask[]>("/auto-export/tasks");
}

export function createAutoExportTask(
  payload: AutoExportTaskInput,
): Promise<AutoExportTask> {
  return apiRequest<AutoExportTask>("/auto-export/tasks", {
    method: "POST",
    body: jsonBody(payload),
  });
}

export function updateAutoExportTask(
  taskId: string,
  payload: AutoExportTaskInput,
): Promise<AutoExportTask> {
  return apiRequest<AutoExportTask>(`/auto-export/tasks/${taskId}`, {
    method: "PUT",
    body: jsonBody(payload),
  });
}

export function deleteAutoExportTask(taskId: string): Promise<void> {
  return apiRequest<void>(`/auto-export/tasks/${taskId}`, { method: "DELETE" });
}

export function runAutoExportTask(taskId: string): Promise<AutoExportRun> {
  return apiRequest<AutoExportRun>(`/auto-export/tasks/${taskId}/run`, {
    method: "POST",
  });
}

export function listAutoExportRuns(
  taskId: string,
  limit = 30,
): Promise<AutoExportRun[]> {
  return apiRequest<AutoExportRun[]>(
    `/auto-export/tasks/${taskId}/runs?limit=${limit}`,
  );
}

export function validateCronExpression(
  expression: string,
): Promise<{ valid: boolean; expression: string }> {
  return apiRequest<{ valid: boolean; expression: string }>(
    "/auto-export/validate-cron",
    {
      method: "POST",
      body: jsonBody({ expression }),
    },
  );
}

