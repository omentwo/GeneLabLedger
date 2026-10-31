from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Literal

from app.models import FieldDefinition

IssueSeverity = Literal["warning", "error"]

# 严格 YYYY-MM-DD：date.fromisoformat 还接受 20260907 / 2026-W36-1 等格式，
# 与"日期必须使用有效的 YYYY-MM-DD 格式"的提示不符，这里先做形态校验。
_STRICT_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class FieldValueIssue:
    severity: IssueSeverity
    message: str


def _typed_value_issues(field: FieldDefinition, value: str) -> list[FieldValueIssue]:
    """按 data_type 校验自定义字段的值；单元格与默认值两条路径共用同一实现，
    避免"默认值能存、单元格存不进"的双标准。"""
    if not value:
        return []
    if field.data_type == "number":
        try:
            number = Decimal(value)
        except InvalidOperation:
            return [FieldValueIssue("error", f"{field.label}必须是数字")]
        if not number.is_finite():
            return [FieldValueIssue("error", f"{field.label}必须是有限数字")]
    elif field.data_type == "date":
        if not _STRICT_ISO_DATE.fullmatch(value):
            return [FieldValueIssue("error", f"{field.label}必须使用有效的 YYYY-MM-DD 格式")]
        try:
            date.fromisoformat(value)
        except ValueError:
            return [FieldValueIssue("error", f"{field.label}必须使用有效的 YYYY-MM-DD 格式")]
    elif field.data_type == "select":
        options = [option.value for option in field.options]
        if options and value not in options:
            return [FieldValueIssue("error", f"{field.label}未包含在备选项中")]
    return []


def validate_field_value(
    field: FieldDefinition,
    raw_value: object,
) -> tuple[str, list[FieldValueIssue]]:
    """Normalize and validate one core or custom ledger cell."""
    value = "" if raw_value is None else str(raw_value).strip()
    system_key = field.system_key
    if system_key == "pathology_number":
        issues: list[FieldValueIssue] = []
        if not value:
            issues.append(FieldValueIssue("error", "病理号不能为空"))
        elif len(value) > 160:
            # 与 quick-create 的 parse_combined_pathology_number 上限一致；
            # SQLite 不强制 VARCHAR(160)，必须在应用层拦截。
            issues.append(FieldValueIssue("error", "病理号不能超过 160 个字符"))
        return value, issues
    if system_key == "status":
        return value, (
            []
            if value in {"待实验", "已完成"}
            else [FieldValueIssue("error", "状态只能是“待实验”或“已完成”")]
        )
    if system_key == "experiment_date":
        if not value:
            return value, []
        if not _STRICT_ISO_DATE.fullmatch(value):
            return value, [FieldValueIssue("error", "日期必须使用有效的 YYYY-MM-DD 格式")]
        try:
            parsed = date.fromisoformat(value)
        except ValueError:
            return value, [FieldValueIssue("error", "日期必须使用有效的 YYYY-MM-DD 格式")]
        return parsed.isoformat(), []
    if system_key in {"block_number", "experiment_number"}:
        return value, []

    return value, _typed_value_issues(field, value)


def validate_default_value(
    field: FieldDefinition,
    raw_value: object,
) -> tuple[str | None, list[FieldValueIssue]]:
    """Normalize a configured default without treating an unset default as required input."""
    if raw_value is None or not str(raw_value).strip():
        return None, []
    value = str(raw_value).strip()
    issues = _typed_value_issues(field, value)
    if field.data_type == "date" and not issues:
        # 形态已由 _STRICT_ISO_DATE 保证，这里仅做归一化。
        value = date.fromisoformat(value).isoformat()
    return value, issues


def new_record_field_value(field: FieldDefinition, values: dict[str, str]) -> object:
    """Respect an explicitly supplied value and otherwise use the field default."""
    if field.id in values:
        return values[field.id]
    return field.default_value or ""
