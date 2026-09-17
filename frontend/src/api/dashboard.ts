import { apiRequest } from "@/api/client";
import type { DashboardSummary } from "@/types/api";

export function getDashboardSummary(
  projectId = "",
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  const query = params.size ? `?${params.toString()}` : "";
  return apiRequest<DashboardSummary>(`/dashboard/summary${query}`, { signal });
}
