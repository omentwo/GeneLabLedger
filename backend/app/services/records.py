from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    FieldDefinition,
    Project,
    ProjectRecord,
    RecordValue,
)


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


def validate_record_values(
    session: Session,
    project_id: str,
    values: dict[str, str],
) -> dict[str, str]:
    if not values:
        return {}
    fields = list(
        session.scalars(
            select(FieldDefinition).where(
                FieldDefinition.id.in_(values.keys()),
                FieldDefinition.project_id == project_id,
            )
        )
    )
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
    return {field_id: str(value).strip() for field_id, value in values.items()}


def replace_record_values(
    session: Session,
    record: ProjectRecord,
    values: dict[str, str],
) -> None:
    validated = validate_record_values(session, record.project_id, values)
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
        pathology_number=source_record.pathology_number,
        status="待实验",
    )
    session.add(target)
    session.flush()
    return target
