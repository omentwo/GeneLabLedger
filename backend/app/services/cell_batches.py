from __future__ import annotations

import threading
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.models import FieldDefinition, ProjectRecord, RecordValue
from app.schemas import RecordBatchNewRecord, RecordCellChange
from app.services.field_validation import FieldValueIssue, validate_field_value
from app.services.record_operations import snapshot_record
from app.services.serializers import record_dict

PREVIEW_TTL = timedelta(minutes=10)


@dataclass(frozen=True)
class StoredCellChange:
    record_id: str
    field_id: str
    value: str
    expected_value: str


@dataclass(frozen=True)
class StoredNewRecord:
    client_id: str
    pathology_number: str
    status: str
    experiment_date: str
    experiment_number: str
    values: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class StoredCellBatch:
    token: str
    project_id: str
    changes: tuple[StoredCellChange, ...]
    new_records: tuple[StoredNewRecord, ...]
    issues: tuple[dict[str, str], ...]
    skipped_locked: int
    source: str
    expires_at: datetime


_preview_lock = threading.Lock()
_previews: dict[str, StoredCellBatch] = {}


def _cleanup_previews(now: datetime) -> None:
    for token, preview in list(_previews.items()):
        if preview.expires_at <= now:
            _previews.pop(token, None)


def _field_and_record_maps(
    session: Session,
    project_id: str,
    changes: list[RecordCellChange],
) -> tuple[dict[str, ProjectRecord], dict[str, FieldDefinition]]:
    record_ids = {change.record_id for change in changes}
    field_ids = {change.field_id for change in changes}
    records = {
        record.id: record
        for record in session.scalars(
            select(ProjectRecord)
            .where(ProjectRecord.id.in_(record_ids))
            .options(
                selectinload(ProjectRecord.project),
                selectinload(ProjectRecord.values),
            )
        )
    }
    fields = {
        field.id: field
        for field in session.scalars(
            select(FieldDefinition)
            .where(FieldDefinition.id.in_(field_ids))
            .options(selectinload(FieldDefinition.options))
        )
    }
    for record_id in record_ids:
        record = records.get(record_id)
        if not record:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="部分台账记录不存在")
        if record.project_id != project_id:
            raise HTTPException(status_code=422, detail="记录不属于当前项目")
    for field_id in field_ids:
        field = fields.get(field_id)
        if not field:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="部分表头不存在")
        if field.project_id != project_id:
            raise HTTPException(status_code=422, detail="表头不属于当前项目")
    return records, fields


def current_cell_value(record: ProjectRecord, field: FieldDefinition) -> str:
    if field.system_key == "pathology_number":
        return record.pathology_number
    if field.system_key == "status":
        return record.status
    if field.system_key == "experiment_date":
        return record.experiment_date.isoformat() if record.experiment_date else ""
    if field.system_key == "experiment_number":
        return record.experiment_number or ""
    return next(
        (value.value_text for value in record.values if value.field_id == field.id),
        "",
    )


def _issue_dict(
    change: RecordCellChange,
    issue: FieldValueIssue,
) -> dict[str, str]:
    return {
        "record_id": change.record_id,
        "field_id": change.field_id,
        "severity": issue.severity,
        "message": issue.message,
    }


def _new_issue_dict(
    client_id: str,
    field: FieldDefinition,
    issue: FieldValueIssue,
) -> dict[str, str]:
    return {
        "record_id": client_id,
        "field_id": field.id,
        "severity": issue.severity,
        "message": issue.message,
    }


def _validate_new_records(
    session: Session,
    project_id: str,
    new_records: list[RecordBatchNewRecord],
) -> tuple[list[StoredNewRecord], list[dict[str, str]]]:
    if not new_records:
        return [], []
    fields = list(
        session.scalars(
            select(FieldDefinition)
            .where(FieldDefinition.project_id == project_id)
            .options(selectinload(FieldDefinition.options))
        )
    )
    by_id = {field.id: field for field in fields}
    core_by_key = {field.system_key: field for field in fields if field.is_core and field.system_key}
    unknown_ids = {
        field_id
        for record in new_records
        for field_id in record.values
        if field_id not in by_id or by_id[field_id].is_core
    }
    if unknown_ids:
        raise HTTPException(status_code=422, detail="新增记录包含不属于当前项目的自定义表头")

    numbers = [record.experiment_number for record in new_records if record.experiment_number]
    duplicate_numbers = {
        number for number, count in Counter(numbers).items() if count > 1
    }
    existing_numbers = set(
        session.scalars(
            select(ProjectRecord.experiment_number).where(
                ProjectRecord.project_id == project_id,
                ProjectRecord.experiment_number.in_(numbers),
            )
        )
    ) if numbers else set()
    stored: list[StoredNewRecord] = []
    issues: list[dict[str, str]] = []
    for row in new_records:
        raw_core = {
            "pathology_number": row.pathology_number,
            "status": row.status,
            "experiment_date": row.experiment_date.isoformat() if row.experiment_date else "",
            "experiment_number": row.experiment_number or "",
        }
        normalized_core: dict[str, str] = {}
        for system_key, raw_value in raw_core.items():
            field = core_by_key.get(system_key)
            if not field:
                raise HTTPException(status_code=422, detail=f"核心表头不存在：{system_key}")
            value, field_issues = validate_field_value(field, raw_value)
            normalized_core[system_key] = value
            issues.extend(_new_issue_dict(row.client_id, field, issue) for issue in field_issues)
        number_field = core_by_key.get("experiment_number")
        if number_field and normalized_core["experiment_number"] in duplicate_numbers | existing_numbers:
            issues.append(
                {
                    "record_id": row.client_id,
                    "field_id": number_field.id,
                    "severity": "error",
                    "message": "实验编号已存在",
                }
            )
        normalized_values: list[tuple[str, str]] = []
        for field in fields:
            if field.is_core:
                continue
            value, field_issues = validate_field_value(field, row.values.get(field.id, ""))
            normalized_values.append((field.id, value))
            issues.extend(_new_issue_dict(row.client_id, field, issue) for issue in field_issues)
        stored.append(
            StoredNewRecord(
                client_id=row.client_id,
                pathology_number=normalized_core["pathology_number"],
                status=normalized_core["status"],
                experiment_date=normalized_core["experiment_date"],
                experiment_number=normalized_core["experiment_number"],
                values=tuple(normalized_values),
            )
        )
    return stored, issues


