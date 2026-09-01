export type DataType = "text" | "number" | "date" | "select";
export type RecordStatus = "待实验" | "已完成";
export type ValidationMode = "suggestion" | "warning" | "strict";

export interface FieldValidationRules {
  required?: boolean;
  min_number?: number | null;
  max_number?: number | null;
  decimal_places?: number | null;
  min_date?: string | null;
  max_date?: string | null;
  max_length?: number | null;
}
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
  validation_mode?: ValidationMode;
  validation_rules?: FieldValidationRules;
  default_value?: string | null;
  options: FieldOption[];
}

export interface FieldBatchCreateResult {
  retained: FieldDefinition[];
  created: FieldDefinition[];
}

export interface Project {
  id: string;
  name: string;
  sort_order: number;
  experiment_enabled: boolean;
  fields: FieldDefinition[];
}

export interface ProjectForceDeleteResult {
  project_id: string;
  project_name: string;
  deleted_records: number;
  deleted_record_values: number;
  deleted_fields: number;
  deleted_field_options: number;
  deleted_report_templates: number;
  deleted_report_versions: number;
  deleted_report_mappings: number;
  updated_auto_export_tasks: number;
  removed_template_directories: number;
  cleanup_warnings: string[];
}

export interface LedgerTemplateField {
  key: string;
  label: string;
  data_type: DataType;
  system_key: string | null;
  is_core: boolean;
  hidden: boolean;
  sort_order: number;
  width: number;
  validation_mode?: ValidationMode;
  validation_rules?: FieldValidationRules;
  default_value?: string | null;
  options: string[];
}

export interface RecordSortState {
  field_id: string;
  direction: "asc" | "desc";
}

export interface LedgerTemplate {
  id: string;
  name: string;
  description: string;
  fields: LedgerTemplateField[];
  created_at: string;
  updated_at: string;
}

export interface PreviewCapabilities {
  microsoft_office: boolean;
  microsoft_writer: boolean;
  microsoft_spreadsheet: boolean;
  wps_writer: boolean;
  wps_spreadsheet: boolean;
  native_preview: boolean;
  preferred_engine: "microsoft" | "wps" | null;
}

export type NativePreviewAction = "preview" | "open";
export type NativePreviewStatus = "starting" | "open" | "completed" | "failed";

export interface NativePreviewTask {
  job_id: string;
  status: NativePreviewStatus;
  action: NativePreviewAction;
  print_engine: Exclude<PrintEngine, "auto">;
  document_type: "xlsx" | "docx";
  filename: string;
  error: string | null;
  scope?: "selection" | "filtered" | "all" | null;
}

export interface ProjectRecord {
  id: string;
  project_id: string;
  project_name: string;
  position: number;
  pathology_number: string;
  block_number?: string | null;
  status: RecordStatus;
  experiment_date: string | null;
  experiment_number: string | null;
  report_generated: boolean;
  locked: boolean;
  highlight_color: string | null;
  cell_highlight_colors?: Record<string, string>;
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
  block_number?: string | null;
  status: RecordStatus;
  experiment_date: string | null;
  experiment_number?: string | null;
  highlight_color?: string | null;
  values: Record<string, string>;
  insert_before_record_id?: string;
  insert_after_record_id?: string;
}

export type RecordFieldFilterOperator =
  | "contains"
  | "equals"
  | "in"
  | "date_between"
  | "number_between"
  | "is_empty"
  | "not_empty";

export interface RecordFieldFilter {
  field_id: string;
  operator: RecordFieldFilterOperator;
  value?: string | null;
  values?: string[];
  start?: string | null;
  end?: string | null;
}

export interface RecordComplexQuery {
  project_id: string;
  status?: string | null;
  search?: string | null;
  experiment_date_from?: string | null;
  experiment_date_to?: string | null;
  report_generated?: boolean | null;
  field_filters: RecordFieldFilter[];
  sort?: RecordSortState | null;
  limit: number;
  offset: number;
}

export interface RecordIdList {
  record_ids: string[];
  total: number;
}

export interface RecordCellChange {
  record_id: string;
  field_id: string;
  value: string;
  expected_value?: string | null;
}

export interface RecordBatchNewRecord {
  client_id: string;
  pathology_number: string;
  block_number?: string | null;
  status: RecordStatus;
  experiment_date: string | null;
  experiment_number: string | null;
  values: Record<string, string>;
  insert_before_record_id?: string;
  insert_after_record_id?: string;
}

export interface RecordValidationIssue {
  record_id: string;
  field_id: string;
  severity: "suggestion" | "warning" | "error";
  message: string;
}

export interface RecordCellBatchPreview {
  token: string;
  affected_count: number;
  skipped_locked: number;
  issues: RecordValidationIssue[];
  expires_at: string;
}

export interface RecordCellBatchCommitResult {
  records: ProjectRecord[];
  skipped_locked: number;
  changes: Array<{
    record_id: string;
    field_id: string;
    before: string;
    after: string;
  }>;
  created_record_ids: string[];
  before: ProjectRecord[];
  after: ProjectRecord[];
}

export interface RecordReplacePreview {
  token: string;
  matched_count: number;
  skipped_locked: number;
  issues: RecordValidationIssue[];
  samples: RecordCellChange[];
  expires_at: string;
}

export interface RecordUpdateInput {
  pathology_number?: string;
  block_number?: string | null;
  status?: RecordStatus;
  experiment_date?: string | null;
  experiment_number?: string | null;
  highlight_color?: string | null;
  values?: Record<string, string>;
}

export type RecordOperationDirection = "undo" | "redo";

export interface RecordOperationApplyInput {
  operation_id: string;
  project_id: string;
  direction: RecordOperationDirection;
  before: ProjectRecord[];
  after: ProjectRecord[];
}

export interface RecordOperationApplyResult {
  records: ProjectRecord[];
  deleted_ids: string[];
}

export interface WorkbookImportRow {
  row_number: number;
  record_id: string | null;
  pathology_number: string;
  block_number?: string | null;
  status: RecordStatus;
  experiment_date: string | null;
  experiment_number: string | null;
  values: Record<string, string>;
}

export interface WorkbookImportPreviewRow extends WorkbookImportRow {
  action: "create" | "update";
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

export interface WorkbookImportPreview {
  filename: string;
  project_id: string;
  selected_sheet: string;
  available_sheets: string[];
  rows: WorkbookImportPreviewRow[];
  create_count: number;
  update_count: number;
  errors: string[];
}

export type BulkDeleteDateField = "experiment_date" | "created_at" | "updated_at";

export interface BulkDeleteFilter {
  project_id: string;
  date_field: BulkDeleteDateField;
  start_date: string;
  end_date: string;
}

export interface BulkDeletePreview {
  total: number;
  locked_count: number;
  record_ids: string[];
  items: Array<Pick<ProjectRecord, "id" | "pathology_number" | "status" | "experiment_date" | "created_at" | "updated_at" | "locked">>;
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

export interface ReportTemplateDeleteResult {
  template_id: string;
  removed_template_directory: boolean;
  cleanup_warnings: string[];
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

export interface BulkDeleteResult {
  deleted: number;
  deleted_records: ProjectRecord[];
}

export interface AuditLogPage {
  items: AuditLog[];
  total: number;
  limit: number;
  offset: number;
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
