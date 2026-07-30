from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DataType = Literal["text", "number", "date", "select"]
RecordStatus = Literal["待实验", "已完成"]
MappingSourceType = Literal[
    "unmapped",
    "field",
    "fixed",
    "current_date",
    "experiment_number",
    "blank",
]


class ApiMessage(BaseModel):
    message: str


class FieldOptionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    value: str
    sort_order: int


class FieldRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    key: str
    label: str
    data_type: str
    system_key: str | None
    is_core: bool
    hidden: bool
    sort_order: int
    width: int
    options: list[FieldOptionRead] = []


class FieldCreate(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    data_type: DataType = "text"
    width: int = Field(default=120, ge=58, le=600)
    options: list[str] = []

    @field_validator("label")
    @classmethod
    def clean_label(cls, value: str) -> str:
        return value.strip()

    @field_validator("options")
    @classmethod
    def clean_options(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            cleaned = value.strip()
            if cleaned and cleaned not in result:
                result.append(cleaned)
        return result


class FieldUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    data_type: DataType | None = None
    sort_order: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=58, le=600)
    hidden: bool | None = None

    @field_validator("label")
    @classmethod
    def clean_optional_label(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class FieldOptionsReplace(BaseModel):
    options: list[str]

    @field_validator("options")
    @classmethod
    def clean_options(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            cleaned = value.strip()
            if cleaned and cleaned not in result:
                result.append(cleaned)
        return result


class FieldReorder(BaseModel):
    field_ids: list[str] = Field(min_length=1)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return value.strip()


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    sort_order: int | None = Field(default=None, ge=0)
    experiment_enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def clean_optional_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    sort_order: int
    experiment_enabled: bool
    fields: list[FieldRead] = []


class RecordCreate(BaseModel):
    project_id: str
    pathology_number: str = Field(min_length=1, max_length=160)
    status: RecordStatus = "待实验"
    experiment_date: date | None = None
    experiment_number: str | None = Field(default=None, max_length=80)
    values: dict[str, str] = {}

    @field_validator("pathology_number")
    @classmethod
    def clean_pathology_number(cls, value: str) -> str:
        return value.strip()


class RecordUpdate(BaseModel):
    pathology_number: str | None = Field(default=None, min_length=1, max_length=160)
    status: RecordStatus | None = None
    experiment_date: date | None = None
    experiment_number: str | None = Field(default=None, max_length=80)
    values: dict[str, str] | None = None

    @field_validator("pathology_number")
    @classmethod
    def clean_optional_pathology_number(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class RecordLockUpdate(BaseModel):
    locked: bool


class RecordReportStatusUpdate(BaseModel):
    record_ids: list[str] = Field(min_length=1, max_length=1000)
    report_generated: bool


class RecordAssignProject(BaseModel):
    target_project_id: str


class RecordRepeat(BaseModel):
    experiment_date: date


class RecordRead(BaseModel):
    id: str
    case_id: str
    project_id: str
    project_name: str
    pathology_number: str
    status: str
    experiment_date: date | None
    experiment_number: str | None
    report_generated: bool
    locked: bool
    values: dict[str, str]
    created_at: datetime
    updated_at: datetime


class RecordList(BaseModel):
    items: list[RecordRead]
    total: int
    limit: int
    offset: int


class ExperimentRunAdd(BaseModel):
    record_id: str
    allow_repeat: bool = False


class ExperimentRunReorder(BaseModel):
    run_ids: list[str]


class ExperimentRunRead(BaseModel):
    id: str
    batch_id: str
    record_id: str
    project_id: str
    project_name: str
    pathology_number: str
    position: int
    experiment_number: str
    is_repeat: bool
    status: str


class ExperimentBatchRead(BaseModel):
    id: str | None
    experiment_date: date
    runs: list[ExperimentRunRead]


class ExperimentCommitRead(BaseModel):
    experiment_date: date
    updated_records: int


class ReportMappingInput(BaseModel):
    placeholder: str = Field(min_length=1, max_length=240)
    source_type: MappingSourceType
    field_id: str | None = None
    fixed_value: str | None = None

    @field_validator("placeholder")
    @classmethod
    def clean_placeholder(cls, value: str) -> str:
        return value.strip()


class ReportMappingsReplace(BaseModel):
    mappings: list[ReportMappingInput]


class ReportMappingRead(BaseModel):
    id: str
    placeholder: str
    source_type: str
    field_id: str | None
    fixed_value: str | None


class ReportTemplateVersionRead(BaseModel):
    id: str
    version_number: int
    original_filename: str
    placeholders: list[str]
    mappings: list[ReportMappingRead]
    created_at: datetime


class ReportTemplateRead(BaseModel):
    id: str
    project_id: str
    project_name: str
    name: str
    versions: list[ReportTemplateVersionRead]
    created_at: datetime


class ReportBatchItem(BaseModel):
    project_record_id: str
    experiment_run_id: str | None = None


class ReportDocumentsCreate(BaseModel):
    template_version_id: str
    items: list[ReportBatchItem] = Field(min_length=1, max_length=100)


class PrinterRead(BaseModel):
    name: str
    is_default: bool


class PrintEngineRead(BaseModel):
    key: Literal["auto", "wps", "word"]
    label: str
    available: bool
    resolved_engine: Literal["wps", "word"] | None


class ReportPrintCreate(BaseModel):
    template_version_id: str
    items: list[ReportBatchItem] = Field(min_length=1, max_length=100)
    printer_name: str = Field(min_length=1, max_length=260)
    print_engine: Literal["auto", "wps", "word"] = "auto"


class ReportPrintRead(BaseModel):
    printer_name: str
    printed_count: int
    print_engine: Literal["wps", "word"]


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    actor: str
    action: str
    entity_type: str
    entity_id: str | None
    details: dict
    created_at: datetime


class HealthRead(BaseModel):
    status: str
    database: str
    print_engines: list[PrintEngineRead]


class AppSettingRead(BaseModel):
    key: str
    value: object


class AppSettingUpdate(BaseModel):
    value: object


WorkbookCell = str | int | float | bool | None


class WorkbookSheetInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    headers: list[str] = Field(min_length=1, max_length=200)
    rows: list[list[WorkbookCell]] = Field(default_factory=list, max_length=10000)

    @model_validator(mode="after")
    def validate_rows(self) -> WorkbookSheetInput:
        if any(len(row) > len(self.headers) for row in self.rows):
            raise ValueError("工作表数据列数不能超过表头列数")
        return self


class WorkbookExportCreate(BaseModel):
    filename: str = Field(min_length=1, max_length=120)
    sheets: list[WorkbookSheetInput] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_cell_count(self) -> WorkbookExportCreate:
        cell_count = sum(len(sheet.headers) * (len(sheet.rows) + 1) for sheet in self.sheets)
        if cell_count > 2_000_000:
            raise ValueError("导出内容过大，请缩小项目或时间范围")
        return self


class AutoExportTaskInput(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    project_ids: list[str] = Field(min_length=1)
    output_directory: str = Field(min_length=1, max_length=600)
    file_format: Literal["xlsx"] = "xlsx"
    schedule_type: Literal["preset", "cron"] = "preset"
    preset: Literal["hourly", "daily", "weekly", "monthly"] = "daily"
    run_time: str = "18:00"
    hourly_minute: int = Field(default=0, ge=0, le=59)
    weekday: int = Field(default=0, ge=0, le=6)
    month_day: int = Field(default=1, ge=1, le=31)
    cron_expression: str | None = Field(default=None, max_length=160)
    failure_retries: int = Field(default=0, ge=0, le=10)
    retention_count: int | None = Field(default=10, ge=1, le=10000)
    enabled: bool = True

    @field_validator("name", "output_directory")
    @classmethod
    def clean_required_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("project_ids")
    @classmethod
    def unique_project_ids(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))

    @field_validator("cron_expression")
    @classmethod
    def clean_cron_expression(cls, value: str | None) -> str | None:
        return value.strip() if value and value.strip() else None

    @field_validator("run_time")
    @classmethod
    def validate_run_time(cls, value: str) -> str:
        try:
            hour_text, minute_text = value.split(":", 1)
            hour, minute = int(hour_text), int(minute_text)
        except (TypeError, ValueError) as error:
            raise ValueError("执行时间格式应为 HH:MM") from error
        if not 0 <= hour <= 23 or not 0 <= minute <= 59:
            raise ValueError("执行时间格式应为 HH:MM")
        return f"{hour:02d}:{minute:02d}"

    @model_validator(mode="after")
    def validate_schedule(self) -> AutoExportTaskInput:
        if self.schedule_type == "cron" and not self.cron_expression:
            raise ValueError("使用 Cron 周期时必须填写 Cron 表达式")
        return self


class AutoExportRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    task_id: str
    trigger: str
    status: str
    attempt_count: int
    file_path: str | None
    error_message: str | None
    started_at: datetime
    finished_at: datetime | None


class AutoExportTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    project_ids: list[str]
    output_directory: str
    file_format: str
    schedule_type: str
    preset: str
    run_time: str
    hourly_minute: int
    weekday: int
    month_day: int
    cron_expression: str | None
    failure_retries: int
    retention_count: int | None
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_status: str | None
    last_message: str | None
    created_at: datetime
    updated_at: datetime
