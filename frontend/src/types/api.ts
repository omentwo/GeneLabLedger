export type DataType = "text" | "number" | "date" | "select";
export type RecordStatus = "待实验" | "已完成";
export type MappingSourceType =
  | "unmapped"
  | "field"
  | "fixed"
  | "current_date"
  | "experiment_number"
  | "blank";

export interface FieldOption {
  id: string;
  value: string;
  sort_order: number;
}

export interface FieldDefinition {
  id: string;
  project_id: string;
  key: string;
  label: string;
  data_type: DataType;
  system_key: string | null;
  is_core: boolean;
  hidden: boolean;
  sort_order: number;
  width: number;
  options: FieldOption[];
}

export interface Project {
  id: string;
  name: string;
  sort_order: number;
  experiment_enabled: boolean;
  fields: FieldDefinition[];
}

export interface ProjectRecord {
  id: string;
  case_id: string;
  project_id: string;
  project_name: string;
  pathology_number: string;
  status: RecordStatus;
  experiment_date: string | null;
  experiment_number: string | null;
  report_generated: boolean;
  locked: boolean;
  values: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface RecordList {
  items: ProjectRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecordCreateInput {
  project_id: string;
  pathology_number: string;
  status: RecordStatus;
  experiment_date: string | null;
  experiment_number: string | null;
  values: Record<string, string>;
}

export interface RecordUpdateInput {
  pathology_number?: string;
  status?: RecordStatus;
  experiment_date?: string | null;
  experiment_number?: string | null;
  values?: Record<string, string>;
}

export interface ExperimentRun {
  id: string;
  batch_id: string;
  record_id: string;
  project_id: string;
  project_name: string;
  pathology_number: string;
  position: number;
  experiment_number: string;
  is_repeat: boolean;
  status: RecordStatus;
}

export interface ExperimentBatch {
  id: string | null;
  experiment_date: string;
  runs: ExperimentRun[];
}

export interface ReportMapping {
  id: string;
  placeholder: string;
  source_type: MappingSourceType;
  field_id: string | null;
  fixed_value: string | null;
}

export interface ReportTemplateVersion {
  id: string;
  version_number: number;
  original_filename: string;
  placeholders: string[];
  mappings: ReportMapping[];
  created_at: string;
}

export interface ReportTemplate {
  id: string;
  project_id: string;
  project_name: string;
  name: string;
  versions: ReportTemplateVersion[];
  created_at: string;
}

export interface Printer {
  name: string;
  is_default: boolean;
}

export type PrintEngine = "auto" | "wps" | "word";

export interface PrintEngineStatus {
  key: PrintEngine;
  label: string;
  available: boolean;
  resolved_engine: Exclude<PrintEngine, "auto"> | null;
}

export interface ReportPrintResult {
  printer_name: string;
  printed_count: number;
  print_engine: Exclude<PrintEngine, "auto">;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface HealthStatus {
  status: string;
  database: string;
  print_engines: PrintEngineStatus[];
}

export type AutoExportScheduleType = "preset" | "cron";
export type AutoExportPreset = "hourly" | "daily" | "weekly" | "monthly";
export type AutoExportFormat = "xlsx";

export interface AutoExportTaskInput {
  name: string;
  project_ids: string[];
  output_directory: string;
  file_format: AutoExportFormat;
  schedule_type: AutoExportScheduleType;
  preset: AutoExportPreset;
  run_time: string;
  hourly_minute: number;
  weekday: number;
  month_day: number;
  cron_expression: string | null;
  failure_retries: number;
  retention_count: number | null;
  enabled: boolean;
}

export interface AutoExportTask extends AutoExportTaskInput {
  id: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutoExportRun {
  id: string;
  task_id: string;
  trigger: string;
  status: string;
  attempt_count: number;
  file_path: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface AutoExportConfig {
  default_output_directory: string;
  timezone: string;
  cron_format: string;
}
