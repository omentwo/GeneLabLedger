export const EXPERIMENT_PROJECT_ORDER_KEY = "experiment_project_order";

export interface ExperimentProjectOrderSetting {
  version: 1;
  project_ids: string[];
}

/**
 * Keeps saved, still-available projects first and appends newly enabled projects
 * in their current ledger order. Invalid, removed, and duplicate ids are ignored.
 */
export function normalizeExperimentProjectOrder(
  value: unknown,
  availableProjectIds: readonly string[],
): string[] {
  const available = Array.from(
    new Set(availableProjectIds.filter((id) => typeof id === "string" && id.trim())),
  );
  const availableSet = new Set(available);
  const candidate = value && typeof value === "object"
    ? (value as Record<string, unknown>).project_ids
    : undefined;
  const saved = Array.isArray(candidate) ? candidate : [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  saved.forEach((id) => {
    if (typeof id !== "string" || !availableSet.has(id) || seen.has(id)) return;
    seen.add(id);
    normalized.push(id);
  });
  available.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    normalized.push(id);
  });
  return normalized;
}

export function createExperimentProjectOrderSetting(
  projectIds: readonly string[],
): ExperimentProjectOrderSetting {
  return { version: 1, project_ids: Array.from(new Set(projectIds)) };
}
