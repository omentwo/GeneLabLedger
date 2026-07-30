import { apiRequest } from "@/api/client";
import type { AuditLog, HealthStatus } from "@/types/api";

export function getHealth(): Promise<HealthStatus> {
  return apiRequest<HealthStatus>("/health");
}

export function listAuditLogs(search = "", limit = 500): Promise<AuditLog[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search.trim()) params.set("search", search.trim());
  return apiRequest<AuditLog[]>(`/audit-logs?${params.toString()}`);
}

export function getSetting<T>(key: string): Promise<{ key: string; value: T | null }> {
  return apiRequest<{ key: string; value: T | null }>(`/settings/${key}`);
}

export function putSetting<T>(
  key: string,
  value: T,
): Promise<{ key: string; value: T }> {
  return apiRequest<{ key: string; value: T }>(`/settings/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}
