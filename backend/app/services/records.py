from __future__ import annotations

from datetime import date

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    Case,
    ExperimentBatch,
    ExperimentRun,
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
        .options(
            selectinload(ProjectRecord.case),
            selectinload(ProjectRecord.project),
        )
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


def get_or_create_case(session: Session, pathology_number: str) -> Case:
    case = session.scalar(select(Case).where(Case.pathology_number == pathology_number))
    if case:
        return case
    case = Case(pathology_number=pathology_number)
    session.add(case)
    session.flush()
    return case


def assign_case_to_project(
    session: Session,
    source_record: ProjectRecord,
    target_project_id: str,
) -> tuple[ProjectRecord, bool]:
    require_project(session, target_project_id)
    existing = session.scalar(
        select(ProjectRecord).where(
            ProjectRecord.case_id == source_record.case_id,
            ProjectRecord.project_id == target_project_id,
        )
    )
    if existing:
        return existing, False
    target = ProjectRecord(
        case_id=source_record.case_id,
        project_id=target_project_id,
        status="待实验",
    )
    session.add(target)
    session.flush()
    return target, True


def batch_for_date(session: Session, experiment_date: date) -> ExperimentBatch:
    batch = session.scalar(select(ExperimentBatch).where(ExperimentBatch.experiment_date == experiment_date))
    if batch:
        return batch
    batch = ExperimentBatch(experiment_date=experiment_date)
    session.add(batch)
    session.flush()
    return batch


def experiment_number_for(experiment_date: date, position: int) -> str:
    return f"{experiment_date:%Y%m%d}-{position:02d}"


def renumber_batch(session: Session, batch: ExperimentBatch) -> None:
    runs = list(
        session.scalars(
            select(ExperimentRun)
            .where(ExperimentRun.batch_id == batch.id)
            .order_by(ExperimentRun.position, ExperimentRun.created_at, ExperimentRun.id)
        )
    )
    # Avoid unique collisions while swapping existing positions/numbers.
    for index, run in enumerate(runs, start=1):
        run.position = 100000 + index
        run.experiment_number = f"tmp-{run.id}"
    session.flush()
    for index, run in enumerate(runs, start=1):
        run.position = index
        run.experiment_number = experiment_number_for(batch.experiment_date, index)


def create_experiment_run(
    session: Session,
    record: ProjectRecord,
    experiment_date: date,
    *,
    allow_repeat: bool,
) -> ExperimentRun:
    batch = batch_for_date(session, experiment_date)
    existing_for_day = list(
        session.scalars(
            select(ExperimentRun).where(
                ExperimentRun.batch_id == batch.id,
                ExperimentRun.record_id == record.id,
            )
        )
    )
    if existing_for_day and not allow_repeat:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该项目记录已在当天实验编排中；如需重复实验，请使用重复实验操作",
        )
    last_position = (
        session.scalar(
            select(ExperimentRun.position)
            .where(ExperimentRun.batch_id == batch.id)
            .order_by(ExperimentRun.position.desc())
            .limit(1)
        )
        or 0
    )
    position = last_position + 1
    run = ExperimentRun(
        batch_id=batch.id,
        record_id=record.id,
        position=position,
        experiment_number=experiment_number_for(experiment_date, position),
        is_repeat=allow_repeat or bool(record.experiment_runs),
    )
    record.current_experiment_date = experiment_date
    session.add(run)
    session.flush()
    return run


def move_latest_experiment_date(
    session: Session,
    record: ProjectRecord,
    new_date: date | None,
) -> None:
    record.current_experiment_date = new_date
    latest = session.scalar(
        select(ExperimentRun)
        .where(ExperimentRun.record_id == record.id)
        .order_by(ExperimentRun.created_at.desc(), ExperimentRun.id.desc())
        .limit(1)
    )
    if not latest or new_date is None or latest.batch.experiment_date == new_date:
        return

    old_batch = latest.batch
    target_batch = batch_for_date(session, new_date)
    last_position = (
        session.scalar(
            select(ExperimentRun.position)
            .where(ExperimentRun.batch_id == target_batch.id)
            .order_by(ExperimentRun.position.desc())
            .limit(1)
        )
        or 0
    )
    latest.batch_id = target_batch.id
    latest.position = last_position + 1
    latest.experiment_number = f"tmp-{latest.id}"
    session.flush()
    renumber_batch(session, old_batch)
    renumber_batch(session, target_batch)


def delete_orphan_case(session: Session, case_id: str) -> None:
    remaining = session.scalar(select(ProjectRecord.id).where(ProjectRecord.case_id == case_id).limit(1))
    if not remaining:
        session.execute(delete(Case).where(Case.id == case_id))
