from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.models import ProjectRecord
from app.schemas import RecordOperationApply, RecordOperationSnapshot
from app.services.records import replace_record_values, require_project


def _normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def snapshot_record(record: ProjectRecord) -> dict:
    return {
        "id": record.id,
        "project_id": record.project_id,
        "pathology_number": record.pathology_number,
        "status": record.status,
        "experiment_date": record.experiment_date,
        "experiment_number": record.experiment_number,
        "report_generated": record.report_generated,
        "locked": record.locked,
        "highlight_color": record.highlight_color,
        "cell_highlight_colors": dict(record.cell_highlight_colors or {}),
        "values": {value.field_id: value.value_text for value in record.values},
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


def _snapshot_matches(record: ProjectRecord, snapshot: RecordOperationSnapshot) -> bool:
    if record.id != snapshot.id:
        return False
    if record.project_id != snapshot.project_id:
        return False
    if record.pathology_number != snapshot.pathology_number:
        return False
    if record.status != snapshot.status:
        return False
    if record.experiment_date != snapshot.experiment_date:
        return False
    if record.experiment_number != snapshot.experiment_number:
        return False
    if record.report_generated != snapshot.report_generated:
        return False
    if record.locked != snapshot.locked:
        return False
    if record.highlight_color != snapshot.highlight_color:
        return False
    if dict(record.cell_highlight_colors or {}) != snapshot.cell_highlight_colors:
        return False
    if {value.field_id: value.value_text for value in record.values} != snapshot.values:
        return False
    if snapshot.created_at is not None and _normalize_datetime(record.created_at) != _normalize_datetime(
        snapshot.created_at
    ):
        return False
    if snapshot.updated_at is not None and _normalize_datetime(record.updated_at) != _normalize_datetime(
        snapshot.updated_at
    ):
        return False
    return True


def _apply_snapshot(
    session: Session,
    record: ProjectRecord,
    snapshot: RecordOperationSnapshot,
) -> None:
    record.project_id = snapshot.project_id
    record.pathology_number = snapshot.pathology_number
    record.status = snapshot.status
    record.experiment_date = snapshot.experiment_date
    record.experiment_number = snapshot.experiment_number
    record.report_generated = snapshot.report_generated
    record.locked = snapshot.locked
    record.highlight_color = snapshot.highlight_color
    record.cell_highlight_colors = dict(snapshot.cell_highlight_colors)
    if snapshot.created_at is not None:
        record.created_at = snapshot.created_at
    if snapshot.updated_at is not None:
        record.updated_at = snapshot.updated_at
    # `replace_record_values` is intentionally a partial update helper for
    # ordinary PATCH requests.  A snapshot is complete, so clear fields that
    # are absent from it as well; otherwise an undo could leave a value added
    # by the forward operation behind.
    existing_field_ids = {value.field_id for value in record.values}
    replacement = {field_id: "" for field_id in existing_field_ids}
    replacement.update(snapshot.values)
    replace_record_values(session, record, replacement)


def _create_from_snapshot(
    session: Session,
    snapshot: RecordOperationSnapshot,
) -> ProjectRecord:
    record = ProjectRecord(
        id=snapshot.id,
        project_id=snapshot.project_id,
        pathology_number=snapshot.pathology_number,
        status=snapshot.status,
        experiment_date=snapshot.experiment_date,
        experiment_number=snapshot.experiment_number,
        report_generated=snapshot.report_generated,
        locked=snapshot.locked,
        highlight_color=snapshot.highlight_color,
        cell_highlight_colors=dict(snapshot.cell_highlight_colors),
    )
    if snapshot.created_at is not None:
        record.created_at = snapshot.created_at
    if snapshot.updated_at is not None:
        record.updated_at = snapshot.updated_at
    session.add(record)
    session.flush()
    replace_record_values(session, record, snapshot.values)
    return record


def apply_record_operation(
    session: Session,
    payload: RecordOperationApply,
) -> tuple[list[ProjectRecord], list[str]]:
    require_project(session, payload.project_id)
    before = {record.id: record for record in payload.before}
    after = {record.id: record for record in payload.after}
    all_ids = list(dict.fromkeys([*before.keys(), *after.keys()]))
    current = {
        record.id: record
        for record in session.scalars(
            select(ProjectRecord)
            .where(ProjectRecord.id.in_(all_ids))
            .options(selectinload(ProjectRecord.project), selectinload(ProjectRecord.values))
        )
    }

    expected = after if payload.direction == "undo" else before
    target = before if payload.direction == "undo" else after
    for record_id in all_ids:
        current_record = current.get(record_id)
        expected_snapshot = expected.get(record_id)
        if expected_snapshot is None:
            if current_record is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="台账数据已发生变化，无法撤销或恢复",
                )
        elif current_record is None or not _snapshot_matches(current_record, expected_snapshot):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="台账数据已发生变化，无法撤销或恢复",
            )

    deleted_ids: list[str] = []
    try:
        for record_id in all_ids:
            current_record = current.get(record_id)
            target_snapshot = target.get(record_id)
            if target_snapshot is None:
                if current_record is not None:
                    session.delete(current_record)
                    deleted_ids.append(record_id)
                continue
            if current_record is None:
                current[record_id] = _create_from_snapshot(session, target_snapshot)
            else:
                _apply_snapshot(session, current_record, target_snapshot)
        session.flush()
        audit(
            session,
            f"record.{payload.direction}",
            "record_operation",
            payload.operation_id,
            {
                "project_id": payload.project_id,
                "record_ids": all_ids,
                "direction": payload.direction,
            },
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="撤销或恢复与当前数据冲突，请刷新后重试",
        ) from error

    existing = {
        record.id: record
        for record in session.scalars(
            select(ProjectRecord)
            .where(ProjectRecord.id.in_(all_ids))
            .options(selectinload(ProjectRecord.project), selectinload(ProjectRecord.values))
        )
    }
    return [existing[record_id] for record_id in all_ids if record_id in existing], deleted_ids
