import { apiRequest, jsonBody } from "@/api/client";
import type { ExperimentPlan, ExperimentPlanItem } from "@/types/api";

export function listExperimentPlans(): Promise<ExperimentPlan[]> {
  return apiRequest<ExperimentPlan[]>("/experiments/plans");
}

export function createExperimentPlan(prefix = ""): Promise<ExperimentPlan> {
  return apiRequest<ExperimentPlan>("/experiments/plans", {
    method: "POST",
    body: jsonBody({ prefix }),
  });
}

export function updateExperimentPlan(
  planId: string,
  prefix: string,
): Promise<ExperimentPlan> {
  return apiRequest<ExperimentPlan>(`/experiments/plans/${planId}`, {
    method: "PATCH",
    body: jsonBody({ prefix }),
  });
}

export function deleteExperimentPlan(planId: string): Promise<void> {
  return apiRequest<void>(`/experiments/plans/${planId}`, {
    method: "DELETE",
  });
}

export function addExperimentPlanItem(
  planId: string,
  recordId: string,
): Promise<ExperimentPlanItem> {
  return apiRequest<ExperimentPlanItem>(`/experiments/plans/${planId}/items`, {
    method: "POST",
    body: jsonBody({ record_id: recordId }),
  });
}

export function reorderExperimentPlan(
  planId: string,
  itemIds: string[],
): Promise<ExperimentPlan> {
  return apiRequest<ExperimentPlan>(`/experiments/plans/${planId}/order`, {
    method: "PUT",
    body: jsonBody({ item_ids: itemIds }),
  });
}

export function deleteExperimentPlanItem(
  planId: string,
  itemId: string,
): Promise<void> {
  return apiRequest<void>(`/experiments/plans/${planId}/items/${itemId}`, {
    method: "DELETE",
  });
}

export function applyExperimentPlan(
  planId: string,
): Promise<{ plan_id: string; updated_records: number; applied_at: string }> {
  return apiRequest(`/experiments/plans/${planId}/apply`, { method: "POST" });
}
