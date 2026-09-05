import type { FieldDefinition } from "@/types/api";
import type {
  LedgerFieldFilter,
  LedgerFilterMap,
  LedgerSortState,
} from "@/utils/ledgerTableView";

export const LEDGER_LAYOUT_SETTINGS_KEY = "ledger_layout_settings";

export interface LedgerProjectLayoutSettings {
  sort: { field_id: string; direction: "asc" | "desc" } | null;
  filters: Record<string, LedgerFieldFilter>;
}

export interface LedgerLayoutSettingsDocument {
  version: 1;
  projects: Record<string, LedgerProjectLayoutSettings>;
}

export interface ResolvedLedgerProjectLayout {
  sort: LedgerSortState;
  filters: LedgerFilterMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFilter(value: unknown): LedgerFieldFilter | null {
  if (!isRecord(value)) return null;
  if (value.kind === "text" && typeof value.value === "string") {
    return value.value.trim() ? { kind: "text", value: value.value } : null;
  }
  if (value.kind === "options" && Array.isArray(value.values)) {
    const values = value.values.filter((item): item is string => typeof item === "string");
    return values.length ? { kind: "options", values } : null;
  }
  if (value.kind === "date-range") {
    const start = typeof value.start === "string" ? value.start : "";
    const end = typeof value.end === "string" ? value.end : "";
    return start || end ? { kind: "date-range", start, end } : null;
  }
  return null;
}

function normalizeProjectSettings(value: unknown): LedgerProjectLayoutSettings {
  const source = isRecord(value) ? value : {};
  const sortValue = isRecord(source.sort) ? source.sort : null;
  const sort: LedgerProjectLayoutSettings["sort"] =
    sortValue &&
    typeof sortValue.field_id === "string" &&
    (sortValue.direction === "asc" || sortValue.direction === "desc")
      ? { field_id: sortValue.field_id, direction: sortValue.direction }
      : null;
  const filters: Record<string, LedgerFieldFilter> = {};
  if (isRecord(source.filters)) {
    Object.entries(source.filters).forEach(([fieldId, candidate]) => {
      const filter = normalizeFilter(candidate);
      if (fieldId && filter) filters[fieldId] = filter;
    });
  }
  return {
    sort,
    filters,
  };
}

export function normalizeLedgerLayoutSettings(value: unknown): LedgerLayoutSettingsDocument {
  const source = isRecord(value) ? value : {};
  const projectsSource = source.version === 1 && isRecord(source.projects) ? source.projects : {};
  const projects: Record<string, LedgerProjectLayoutSettings> = {};
  Object.entries(projectsSource).forEach(([projectId, settings]) => {
    if (projectId) projects[projectId] = normalizeProjectSettings(settings);
  });
  return { version: 1, projects };
}

export function resolveLedgerProjectLayout(
  document: LedgerLayoutSettingsDocument,
  projectId: string,
  fields: FieldDefinition[],
): ResolvedLedgerProjectLayout {
  const settings = document.projects[projectId] ?? normalizeProjectSettings(null);
  const visibleFieldIds = new Set(fields.filter((field) => !field.hidden).map((field) => field.id));
  const sort = settings.sort && visibleFieldIds.has(settings.sort.field_id)
    ? {
        fieldId: settings.sort.field_id,
        order: settings.sort.direction === "asc" ? "ascending" : "descending",
      } as LedgerSortState
    : null;
  const filters: LedgerFilterMap = {};
  Object.entries(settings.filters).forEach(([fieldId, filter]) => {
    if (visibleFieldIds.has(fieldId)) filters[fieldId] = filter;
  });
  return {
    sort,
    filters,
  };
}

export function withLedgerProjectLayout(
  document: LedgerLayoutSettingsDocument,
  projectId: string,
  layout: ResolvedLedgerProjectLayout,
): LedgerLayoutSettingsDocument {
  const filters: Record<string, LedgerFieldFilter> = {};
  Object.entries(layout.filters).forEach(([fieldId, filter]) => {
    if (filter) filters[fieldId] = filter;
  });
  return {
    version: 1,
    projects: {
      ...document.projects,
      [projectId]: {
        sort: layout.sort
          ? {
              field_id: layout.sort.fieldId,
              direction: layout.sort.order === "ascending" ? "asc" : "desc",
            }
          : null,
        filters,
      },
    },
  };
}