def preview_cell_changes(
    session: Session,
    *,
    project_id: str,
    changes: list[RecordCellChange],
    new_records: list[RecordBatchNewRecord] | None = None,
    source: str = "cell_batch",
) -> StoredCellBatch:
    deduplicated: dict[tuple[str, str], RecordCellChange] = {}
    for change in changes:
        deduplicated[(change.record_id, change.field_id)] = change
    ordered = list(deduplicated.values())
    records, fields = _field_and_record_maps(session, project_id, ordered)
    stored: list[StoredCellChange] = []
    issues: list[dict[str, str]] = []
    skipped_locked = 0
    for change in ordered:
        record = records[change.record_id]
        field = fields[change.field_id]
        current = current_cell_value(record, field)
        if record.locked:
            skipped_locked += 1
            continue
        normalized, field_issues = validate_field_value(field, change.value)
        issues.extend(_issue_dict(change, issue) for issue in field_issues)
        if change.expected_value is not None and change.expected_value != current:
            issues.append(
                {
                    "record_id": change.record_id,
                    "field_id": change.field_id,
                    "severity": "error",
                    "message": "单元格内容已变化，请刷新后重试",
                }
            )
        stored.append(
            StoredCellChange(
                record_id=change.record_id,
                field_id=change.field_id,
                value=normalized,
                expected_value=current,
            )
        )
    stored_new_records, new_issues = _validate_new_records(
        session,
        project_id,
        new_records or [],
    )
    issues.extend(new_issues)
    now = datetime.now(UTC)
    preview = StoredCellBatch(
        token=uuid.uuid4().hex,
        project_id=project_id,
        changes=tuple(stored),
        new_records=tuple(stored_new_records),
        issues=tuple(issues),
        skipped_locked=skipped_locked,
        source=source,
        expires_at=now + PREVIEW_TTL,
    )
    with _preview_lock:
        _cleanup_previews(now)
        _previews[preview.token] = preview
    return preview


def preview_dict(preview: StoredCellBatch) -> dict:
    return {
        "token": preview.token,
        "affected_count": len(preview.changes) + len(preview.new_records),
        "skipped_locked": preview.skipped_locked,
        "issues": list(preview.issues),
        "expires_at": preview.expires_at,
    }


def _apply_core_value(record: ProjectRecord, field: FieldDefinition, value: str) -> None:
    if field.system_key == "pathology_number":
        record.pathology_number = value
    elif field.system_key == "status":
        record.status = value
    elif field.system_key == "experiment_date":
        record.experiment_date = date.fromisoformat(value) if value else None
    elif field.system_key == "experiment_number":
        record.experiment_number = value or None


def _apply_custom_values(
    session: Session,
    record: ProjectRecord,
    values: dict[str, str],
) -> None:
    existing = {value.field_id: value for value in record.values}
    for field_id, text in values.items():
        row = existing.get(field_id)
        if not text:
            if row is not None:
                session.delete(row)
                record.values.remove(row)
            continue
        if row is None:
            row = RecordValue(record_id=record.id, field_id=field_id, value_text=text)
            session.add(row)
            record.values.append(row)
        else:
            row.value_text = text


