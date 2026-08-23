from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.models import (
    FieldDefinition,
    Project,
    ProjectRecord,
    RecordValue,
)
from app.services.field_validation import new_record_field_value, validate_field_value


def require_project(session: Session, project_id: str) -> Project:
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


def require_record(session: Session, record_id: str, *, include_values: bool = False) -> ProjectRecord:
    statement = (
        select(ProjectRecord)
        .where(ProjectRecord.id == record_id)
        .options(selectinload(ProjectRecord.project))
    )
    if include_values:
        statement = statement.options(
            selectinload(ProjectRecord.values),
        ).execution_options(populate_existing=True)
    record = session.scalar(statement)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="台账记录不存在")
    return record


def next_record_position(session: Session, project_id: str) -> int:
    current = session.scalar(
        select(func.max(ProjectRecord.position)).where(ProjectRecord.project_id == project_id)
    )
    return (current or 0) + 1


def allocate_record_position(
    session: Session,
    project_id: str,
    *,
    before_record_id: str | None = None,
    after_record_id: str | None = None,
) -> int:
    """Return an append or anchored position and make room inside one ledger."""
    anchor_id = before_record_id or after_record_id
    if not anchor_id:
        return next_record_position(session, project_id)

    # A previous insertion in the same transaction may already have shifted
    # this row, so bypass any stale identity-map position.
    anchor = session.get(ProjectRecord, anchor_id, populate_existing=True)
    if not anchor:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="插入位置对应的记录已不存在，请刷新后重试",
        )
    if anchor.project_id != project_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="插入位置不属于当前项目",
        )

    position = anchor.position + (1 if after_record_id else 0)
    session.execute(
        update(ProjectRecord)
        .where(
            ProjectRecord.project_id == project_id,
            ProjectRecord.position >= position,
        )
        # Moving a row to make room is not a user edit. Keep its timestamp
        # stable so older undo/redo snapshots remain valid.
        .values(
            position=ProjectRecord.position + 1,
            updated_at=ProjectRecord.updated_at,
        ),
        execution_options={"synchronize_session": False},
    )
    return position


def validate_record_values(
    session: Session,
    project_id: str,
    values: dict[str, str],
    *,
    include_required_missing: bool = False,
    apply_defaults: bool = False,
) -> dict[str, str]:
    if not values and not include_required_missing:
        return {}
    statement = (
        select(FieldDefinition)
        .where(FieldDefinition.project_id == project_id)
        .options(selectinload(FieldDefinition.options))
    )
    if include_required_missing:
        statement = statement.where(FieldDefinition.is_core.is_(False))
    else:
        statement = statement.where(FieldDefinition.id.in_(values.keys()))
    fields = list(session.scalars(statement))
    by_id = {field.id: field for field in fields}
    missing = set(values) - set(by_id)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"存在不属于当前项目的字段：{', '.join(sorted(missing))}",
        )
    core_fields = [field.label for field in fields if field.is_core]
    if core_fields:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"核心字段必须通过专用属性修改：{', '.join(core_fields)}",
        )
    normalized: dict[str, str] = {}
    errors: list[str] = []
    field_ids = list(by_id) if include_required_missing else list(values)
    for field_id in field_ids:
        field = by_id[field_id]
        raw_value = (
            new_record_field_value(field, values)
            if apply_defaults
            else values.get(field_id, "")
        )
        value, issues = validate_field_value(field, raw_value)
        normalized[field_id] = value
        errors.extend(issue.message for issue in issues if issue.severity == "error")
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="；".join(dict.fromkeys(errors)),
        )
    return normalized


def validate_core_record_values(
    session: Session,
    project_id: str,
    values: dict[str, object],
) -> dict[str, str]:
    """Validate changed core values through the same rules as cell batches."""
    if not values:
        return {}
    fields = list(
        session.scalars(
            select(FieldDefinition)
            .where(
                FieldDefinition.project_id == project_id,
                FieldDefinition.is_core.is_(True),
                FieldDefinition.system_key.in_(values.keys()),
            )
            .options(selectinload(FieldDefinition.options))
        )
    )
    by_system_key = {field.system_key: field for field in fields if field.system_key}
    missing = set(values) - set(by_system_key)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"核心表头不存在：{', '.join(sorted(missing))}",
        )
    normalized: dict[str, str] = {}
    errors: list[str] = []
    for system_key, raw_value in values.items():
        value, issues = validate_field_value(by_system_key[system_key], raw_value)
        normalized[system_key] = value
        errors.extend(issue.message for issue in issues if issue.severity == "error")
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="；".join(dict.fromkeys(errors)),
        )
    return normalized


def replace_record_values(
    session: Session,
    record: ProjectRecord,
    values: dict[str, str],
    *,
    include_required_missing: bool = False,
    apply_defaults: bool = False,
) -> None:
    validated = validate_record_values(
        session,
        record.project_id,
        values,
        include_required_missing=include_required_missing,
        apply_defaults=apply_defaults,
    )
    existing = {
        value.field_id: value
        for value in session.scalars(
            select(RecordValue).where(
                RecordValue.record_id == record.id,
                RecordValue.field_id.in_(validated.keys()),
            )
        )
    }
    for field_id, text in validated.items():
        if text == "":
            if field_id in existing:
                session.delete(existing[field_id])
            continue
        if field_id in existing:
            existing[field_id].value_text = text
        else:
            session.add(RecordValue(record_id=record.id, field_id=field_id, value_text=text))


def assign_record_to_project(
    session: Session,
    source_record: ProjectRecord,
    target_project_id: str,
) -> ProjectRecord:
    require_project(session, target_project_id)
    target = ProjectRecord(
        project_id=target_project_id,
        position=next_record_position(session, target_project_id),
        pathology_number=source_record.pathology_number,
        status="待实验",
    )
    session.add(target)
    session.flush()
    defaults = {
        field.id: field.default_value
        for field in session.scalars(
            select(FieldDefinition).where(
                FieldDefinition.project_id == target_project_id,
                FieldDefinition.is_core.is_(False),
                FieldDefinition.default_value.is_not(None),
            )
        )
        if field.default_value is not None
    }
    replace_record_values(session, target, defaults)
    return target
