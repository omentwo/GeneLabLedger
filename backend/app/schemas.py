from __future__ import annotations

import re
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DataType = Literal["text", "number", "date", "select"]
RecordStatus = Literal["待实验", "已完成"]
ValidationMode = Literal["suggestion", "warning", "strict"]
_HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


def normalize_highlight_color(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if not _HEX_COLOR_PATTERN.fullmatch(cleaned):
        raise ValueError("底色必须是 6 位十六进制颜色，例如 #FFF2CC")
    return cleaned.lower()


def normalize_cell_highlight_colors(value: dict[str, str] | None) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("单元格底色必须是字段 ID 到颜色的映射")
    result: dict[str, str] = {}
    for field_id, color in value.items():
        if not isinstance(field_id, str) or not field_id.strip():
            raise ValueError("单元格底色字段 ID 不能为空")
        if not isinstance(color, str):
            raise ValueError("单元格底色必须使用十六进制颜色")
        normalized = normalize_highlight_color(color)
        if normalized is not None:
            result[field_id.strip()] = normalized
    return result


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


class FieldValidationRules(BaseModel):
    required: bool = False
    min_number: float | None = None
    max_number: float | None = None
    decimal_places: int | None = Field(default=None, ge=0, le=12)
    min_date: date | None = None
    max_date: date | None = None
    max_length: int | None = Field(default=None, ge=1, le=10000)

    @model_validator(mode="after")
    def validate_ranges(self) -> FieldValidationRules:
        if (
            self.min_number is not None
            and self.max_number is not None
            and self.min_number > self.max_number
        ):
            raise ValueError("最小数字不能大于最大数字")
        if self.min_date is not None and self.max_date is not None and self.min_date > self.max_date:
            raise ValueError("最早日期不能晚于最晚日期")
        return self


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
    validation_mode: ValidationMode = "suggestion"
    validation_rules: dict[str, object] = Field(default_factory=dict)
    default_value: str | None = None
    options: list[FieldOptionRead] = Field(default_factory=list)


class FieldCreate(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    data_type: DataType = "text"
    width: int = Field(default=120, ge=58, le=600)
    options: list[str] = Field(default_factory=list)
    validation_mode: ValidationMode = "suggestion"
    validation_rules: FieldValidationRules = Field(default_factory=FieldValidationRules)
    default_value: str | None = Field(default=None, max_length=10000)

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


    @field_validator("default_value")
    @classmethod
    def clean_default_value(cls, value: str | None) -> str | None:
        cleaned = value.strip() if value is not None else ""
        return cleaned or None


class FieldBatchCreate(BaseModel):
    labels: list[str] = Field(min_length=1, max_length=100)

    @field_validator("labels")
    @classmethod
    def clean_labels(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for value in values:
            cleaned = value.strip()
            if not cleaned:
                raise ValueError("表头名称不能为空")
            if len(cleaned) > 120:
                raise ValueError(f"表头名称不能超过 120 个字符：{cleaned[:20]}")
            if cleaned in seen:
                raise ValueError(f"表头名称重复：{cleaned}")
            seen.add(cleaned)
            result.append(cleaned)
        return result


class FieldBatchCreateResponse(BaseModel):
    retained: list[FieldRead] = Field(default_factory=list)
    created: list[FieldRead] = Field(default_factory=list)


class FieldUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    data_type: DataType | None = None
    sort_order: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=58, le=600)
    hidden: bool | None = None
    validation_mode: ValidationMode | None = None
    validation_rules: FieldValidationRules | None = None
    default_value: str | None = Field(default=None, max_length=10000)

    @field_validator("label")
    @classmethod
    def clean_optional_label(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("default_value")
    @classmethod
    def clean_optional_default_value(cls, value: str | None) -> str | None:
        cleaned = value.strip() if value is not None else ""
        return cleaned or None


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
    template_id: str | None = Field(default=None, max_length=36)

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
    fields: list[FieldRead] = Field(default_factory=list)


class ProjectDuplicateCreate(BaseModel):
    name: str | None = Field(default=None, max_length=120)

    @field_validator("name")
    @classmethod
    def clean_optional_name(cls, value: str | None) -> str | None:
        cleaned = value.strip() if value is not None else None
        return cleaned or None


class ProjectForceDeleteRequest(BaseModel):
    """Explicit confirmation for the irreversible project deletion endpoint."""

    confirm_name: str = Field(min_length=1, max_length=120)

    @field_validator("confirm_name")
    @classmethod
    def clean_confirm_name(cls, value: str) -> str:
        return value.strip()


class ProjectForceDeleteResponse(BaseModel):
    project_id: str
    project_name: str
    deleted_records: int
    deleted_record_values: int
    deleted_fields: int
    deleted_field_options: int
    deleted_report_templates: int
    deleted_report_versions: int
    deleted_report_mappings: int
    updated_auto_export_tasks: int
    removed_template_directories: int
    cleanup_warnings: list[str] = Field(default_factory=list)


class LedgerTemplateField(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=120)
    data_type: DataType = "text"
    system_key: str | None = Field(default=None, max_length=64)
    is_core: bool = False
    hidden: bool = False
    sort_order: int = Field(default=0, ge=0)
    width: int = Field(default=120, ge=58, le=600)
    options: list[str] = Field(default_factory=list)
    validation_mode: ValidationMode = "suggestion"
    validation_rules: FieldValidationRules = Field(default_factory=FieldValidationRules)
    default_value: str | None = Field(default=None, max_length=10000)

    @field_validator("key", "label")
    @classmethod
    def clean_text(cls, value: str) -> str:
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

    @field_validator("default_value")
    @classmethod
    def clean_default_value(cls, value: str | None) -> str | None:
        cleaned = value.strip() if value is not None else ""
        return cleaned or None

class LedgerTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    fields: list[LedgerTemplateField] = Field(default_factory=list, max_length=200)
    source_project_id: str | None = Field(default=None, max_length=36)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return value.strip()

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str) -> str:
        return value.strip()


class LedgerTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    fields: list[LedgerTemplateField] | None = Field(default=None, max_length=200)
    source_project_id: str | None = Field(default=None, max_length=36)

    @field_validator("name")
    @classmethod
    def clean_optional_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("description")
    @classmethod
    def clean_optional_description(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class LedgerTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str
    fields: list[LedgerTemplateField]
    created_at: datetime
    updated_at: datetime


class RecordCreate(BaseModel):
    project_id: str
    pathology_number: str = Field(min_length=1, max_length=160)
    block_number: str | None = Field(default=None, max_length=80)
    status: RecordStatus = "待实验"
    experiment_date: date | None = None
    experiment_number: str | None = Field(default=None, max_length=80)
    highlight_color: str | None = Field(default=None, max_length=7)
    values: dict[str, str] = Field(default_factory=dict)
    insert_before_record_id: str | None = Field(default=None, min_length=1, max_length=36)
    insert_after_record_id: str | None = Field(default=None, min_length=1, max_length=36)

    @field_validator("pathology_number")
    @classmethod
    def clean_pathology_number(cls, value: str) -> str:
        return value.strip()

    @field_validator("block_number", "experiment_number")
    @classmethod
    def clean_experiment_number(cls, value: str | None) -> str | None:
        return value.strip() if value is not None and value.strip() else None

    @field_validator("highlight_color")
    @classmethod
    def clean_highlight_color(cls, value: str | None) -> str | None:
        return normalize_highlight_color(value)

    @model_validator(mode="after")
    def validate_insert_anchor(self) -> RecordCreate:
        if self.insert_before_record_id and self.insert_after_record_id:
            raise ValueError("只能指定一个插入位置")
        return self


class RecordUpdate(BaseModel):
    pathology_number: str | None = Field(default=None, min_length=1, max_length=160)
    block_number: str | None = Field(default=None, max_length=80)
    status: RecordStatus | None = None
    experiment_date: date | None = None
    experiment_number: str | None = Field(default=None, max_length=80)
    highlight_color: str | None = Field(default=None, max_length=7)
    values: dict[str, str] | None = None

    @field_validator("pathology_number")
    @classmethod
    def clean_optional_pathology_number(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("block_number", "experiment_number")
    @classmethod
    def clean_optional_experiment_number(cls, value: str | None) -> str | None:
        return value.strip() if value is not None and value.strip() else None

    @field_validator("highlight_color")
    @classmethod
    def clean_highlight_color(cls, value: str | None) -> str | None:
        return normalize_highlight_color(value)


class RecordExperimentNumberBatch(BaseModel):
    record_ids: list[str] = Field(min_length=1, max_length=1000)
    prefix: str = Field(min_length=1, max_length=80)

    @field_validator("prefix")
    @classmethod
    def clean_prefix(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("实验编号前缀不能为空")
        return cleaned


class RecordLockUpdate(BaseModel):
    locked: bool


class RecordReportStatusUpdate(BaseModel):
    record_ids: list[str] = Field(min_length=1, max_length=1000)
    report_generated: bool


class RecordHighlightUpdate(BaseModel):
    record_ids: list[str] = Field(min_length=1, max_length=1000)
    highlight_color: str | None = Field(default=None, max_length=7)

    @field_validator("highlight_color")
    @classmethod
    def clean_highlight_color(cls, value: str | None) -> str | None:
        return normalize_highlight_color(value)


class RecordCellHighlightTarget(BaseModel):
    record_id: str = Field(min_length=1, max_length=36)
    field_id: str = Field(min_length=1, max_length=36)

    @field_validator("record_id", "field_id")
    @classmethod
    def clean_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("ID 不能为空")
        return cleaned


class RecordCellHighlightUpdate(BaseModel):
    cells: list[RecordCellHighlightTarget] = Field(min_length=1, max_length=10000)
    highlight_color: str | None = Field(default=None, max_length=7)

    @field_validator("highlight_color")
    @classmethod
    def clean_highlight_color(cls, value: str | None) -> str | None:
        return normalize_highlight_color(value)


class RecordAssignProject(BaseModel):
    target_project_id: str


class RecordRead(BaseModel):
    id: str
    project_id: str
    project_name: str
    position: int
    pathology_number: str
    block_number: str | None
    status: str
    experiment_date: date | None
    experiment_number: str | None
    report_generated: bool
    locked: bool
    highlight_color: str | None
    cell_highlight_colors: dict[str, str] = Field(default_factory=dict)
    values: dict[str, str]
    created_at: datetime
    updated_at: datetime


class RecordOperationSnapshot(BaseModel):
    """A complete record state used by the session-scoped undo/redo API."""

    id: str = Field(min_length=1, max_length=36)
    project_id: str = Field(min_length=1, max_length=36)
    position: int = Field(ge=1)
    pathology_number: str = Field(min_length=1, max_length=160)
    block_number: str | None = Field(default=None, max_length=80)
    status: RecordStatus
    experiment_date: date | None = None
    experiment_number: str | None = Field(default=None, max_length=80)
    report_generated: bool = False
    locked: bool = False
    highlight_color: str | None = Field(default=None, max_length=7)
    cell_highlight_colors: dict[str, str] = Field(default_factory=dict)
    values: dict[str, str] = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @field_validator("pathology_number")
    @classmethod
    def clean_snapshot_pathology_number(cls, value: str) -> str:
        return value.strip()

    @field_validator("block_number", "experiment_number")
    @classmethod
    def clean_snapshot_experiment_number(cls, value: str | None) -> str | None:
        return value.strip() if value is not None and value.strip() else None

    @field_validator("highlight_color")
    @classmethod
    def clean_snapshot_highlight_color(cls, value: str | None) -> str | None:
        return normalize_highlight_color(value)

    @field_validator("cell_highlight_colors")
    @classmethod
    def clean_snapshot_cell_highlight_colors(cls, value: dict[str, str]) -> dict[str, str]:
        return normalize_cell_highlight_colors(value)


class RecordOperationApply(BaseModel):
    operation_id: str = Field(min_length=1, max_length=80)
    project_id: str = Field(min_length=1, max_length=36)
    direction: Literal["undo", "redo"]
    before: list[RecordOperationSnapshot] = Field(default_factory=list, max_length=10000)
    after: list[RecordOperationSnapshot] = Field(default_factory=list, max_length=10000)

    @model_validator(mode="after")
    def validate_operation(self) -> RecordOperationApply:
        before_ids = [record.id for record in self.before]
        after_ids = [record.id for record in self.after]
        if len(before_ids) != len(set(before_ids)) or len(after_ids) != len(set(after_ids)):
            raise ValueError("台账操作中存在重复记录")
        if not self.before and not self.after:
            raise ValueError("台账操作不能为空")
        for record in [*self.before, *self.after]:
            if record.project_id != self.project_id:
                raise ValueError("台账操作不属于当前项目")
        return self


class RecordOperationApplyResult(BaseModel):
    records: list[RecordRead] = Field(default_factory=list)
    deleted_ids: list[str] = Field(default_factory=list)


class RecordList(BaseModel):
    items: list[RecordRead]
    total: int
    limit: int
    offset: int


class RecordFieldFilter(BaseModel):
    field_id: str = Field(min_length=1, max_length=36)
    operator: Literal[
        "contains",
        "equals",
        "in",
        "date_between",
        "number_between",
        "is_empty",
        "not_empty",
    ] = "contains"
    value: str | None = Field(default=None, max_length=10000)
    values: list[str] = Field(default_factory=list, max_length=500)
    start: str | None = Field(default=None, max_length=100)
    end: str | None = Field(default=None, max_length=100)


class RecordQuerySort(BaseModel):
    field_id: str = Field(min_length=1, max_length=36)
    direction: Literal["asc", "desc"] = "asc"


class RecordQueryRequest(BaseModel):
    project_id: str = Field(min_length=1, max_length=36)
    status: str | None = Field(default=None, max_length=40)
    search: str | None = Field(default=None, max_length=500)
    experiment_date_from: date | None = None
    experiment_date_to: date | None = None
    report_generated: bool | None = None
    field_filters: list[RecordFieldFilter] = Field(default_factory=list, max_length=200)
    sort: RecordQuerySort | None = None
    limit: int = Field(default=200, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_date_range(self) -> RecordQueryRequest:
        if (
            self.experiment_date_from is not None
            and self.experiment_date_to is not None
            and self.experiment_date_from > self.experiment_date_to
        ):
            raise ValueError("开始日期不能晚于结束日期")
        return self


class RecordIdList(BaseModel):
    record_ids: list[str] = Field(default_factory=list)
    total: int


class RecordIdsRequest(BaseModel):
    record_ids: list[str] = Field(min_length=1, max_length=20000)


class RecordCellChange(BaseModel):
    record_id: str = Field(min_length=1, max_length=36)
    field_id: str = Field(min_length=1, max_length=36)
    value: str = Field(default="", max_length=10000)
    expected_value: str | None = Field(default=None, max_length=10000)


class RecordBatchNewRecord(BaseModel):
    client_id: str = Field(min_length=1, max_length=100)
    pathology_number: str = Field(min_length=1, max_length=160)
    block_number: str | None = Field(default=None, max_length=80)
    status: RecordStatus = "待实验"
    experiment_date: date | None = None
    experiment_number: str | None = Field(default=None, max_length=80)
    values: dict[str, str] = Field(default_factory=dict)
    insert_before_record_id: str | None = Field(default=None, min_length=1, max_length=36)
    insert_after_record_id: str | None = Field(default=None, min_length=1, max_length=36)

    @model_validator(mode="after")
    def validate_insert_anchor(self) -> RecordBatchNewRecord:
        if self.insert_before_record_id and self.insert_after_record_id:
            raise ValueError("只能指定一个插入位置")
        return self


class RecordCellBatchPreview(BaseModel):
    project_id: str = Field(min_length=1, max_length=36)
    changes: list[RecordCellChange] = Field(default_factory=list, max_length=10000)
    new_records: list[RecordBatchNewRecord] = Field(default_factory=list, max_length=10000)

    @model_validator(mode="after")
    def validate_non_empty_batch(self) -> RecordCellBatchPreview:
        if not self.changes and not self.new_records:
            raise ValueError("批量操作不能为空")
        client_ids = [record.client_id for record in self.new_records]
        if len(client_ids) != len(set(client_ids)):
            raise ValueError("新增记录中存在重复的客户端标识")
        return self


class RecordValidationIssue(BaseModel):
    record_id: str
    field_id: str
    severity: Literal["suggestion", "warning", "error"]
    message: str


class RecordCreateValidationRead(BaseModel):
    issues: list[RecordValidationIssue] = Field(default_factory=list)


class RecordCellBatchPreviewRead(BaseModel):
    token: str
    affected_count: int
    skipped_locked: int
    issues: list[RecordValidationIssue] = Field(default_factory=list)
    expires_at: datetime


class RecordCellBatchCommit(BaseModel):
    token: str = Field(min_length=32, max_length=64)
    accept_warnings: bool = False
    include_snapshots: bool = False


class RecordCommittedCellChange(BaseModel):
    record_id: str
    field_id: str
    before: str
    after: str


class RecordCellBatchCommitRead(BaseModel):
    records: list[RecordRead] = Field(default_factory=list)
    skipped_locked: int = 0
    changes: list[RecordCommittedCellChange] = Field(default_factory=list)
    created_record_ids: list[str] = Field(default_factory=list)
    before: list[RecordOperationSnapshot] = Field(default_factory=list)
    after: list[RecordOperationSnapshot] = Field(default_factory=list)


class RecordReplacePreview(BaseModel):
    project_id: str = Field(min_length=1, max_length=36)
    field_id: str = Field(min_length=1, max_length=36)
    record_ids: list[str] = Field(min_length=1, max_length=20000)
    find: str = Field(default="", max_length=10000)
    replacement: str = Field(default="", max_length=10000)
    match_mode: Literal["substring", "whole"] = "substring"
    case_sensitive: bool = False


class RecordReplacePreviewRead(BaseModel):
    token: str
    matched_count: int
    skipped_locked: int
    issues: list[RecordValidationIssue] = Field(default_factory=list)
    samples: list[RecordCellChange] = Field(default_factory=list)
    expires_at: datetime


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


class ReportTemplateDeleteResponse(BaseModel):
    template_id: str
    removed_template_directory: bool
    cleanup_warnings: list[str] = Field(default_factory=list)


class ReportBatchItem(BaseModel):
    project_record_id: str


class PrinterRead(BaseModel):
    name: str
    is_default: bool


class PrintEngineRead(BaseModel):
    key: Literal["auto", "wps", "word"]
    label: str
    available: bool
    resolved_engine: Literal["wps", "word"] | None


PreviewScope = Literal["selection", "project", "filtered", "all"]
NativePreviewAction = Literal["preview", "open"]
NativePreviewStatus = Literal["starting", "open", "completed", "failed"]


class PreviewCellTarget(BaseModel):
    record_id: str = Field(min_length=1, max_length=36)
    field_id: str = Field(min_length=1, max_length=36)


class LedgerPrintPreviewCreate(BaseModel):
    scope: PreviewScope = "filtered"
    cells: list[PreviewCellTarget] = Field(default_factory=list, max_length=10000)
    search: str | None = Field(default=None, max_length=240)
    status: str | None = Field(default=None, max_length=40)
    experiment_date: date | None = None
    report_generated: bool | None = None
    print_engine: Literal["auto", "wps", "word"] = "auto"


class PreviewCapabilitiesRead(BaseModel):
    microsoft_office: bool
    microsoft_writer: bool = False
    microsoft_spreadsheet: bool = False
    wps_writer: bool = False
    wps_spreadsheet: bool = False
    native_preview: bool = False
    preferred_engine: Literal["microsoft", "wps"] | None


class LedgerPrintPreviewRead(BaseModel):
    preview_id: str
    url: str
    filename: str
    print_engine: Literal["wps", "word"]
    scope: PreviewScope
    selected_cell_count: int


class LedgerNativePreviewCreate(LedgerPrintPreviewCreate):
    action: NativePreviewAction = "preview"


class ReportPrintPreviewCreate(BaseModel):
    template_version_id: str = Field(min_length=1, max_length=36)
    record_ids: list[str] = Field(min_length=1, max_length=100)
    print_engine: Literal["auto", "wps", "word"] = "auto"


class ReportPrintPreviewRead(BaseModel):
    preview_id: str
    url: str
    filename: str
    print_engine: Literal["wps", "word"]
    record_count: int


class ReportNativePreviewCreate(BaseModel):
    template_version_id: str = Field(min_length=1, max_length=36)
    record_ids: list[str] = Field(min_length=1, max_length=1)
    print_engine: Literal["auto", "wps", "word"] = "auto"
    action: NativePreviewAction = "preview"


class NativePreviewRead(BaseModel):
    job_id: str
    status: NativePreviewStatus
    action: NativePreviewAction
    print_engine: Literal["wps", "word"]
    document_type: Literal["xlsx", "docx"]
    filename: str
    error: str | None = None
    scope: PreviewScope | None = None


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


class AuditLogPageRead(BaseModel):
    items: list[AuditLogRead]
    total: int
    limit: int
    offset: int


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
    hidden_columns: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_rows(self) -> WorkbookSheetInput:
        if any(len(row) > len(self.headers) for row in self.rows):
            raise ValueError("工作表数据列数不能超过表头列数")
        if any(index < 1 or index > len(self.headers) for index in self.hidden_columns):
            raise ValueError("隐藏列序号必须位于表头范围内")
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


class WorkbookImportRow(BaseModel):
    row_number: int = Field(ge=2)
    record_id: str | None = None
    pathology_number: str = Field(min_length=1, max_length=160)
    block_number: str | None = Field(default=None, max_length=80)
    status: RecordStatus = "待实验"
    experiment_date: date | None = None
    experiment_number: str | None = Field(default=None, max_length=80)
    values: dict[str, str] = Field(default_factory=dict)

    @field_validator("pathology_number")
    @classmethod
    def clean_pathology_number(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("病理号不能为空")
        return value

    @field_validator("block_number", "experiment_number")
    @classmethod
    def clean_experiment_number(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class WorkbookImportPreviewRow(WorkbookImportRow):
    action: Literal["create", "update"]
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


class WorkbookImportPreviewRead(BaseModel):
    filename: str
    project_id: str
    selected_sheet: str
    available_sheets: list[str]
    rows: list[WorkbookImportPreviewRow]
    create_count: int
    update_count: int
    errors: list[str]


class WorkbookImportCommit(BaseModel):
    project_id: str
    rows: list[WorkbookImportRow] = Field(min_length=1, max_length=10000)
    accept_warnings: bool = False


class WorkbookImportResult(BaseModel):
    created: int
    updated: int
    record_ids: list[str]


class BulkDeleteFilter(BaseModel):
    project_id: str
    date_field: Literal["experiment_date", "created_at", "updated_at"] = "experiment_date"
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def validate_range(self) -> BulkDeleteFilter:
        if self.start_date > self.end_date:
            raise ValueError("开始日期不能晚于结束日期")
        return self


class BulkDeletePreviewItem(BaseModel):
    id: str
    pathology_number: str
    status: str
    experiment_date: date | None
    created_at: datetime
    updated_at: datetime
    locked: bool


class BulkDeletePreviewRead(BaseModel):
    total: int
    locked_count: int
    record_ids: list[str]
    items: list[BulkDeletePreviewItem]


class BulkDeleteExecute(BaseModel):
    filter: BulkDeleteFilter
    expected_record_ids: list[str] = Field(min_length=1, max_length=10000)


class BulkDeleteResult(BaseModel):
    deleted: int
    deleted_records: list[RecordOperationSnapshot] = Field(default_factory=list)



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
