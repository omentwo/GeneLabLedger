from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Literal

from app.models import FieldDefinition

IssueSeverity = Literal["suggestion", "warning", "error"]


@dataclass(frozen=True)
class FieldValueIssue:
    severity: IssueSeverity
    message: str


def validate_field_value(
    field: FieldDefinition,
    raw_value: object,
) -> tuple[str, list[FieldValueIssue]]:
    """Normalize and validate one core or custom ledger cell."""
    value = "" if raw_value is None else str(raw_value).strip()
    system_key = field.system_key
    if system_key == "pathology_number":
        return value, ([] if value else [FieldValueIssue("error", "病理号不能为空")])
    if system_key == "status":
        return value, (
            []
            if value in {"待实验", "已完成"}
            else [FieldValueIssue("error", "状态只能是“待实验”或“已完成”")]
        )
    if system_key == "experiment_date":
        if not value:
            return value, []
        try:
            parsed = date.fromisoformat(value)
        except ValueError:
            return value, [FieldValueIssue("error", "日期必须使用有效的 YYYY-MM-DD 格式")]
        return parsed.isoformat(), []
    if system_key in {"block_number", "experiment_number"}:
        return value, []

    return value, []


def validate_default_value(
    field: FieldDefinition,
    raw_value: object,
) -> tuple[str | None, list[FieldValueIssue]]:
    """Normalize a configured default without treating an unset default as required input."""
    if raw_value is None or not str(raw_value).strip():
        return None, []
    value = str(raw_value).strip()
    if field.data_type == "number":
        try:
            number = Decimal(value)
        except InvalidOperation:
            return value, [FieldValueIssue("error", f"{field.label}必须是数字")]
        if not number.is_finite():
            return value, [FieldValueIssue("error", f"{field.label}必须是有限数字")]
    elif field.data_type == "date":
        try:
            value = date.fromisoformat(value).isoformat()
        except ValueError:
            return value, [FieldValueIssue("error", f"{field.label}必须使用有效的 YYYY-MM-DD 格式")]
    elif field.data_type == "select":
        options = [option.value for option in field.options]
        if options and value not in options:
            return value, [FieldValueIssue("error", f"{field.label}未包含在备选项中")]
    return value, []


def new_record_field_value(field: FieldDefinition, values: dict[str, str]) -> object:
    """Respect an explicitly supplied value and otherwise use the field default."""
    if field.id in values:
        return values[field.id]
    return field.default_value or ""
