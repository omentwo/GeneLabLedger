import { apiRequest, jsonBody } from "@/api/client";
import type { ExperimentBatch, ExperimentRun } from "@/types/api";

export function getExperimentBatch(experimentDate: string): Promise<ExperimentBatch> {
  return apiRequest<ExperimentBatch>(`/experiments/batches/${experimentDate}`);
}

export function addExperimentRun(
  experimentDate: string,
  recordId: string,
  allowRepeat = false,
): Promise<ExperimentRun> {
  return apiRequest<ExperimentRun>(`/experiments/batches/${experimentDate}/runs`, {
    method: "POST",
    body: jsonBody({ record_id: recordId, allow_repeat: allowRepeat }),
  });
}

export function reorderExperimentRuns(
  experimentDate: string,
  runIds: string[],
): Promise<ExperimentBatch> {
  return apiRequest<ExperimentBatch>(`/experiments/batches/${experimentDate}/order`, {
    method: "PUT",
    body: jsonBody({ run_ids: runIds }),
  });
}

export function deleteExperimentRun(runId: string): Promise<void> {
  return apiRequest<void>(`/experiments/runs/${runId}`, { method: "DELETE" });
}

export function commitExperimentBatch(
  experimentDate: string,
): Promise<{ experiment_date: string; updated_records: number }> {
  return apiRequest<{ experiment_date: string; updated_records: number }>(
    `/experiments/batches/${experimentDate}/commit`,
    { method: "POST" },
  );
}
