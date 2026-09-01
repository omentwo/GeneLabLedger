import type {
  FieldDefinition,
  ProjectRecord,
  RecordCellChange,
  RecordCreateInput,
  RecordStatus,
} from "@/types/api";

export const QUICK_ENTRY_SETTINGS_KEY = "quick_entry_settings";

export interface QuickEntryProjectSettings {
  selectedFieldIds: string[];
  pinnedFieldIds: string[];
}

export interface QuickEntrySettingsDocument {
  version: 1;
  projects: Record<string, QuickEntryProjectSettings>;
}

export interface QuickEntryFieldDefaults {
  selectedFieldIds?: string[];
  pinnedFieldIds?: string[];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function normalizeQuickEntrySettings(value: unknown): QuickEntrySettingsDocument {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawProjects =
    candidate.projects && typeof candidate.projects === "object"
      ? candidate.projects as Record<string, unknown>
      : {};
  const projects = Object.fromEntries(
    Object.entries(rawProjects).flatMap(([projectId, rawSettings]) => {
      if (!projectId || !rawSettings || typeof rawSettings !== "object") return [];
      const settings = rawSettings as Record<string, unknown>;
      return [[
        projectId,
        {
          selectedFieldIds: stringList(settings.selectedFieldIds),
          pinnedFieldIds: stringList(settings.pinnedFieldIds),
        },
      ]];
    }),
  );
  return { version: 1, projects };
}

export function isMandatoryQuickEntryField(field: FieldDefinition): boolean {
  return field.system_key === "pathology_number" || field.validation_rules?.required === true;
}

export function resolveQuickEntryProjectSettings(
  fields: FieldDefinition[],
  saved: QuickEntryProjectSettings | undefined,
  defaults: QuickEntryFieldDefaults = {},
): QuickEntryProjectSettings {
  const orderedFields = fields.slice().sort((left, right) => left.sort_order - right.sort_order);
  const validIds = new Set(orderedFields.map((field) => field.id));
  const mandatoryIds = orderedFields
    .filter(isMandatoryQuickEntryField)
    .map((field) => field.id);
  const defaultSelected = defaults.selectedFieldIds !== undefined
    ? defaults.selectedFieldIds
    : orderedFields.filter((field) => field.is_core || !field.hidden).map((field) => field.id);
  const requestedSelected = saved ? saved.selectedFieldIds : defaultSelected;
  const selectedSet = new Set(
    [...mandatoryIds, ...requestedSelected].filter((fieldId) => validIds.has(fieldId)),
  );
  const selectedFieldIds = orderedFields
    .filter((field) => selectedSet.has(field.id))
    .map((field) => field.id);

  const defaultPinned = defaults.pinnedFieldIds !== undefined
    ? defaults.pinnedFieldIds
    : orderedFields
        .filter((field) => field.system_key === "experiment_date" || field.system_key === "status")
        .map((field) => field.id);
  const requestedPinned = saved ? saved.pinnedFieldIds : defaultPinned;
  const pinnedSet = new Set(requestedPinned);
  const pinnedFieldIds = orderedFields
    .filter(
      (field) =>
        selectedSet.has(field.id) &&
        pinnedSet.has(field.id) &&
        field.system_key !== "pathology_number",
    )
    .map((field) => field.id);
  return { selectedFieldIds, pinnedFieldIds };
}

export function quickEntryFieldValue(
  record: ProjectRecord,
  field: FieldDefinition,
): string {
  if (field.system_key === "pathology_number") return record.pathology_number;
  if (field.system_key === "block_number") return record.block_number ?? "";
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status;
  return record.values[field.id] ?? "";
}

export function quickEntryDefaultValue(field: FieldDefinition): string {
  if (field.system_key === "status") return "待实验";
  if (field.is_core) return "";
  return field.default_value ?? "";
}

export function normalizeQuickEntryDate(value: string): string {
  const cleaned = value.trim().replace(/[/.]/g, "-");
  if (!cleaned) return "";
  const match = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error("日期格式应为 YYYY-MM-DD，例如 2026-07-27");
  const [, year, month, day] = match;
  const normalized = `${year}-${String(Number(month)).padStart(2, "0")}-${String(
    Number(day),
  ).padStart(2, "0")}`;
  const parsed = new Date(`${normalized}T00:00:00`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== Number(year) ||
    parsed.getMonth() + 1 !== Number(month) ||
    parsed.getDate() !== Number(day)
  ) {
    throw new Error("日期无效，请重新输入");
  }
  return normalized;
}

export function normalizeQuickEntryFieldValue(
  field: FieldDefinition,
  rawValue: string,
): string {
  const value = rawValue.trim();
  if (field.system_key === "pathology_number" && !value) {
    throw new Error("病理号不能为空");
  }
  if (field.system_key === "experiment_date" || field.data_type === "date") {
    return normalizeQuickEntryDate(value);
  }
  if (field.system_key === "status" && value !== "待实验" && value !== "已完成") {
    throw new Error("状态只能是“待实验”或“已完成”");
  }
  return value;
}

export function buildQuickEntryCreatePayload(
  projectId: string,
  fields: FieldDefinition[],
  selectedFieldIds: string[],
  values: Record<string, string>,
): RecordCreateInput {
  const selected = new Set(selectedFieldIds);
  const fieldBySystemKey = new Map(
    fields.flatMap((field) => field.system_key ? [[field.system_key, field] as const] : []),
  );
  const pathologyField = fieldBySystemKey.get("pathology_number");
  if (!pathologyField) throw new Error("当前项目缺少病理号表头");
  const statusField = fieldBySystemKey.get("status");
  const blockField = fieldBySystemKey.get("block_number");
  const dateField = fieldBySystemKey.get("experiment_date");
  const numberField = fieldBySystemKey.get("experiment_number");
  const statusValue = statusField && selected.has(statusField.id)
    ? normalizeQuickEntryFieldValue(statusField, values[statusField.id] ?? "待实验")
    : "待实验";
  const dateValue = dateField && selected.has(dateField.id)
    ? normalizeQuickEntryFieldValue(dateField, values[dateField.id] ?? "")
    : "";
  const numberValue = numberField && selected.has(numberField.id)
    ? normalizeQuickEntryFieldValue(numberField, values[numberField.id] ?? "")
    : "";
  const blockValue = blockField && selected.has(blockField.id)
    ? normalizeQuickEntryFieldValue(blockField, values[blockField.id] ?? "")
    : "";
  return {
    project_id: projectId,
    pathology_number: normalizeQuickEntryFieldValue(
      pathologyField,
      values[pathologyField.id] ?? "",
    ),
    ...(blockField ? { block_number: blockValue || null } : {}),
    status: statusValue as RecordStatus,
    experiment_date: dateValue || null,
    experiment_number: numberValue || null,
    values: Object.fromEntries(
      fields
        .filter((field) => !field.is_core && selected.has(field.id))
        .map((field) => [
          field.id,
          normalizeQuickEntryFieldValue(field, values[field.id] ?? ""),
        ]),
    ),
  };
}

export function buildQuickEntryChanges(
  record: ProjectRecord,
  fields: FieldDefinition[],
  selectedFieldIds: string[],
  values: Record<string, string>,
  baselineValues: Record<string, string>,
): RecordCellChange[] {
  const selected = new Set(selectedFieldIds);
  return fields.flatMap((field) => {
    if (!selected.has(field.id)) return [];
    const value = normalizeQuickEntryFieldValue(field, values[field.id] ?? "");
    const expectedValue = normalizeQuickEntryFieldValue(
      field,
      baselineValues[field.id] ?? quickEntryFieldValue(record, field),
    );
    if (value === expectedValue) return [];
    return [{
      record_id: record.id,
      field_id: field.id,
      value,
      expected_value: expectedValue,
    }];
  });
}

export function unreportedQuickEntryRecords(records: ProjectRecord[]): ProjectRecord[] {
  return records
    .filter((record) => !record.report_generated)
    .slice()
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}
