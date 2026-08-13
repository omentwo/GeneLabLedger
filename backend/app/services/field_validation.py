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


def _configured_severity(field: FieldDefinition) -> IssueSeverity:
    if field.validation_mode == "strict":
        return "error"
    if field.validation_mode == "warning":
        return "warning"
    return "suggestion"


def _issue(field: FieldDefinition, message: str) -> FieldValueIssue:
    return FieldValueIssue(_configured_severity(field), message)


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
    if system_key == "experiment_number":
        return value, []

    rules = dict(field.validation_rules or {})
    issues: list[FieldValueIssue] = []
    if not value:
        if bool(rules.get("required")):
            issues.append(_issue(field, f"{field.label}不能为空"))
        return value, issues

    max_length = rules.get("max_length")
    if isinstance(max_length, int) and len(value) > max_length:
        issues.append(_issue(field, f"{field.label}最多允许 {max_length} 个字符"))

    if field.data_type == "number":
        try:
            number = Decimal(value)
        except InvalidOperation:
            issues.append(_issue(field, f"{field.label}必须是数字"))
        else:
            if not number.is_finite():
                issues.append(_issue(field, f"{field.label}必须是有限数字"))
            else:
                min_number = rules.get("min_number")
                max_number = rules.get("max_number")
                if min_number is not None and number < Decimal(str(min_number)):
                    issues.append(_issue(field, f"{field.label}不能小于 {min_number}"))
                if max_number is not None and number > Decimal(str(max_number)):
                    issues.append(_issue(field, f"{field.label}不能大于 {max_number}"))
                decimal_places = rules.get("decimal_places")
                exponent = number.as_tuple().exponent
                actual_places = max(0, -exponent) if isinstance(exponent, int) else 0
                if isinstance(decimal_places, int) and actual_places > decimal_places:
                    issues.append(_issue(field, f"{field.label}最多保留 {decimal_places} 位小数"))

    if field.data_type == "date":
        try:
            parsed_date = date.fromisoformat(value)
        except ValueError:
            issues.append(_issue(field, f"{field.label}必须使用有效的 YYYY-MM-DD 格式"))
        else:
            min_date = rules.get("min_date")
            max_date = rules.get("max_date")
            if min_date and parsed_date < date.fromisoformat(str(min_date)):
                issues.append(_issue(field, f"{field.label}不能早于 {min_date}"))
            if max_date and parsed_date > date.fromisoformat(str(max_date)):
                issues.append(_issue(field, f"{field.label}不能晚于 {max_date}"))
            value = parsed_date.isoformat()

    options = [option.value for option in field.options]
    if field.data_type == "select" and options and value not in options:
        issues.append(_issue(field, f"{field.label}未包含在备选项中"))

    return value, issues
