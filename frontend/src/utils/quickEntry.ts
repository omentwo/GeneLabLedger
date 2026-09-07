import type {
  FieldDefinition,
  ProjectRecord,
  RecordCellChange,
  RecordCreateInput,
  RecordStatus,
} from "@/types/api";

export const QUICK_ENTRY_SETTINGS_KEY = "quick_entry_settings";
export const QUICK_ENTRY_FIELD_WIDTH_MIN = 160;
export const QUICK_ENTRY_FIELD_WIDTH_MAX = 600;
export const QUICK_ENTRY_FIELD_WIDTH_DEFAULT = 320;

export interface QuickEntryProjectSettings {
  selectedFieldIds: string[];
  pinnedFieldIds: string[];
  fieldWidth: number;
  quickCreateFieldWidth: number;
  autoAdvanceAfterUpdate: boolean;
}

export interface QuickEntrySettingsDocument {
  version: 3;
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

function clampedDimension(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(maximum, Math.max(minimum, Math.round(numeric)))
    : fallback;
}

function legacyLayoutValue(settings: Record<string, unknown>, key: "width" | "height"): unknown {
  const layouts = settings.fieldLayouts;
  if (!layouts || typeof layouts !== "object") return undefined;
  const first = Object.values(layouts as Record<string, unknown>)
    .find((layout) => layout && typeof layout === "object") as Record<string, unknown> | undefined;
  return first?.[key];
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
          fieldWidth: clampedDimension(
            settings.fieldWidth ?? legacyLayoutValue(settings, "width"),
            QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
            QUICK_ENTRY_FIELD_WIDTH_MIN,
            QUICK_ENTRY_FIELD_WIDTH_MAX,
          ),
          quickCreateFieldWidth: clampedDimension(
            settings.quickCreateFieldWidth ?? settings.fieldWidth ?? legacyLayoutValue(settings, "width"),
            QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
            QUICK_ENTRY_FIELD_WIDTH_MIN,
            QUICK_ENTRY_FIELD_WIDTH_MAX,
          ),
          autoAdvanceAfterUpdate: settings.autoAdvanceAfterUpdate !== false,
        },
      ]];
    }),
  );
  return { version: 3, projects };
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
  const selectedFieldIds = stringList(requestedSelected).filter((fieldId) => validIds.has(fieldId));
  mandatoryIds.forEach((fieldId) => {
    if (!selectedFieldIds.includes(fieldId)) selectedFieldIds.push(fieldId);
  });
  const selectedSet = new Set(selectedFieldIds);

  const defaultPinned = defaults.pinnedFieldIds !== undefined
    ? defaults.pinnedFieldIds
    : orderedFields
        .filter((field) => field.system_key === "experiment_date" || field.system_key === "status")
        .map((field) => field.id);
  const requestedPinned = saved ? saved.pinnedFieldIds : defaultPinned;
  const pinnedSet = new Set(requestedPinned);
  const pinnedFieldIds = stringList(requestedPinned).filter((fieldId) => {
    const field = orderedFields.find((item) => item.id === fieldId);
    return Boolean(field && selectedSet.has(fieldId) && pinnedSet.has(fieldId) && field.system_key !== "pathology_number");
  });
  return {
    selectedFieldIds,
    pinnedFieldIds,
    fieldWidth: clampedDimension(
      saved?.fieldWidth,
      QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
      QUICK_ENTRY_FIELD_WIDTH_MIN,
      QUICK_ENTRY_FIELD_WIDTH_MAX,
    ),
    quickCreateFieldWidth: clampedDimension(
      saved?.quickCreateFieldWidth ?? saved?.fieldWidth,
      QUICK_ENTRY_FIELD_WIDTH_DEFAULT,
      QUICK_ENTRY_FIELD_WIDTH_MIN,
      QUICK_ENTRY_FIELD_WIDTH_MAX,
    ),
    autoAdvanceAfterUpdate: saved?.autoAdvanceAfterUpdate !== false,
  };
}


export interface ParsedCombinedPathologyNumber {
  pathologyNumber: string;
  blockNumber: string;
  normalized: string;
}

export function parseCombinedPathologyNumber(value: string): ParsedCombinedPathologyNumber {
  const normalized = value.trim().replace(/[－—–﹣]/g, "-");
  const separatorIndex = normalized.lastIndexOf("-");
  const pathologyNumber = normalized.slice(0, separatorIndex).trim();
  const blockNumber = normalized.slice(separatorIndex + 1).trim();
  if (separatorIndex <= 0 || !pathologyNumber || !blockNumber) {
    throw new Error("请输入“病理号-蜡块号”，例如 A-20260907-3");
  }
  if (pathologyNumber.length > 160) throw new Error("病理号不能超过 160 个字符");
  if (blockNumber.length > 80) throw new Error("蜡块号不能超过 80 个字符");
  return { pathologyNumber, blockNumber, normalized: `${pathologyNumber}-${blockNumber}` };
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