def commit_cell_batch(
    session: Session,
    *,
    token: str,
    accept_warnings: bool,
    include_snapshots: bool = False,
) -> dict:
    now = datetime.now(UTC)
    with _preview_lock:
        _cleanup_previews(now)
        preview = _previews.get(token)
    if not preview:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="预检查已过期，请重新预览")
    if any(issue["severity"] == "error" for issue in preview.issues):
        raise HTTPException(status_code=422, detail="存在严格验证错误，不能提交")
    if not accept_warnings and any(issue["severity"] == "warning" for issue in preview.issues):
        raise HTTPException(status_code=409, detail="存在警告，请确认后继续")

    payload_changes = [
        RecordCellChange(
            record_id=change.record_id,
            field_id=change.field_id,
            value=change.value,
            expected_value=change.expected_value,
        )
        for change in preview.changes
    ]
    records, fields = _field_and_record_maps(session, preview.project_id, payload_changes)
    skipped_locked = preview.skipped_locked
    applicable: list[StoredCellChange] = []
    fresh_issues: list[dict[str, str]] = []
    for change in preview.changes:
        record = records[change.record_id]
        field = fields[change.field_id]
        if record.locked:
            skipped_locked += 1
            continue
        current = current_cell_value(record, field)
        if current != change.expected_value:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="预览后数据已发生变化，请重新预览",
            )
        normalized, issues = validate_field_value(field, change.value)
        fresh_issues.extend(
            {
                "record_id": change.record_id,
                "field_id": change.field_id,
                "severity": issue.severity,
                "message": issue.message,
            }
            for issue in issues
        )
        applicable.append(
            StoredCellChange(
                record_id=change.record_id,
                field_id=change.field_id,
                value=normalized,
                expected_value=current,
            )
        )
    if any(issue["severity"] == "error" for issue in fresh_issues):
        raise HTTPException(status_code=422, detail="验证规则已变化，请重新预览")
    if not accept_warnings and any(issue["severity"] == "warning" for issue in fresh_issues):
        raise HTTPException(status_code=409, detail="验证规则产生警告，请确认后继续")

    fresh_new_rows = [
        RecordBatchNewRecord(
            client_id=row.client_id,
            pathology_number=row.pathology_number,
            status=row.status,
            experiment_date=date.fromisoformat(row.experiment_date) if row.experiment_date else None,
            experiment_number=row.experiment_number or None,
            values=dict(row.values),
        )
        for row in preview.new_records
    ]
    normalized_new_rows, fresh_new_issues = _validate_new_records(
        session,
        preview.project_id,
        fresh_new_rows,
    )
    if any(issue["severity"] == "error" for issue in fresh_new_issues):
        raise HTTPException(status_code=422, detail="新增记录验证失败，请重新预览")
    if not accept_warnings and any(issue["severity"] == "warning" for issue in fresh_new_issues):
        raise HTTPException(status_code=409, detail="新增记录存在警告，请确认后继续")

    affected_record_ids = list(dict.fromkeys(change.record_id for change in applicable))
    before = (
        [snapshot_record(records[record_id]) for record_id in affected_record_ids]
        if include_snapshots
        else []
    )
    custom_by_record: dict[str, dict[str, str]] = {}
    details: list[dict[str, str]] = []
    created_records: list[ProjectRecord] = []
    try:
        for change in applicable:
            record = records[change.record_id]
            field = fields[change.field_id]
            if field.is_core:
                _apply_core_value(record, field, change.value)
            else:
                custom_by_record.setdefault(record.id, {})[field.id] = change.value
            details.append(
                {
                    "record_id": record.id,
                    "field_id": field.id,
                    "before": change.expected_value,
                    "after": change.value,
                }
            )
        for record_id, values in custom_by_record.items():
            _apply_custom_values(session, records[record_id], values)
        for row in normalized_new_rows:
            created = ProjectRecord(
                project_id=preview.project_id,
                pathology_number=row.pathology_number,
                status=row.status,
                experiment_date=date.fromisoformat(row.experiment_date) if row.experiment_date else None,
                experiment_number=row.experiment_number or None,
            )
            session.add(created)
            session.flush()
            _apply_custom_values(session, created, dict(row.values))
            created_records.append(created)
        session.flush()
        audit(
            session,
            f"record.{preview.source}.commit",
            "record_cell_batch",
            preview.token,
            {
                "project_id": preview.project_id,
                "changes": details,
                "created_record_ids": [record.id for record in created_records],
                "skipped_locked": skipped_locked,
            },
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="实验编号与现有记录冲突，请刷新后重试",
        ) from error

    all_record_ids = [*affected_record_ids, *(record.id for record in created_records)]
    refreshed = list(
        session.scalars(
            select(ProjectRecord)
            .where(ProjectRecord.id.in_(all_record_ids))
            .options(
                selectinload(ProjectRecord.project),
                selectinload(ProjectRecord.values),
            )
        )
    )
    refreshed_by_id = {record.id: record for record in refreshed}
    after = (
        [snapshot_record(refreshed_by_id[record_id]) for record_id in all_record_ids]
        if include_snapshots
        else []
    )
    with _preview_lock:
        _previews.pop(token, None)
    return {
        "records": [record_dict(refreshed_by_id[record_id]) for record_id in all_record_ids],
        "skipped_locked": skipped_locked,
        "changes": details,
        "created_record_ids": [record.id for record in created_records],
        "before": before,
        "after": after,
    }
