import type { FieldDefinition, ProjectRecord } from "@/types/api";
import { comparePathologyNumbers } from "@/utils/pathologySort";

export type LedgerRow = ProjectRecord & { _draft?: true };
export type LedgerSortOrder = "ascending" | "descending";
export type LedgerSortState = {
  fieldId: string;
  order: LedgerSortOrder;
} | null;

export type LedgerFieldFilter =
  | { kind: "text"; value: string }
  | { kind: "options"; values: string[] }
  | { kind: "date-range"; start: string; end: string };

export type LedgerFilterMap = Record<string, LedgerFieldFilter | undefined>;

/** Read a displayed ledger value without depending on the Vue view helpers. */
export function getLedgerFieldValue(record: ProjectRecord, field: FieldDefinition): string {
  if (field.system_key === "pathology_number") return record.pathology_number ?? "";
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status ?? "";
  return record.values?.[field.id] ?? "";
}

function normalized(value: string): string {
  return value.trim();
}

function isEmptyFilter(filter: LedgerFieldFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.kind === "text") return !filter.value.trim();
  if (filter.kind === "options") return filter.values.length === 0;
  return !filter.start && !filter.end;
}

export function matchesLedgerFilter(
  record: LedgerRow,
  field: FieldDefinition,
  filter: LedgerFieldFilter | undefined,
): boolean {
  if (isEmptyFilter(filter)) return true;
  const value = getLedgerFieldValue(record, field);
  if (!filter) return true;

  if (filter.kind === "text") {
    return value.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase());
  }
  if (filter.kind === "options") {
    return filter.values.includes(value);
  }

  const candidate = normalized(value);
  if (!candidate) return false;
  if (filter.start && candidate < filter.start) return false;
  if (filter.end && candidate > filter.end) return false;
  return true;
}

function compareNonEmptyValues(
  left: string,
  right: string,
  field: FieldDefinition,
): number {
  if (field.system_key === "pathology_number") {
    return comparePathologyNumbers(left, right);
  }
  if (field.data_type === "date" || field.system_key === "experiment_date") {
    return left.localeCompare(right, "zh-CN", { numeric: true });
  }
  if (field.data_type === "number") {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const leftValid = Number.isFinite(leftNumber);
    const rightValid = Number.isFinite(rightNumber);
    if (leftValid && rightValid && leftNumber !== rightNumber) return leftNumber - rightNumber;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
  }
  return left.localeCompare(right, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

export function compareLedgerRows(
  left: LedgerRow,
  right: LedgerRow,
  field: FieldDefinition,
  order: LedgerSortOrder,
): number {
  const leftValue = normalized(getLedgerFieldValue(left, field));
  const rightValue = normalized(getLedgerFieldValue(right, field));
  // Empty values remain at the end for both directions, matching spreadsheet
  // behaviour and keeping blank draft fields easy to find.
  if (!leftValue && !rightValue) return 0;
  if (!leftValue) return 1;
  if (!rightValue) return -1;
  const comparison = compareNonEmptyValues(leftValue, rightValue, field);
  return order === "descending" ? -comparison : comparison;
}

/** Apply local filter/sort state while keeping draft rows at the bottom. */
export function applyLedgerTableView(
  rows: LedgerRow[],
  fields: FieldDefinition[],
  sortState: LedgerSortState,
  filters: LedgerFilterMap,
): LedgerRow[] {
  const persisted: LedgerRow[] = [];
  const drafts: LedgerRow[] = [];
  rows.forEach((row) => (row._draft ? drafts : persisted).push(row));

  const filtered = persisted.filter((row) =>
    fields.every((field) => matchesLedgerFilter(row, field, filters[field.id])),
  );

  if (sortState) {
    const field = fields.find((candidate) => candidate.id === sortState.fieldId);
    if (field) {
      filtered.sort((left, right) => compareLedgerRows(left, right, field, sortState.order));
    }
  }

  return [...filtered, ...drafts];
}
