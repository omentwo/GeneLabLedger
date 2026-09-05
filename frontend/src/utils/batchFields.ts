import type { FieldDefinition } from "@/types/api";

export const MAX_BATCH_FIELD_LABELS = 100;
export const RESERVED_FIELD_LABELS = new Set(["_record_id", "_project_id"]);

export type BatchFieldPreviewStatus =
  | "existing-core"
  | "existing"
  | "new"
  | "duplicate"
  | "conflict";

export interface BatchFieldPreviewRow {
  index: number;
  label: string;
  status: BatchFieldPreviewStatus;
  message: string;
}

export interface BatchFieldPreview {
  rows: BatchFieldPreviewRow[];
  labels: string[];
  newCount: number;
  hasErrors: boolean;
}

export function parseBatchFieldLabels(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((label) => label.trim())
    .filter(Boolean);
}

export function previewBatchFieldLabels(
  value: string,
  fields: FieldDefinition[],
): BatchFieldPreview {
  const labels = parseBatchFieldLabels(value);
  const existingByLabel = new Map(fields.map((field) => [field.label.trim(), field]));
  const conflictingIdentifiers = new Set<string>();
  fields.forEach((field) => {
    if (field.key.trim()) conflictingIdentifiers.add(field.key.trim());
    if (field.system_key?.trim()) conflictingIdentifiers.add(field.system_key.trim());
  });
  const seen = new Set<string>();
  let newCount = 0;
  const rows = labels.map((label, index): BatchFieldPreviewRow => {
    if (seen.has(label)) {
      return { index: index + 1, label, status: "duplicate", message: "输入中重复" };
    }
    seen.add(label);
    if (label.length > 120) {
      return { index: index + 1, label, status: "conflict", message: "超过 120 个字符" };
    }
    if (RESERVED_FIELD_LABELS.has(label)) {
      return { index: index + 1, label, status: "conflict", message: "系统保留字段" };
    }
    const existing = existingByLabel.get(label);
    if (existing) {
      return {
        index: index + 1,
        label,
        status: existing.is_core ? "existing-core" : "existing",
        message: existing.is_core ? "已有·核心" : "已有",
      };
    }
    if (conflictingIdentifiers.has(label)) {
      return { index: index + 1, label, status: "conflict", message: "与系统标识冲突" };
    }
    newCount += 1;
    return { index: index + 1, label, status: "new", message: "待新增" };
  });
  if (labels.length > MAX_BATCH_FIELD_LABELS) {
    rows.slice(MAX_BATCH_FIELD_LABELS).forEach((row) => {
      row.status = "conflict";
      row.message = `一次最多 ${MAX_BATCH_FIELD_LABELS} 个`;
    });
    newCount = rows.filter((row) => row.status === "new").length;
  }
  return {
    rows,
    labels,
    newCount,
    hasErrors: rows.some((row) => row.status === "duplicate" || row.status === "conflict"),
  };
}
