import type { FieldDefinition, ProjectRecord } from "@/types/api";

/** Read the stored field value without formatting it or changing the record. */
export function getRecordFieldValue(record: ProjectRecord, field: FieldDefinition): string {
  if (field.system_key === "pathology_number") return record.pathology_number ?? "";
  if (field.system_key === "block_number") return record.block_number ?? "";
  if (field.system_key === "experiment_date") return record.experiment_date ?? "";
  if (field.system_key === "experiment_number") return record.experiment_number ?? "";
  if (field.system_key === "status") return record.status ?? "";
  return record.values?.[field.id] ?? "";
}
