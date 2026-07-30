from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import Case, ProjectRecord, RecordValue
from app.schemas import (
    ExperimentRunRead,
    RecordAssignProject,
    RecordCreate,
    RecordList,
    RecordLockUpdate,
    RecordRead,
    RecordRepeat,
    RecordReportStatusUpdate,
    RecordUpdate,
)
from app.services.records import (
    assign_case_to_project,
    create_experiment_run,
    delete_orphan_case,
    get_or_create_case,
    move_latest_experiment_date,
    replace_record_values,
    require_project,
    require_record,
)
from app.services.serializers import experiment_run_dict, record_dict

router = APIRouter(prefix="/records", tags=["台账记录"])


def record_load_options() -> tuple:
    return (
        selectinload(ProjectRecord.case),
        selectinload(ProjectRecord.project),
        selectinload(ProjectRecord.values),
    )


@router.get("", response_model=RecordList)
def list_records(
    project_id: str | None = None,
    record_status: str | None = Query(default=None, alias="status"),
    search: str | None = None,
    experiment_date: date | None = None,
    report_generated: bool | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
) -> dict:
    filters = []
    if project_id:
        filters.append(ProjectRecord.project_id == project_id)
    if record_status:
        filters.append(ProjectRecord.status == record_status)
    if experiment_date:
        filters.append(ProjectRecord.current_experiment_date == experiment_date)
    if report_generated is not None:
        filters.append(ProjectRecord.report_generated == report_generated)
    if search and search.strip():
        term = f"%{search.strip()}%"
        value_match = (
            select(RecordValue.id)
            .where(
                RecordValue.record_id == ProjectRecord.id,
                RecordValue.value_text.like(term),
            )
            .exists()
        )
        filters.append(
            or_(
                Case.pathology_number.like(term),
                ProjectRecord.experiment_number.like(term),
                value_match,
            )
        )

    base = select(ProjectRecord).join(ProjectRecord.case).where(*filters)
    total = session.scalar(select(func.count()).select_from(base.subquery())) or 0
    records = list(
        session.scalars(
            base.options(*record_load_options())
            .order_by(ProjectRecord.created_at.asc(), ProjectRecord.id.asc())
            .offset(offset)
            .limit(limit)
        )
    )
    return {
        "items": [record_dict(record) for record in records],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/{record_id}", response_model=RecordRead)
def get_record(record_id: str, session: Session = Depends(get_session)) -> dict:
    return record_dict(require_record(session, record_id, include_values=True))


@router.post("", response_model=RecordRead, status_code=status.HTTP_201_CREATED)
def create_record(payload: RecordCreate, session: Session = Depends(get_session)) -> dict:
    require_project(session, payload.project_id)
    case = get_or_create_case(session, payload.pathology_number)
    existing = session.scalar(
        select(ProjectRecord).where(
            ProjectRecord.case_id == case.id,
            ProjectRecord.project_id == payload.project_id,
        )
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该病理号已存在于当前项目；可直接使用原记录或创建重复实验",
        )
    record = ProjectRecord(
        case_id=case.id,
        project_id=payload.project_id,
        status=payload.status,
        current_experiment_date=payload.experiment_date,
        experiment_number=payload.experiment_number.strip() if payload.experiment_number else None,
    )
    session.add(record)
    session.flush()
    replace_record_values(session, record, payload.values)
    audit(
        session,
        "record.create",
        "project_record",
        record.id,
        {
            "project_id": record.project_id,
            "pathology_number": case.pathology_number,
            "status": record.status,
        },
    )
    session.commit()
    return record_dict(require_record(session, record.id, include_values=True))


@router.patch("/{record_id}", response_model=RecordRead)
def update_record(
    record_id: str,
    payload: RecordUpdate,
    session: Session = Depends(get_session),
) -> dict:
    record = require_record(session, record_id, include_values=True)
    if record.locked:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="记录已锁定，不能修改")
    before = {
        "pathology_number": record.case.pathology_number,
        "status": record.status,
        "experiment_date": (
            record.current_experiment_date.isoformat() if record.current_experiment_date else None
        ),
        "experiment_number": record.experiment_number,
    }
    if payload.pathology_number is not None and payload.pathology_number != record.case.pathology_number:
        duplicate = session.scalar(
            select(Case).where(
                Case.pathology_number == payload.pathology_number,
                Case.id != record.case_id,
            )
        )
        if duplicate:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="病理号在系统中已存在，不能通过编辑自动合并病例",
            )
        record.case.pathology_number = payload.pathology_number
    if payload.status is not None:
        record.status = payload.status
    if "experiment_date" in payload.model_fields_set:
        move_latest_experiment_date(session, record, payload.experiment_date)
    if "experiment_number" in payload.model_fields_set:
        record.experiment_number = (
            payload.experiment_number.strip() if payload.experiment_number else None
        )
    if payload.values is not None:
        replace_record_values(session, record, payload.values)
    audit(
        session,
        "record.update",
        "project_record",
        record.id,
        {
            "before": before,
            "after": {
                "pathology_number": record.case.pathology_number,
                "status": record.status,
                "experiment_date": (
                    record.current_experiment_date.isoformat() if record.current_experiment_date else None
                ),
                "experiment_number": record.experiment_number,
            },
        },
    )
    session.commit()
    return record_dict(require_record(session, record.id, include_values=True))


@router.put("/report-status", response_model=list[RecordRead])
def update_report_status(
    payload: RecordReportStatusUpdate,
    session: Session = Depends(get_session),
) -> list[dict]:
    unique_ids = list(dict.fromkeys(payload.record_ids))
    records = list(
        session.scalars(
            select(ProjectRecord)
            .where(ProjectRecord.id.in_(unique_ids))
            .options(*record_load_options())
        )
    )
    by_id = {record.id: record for record in records}
    missing = [record_id for record_id in unique_ids if record_id not in by_id]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"部分台账记录不存在：{', '.join(missing)}",
        )
    locked = [record.case.pathology_number for record in records if record.locked]
    if locked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"记录已锁定，请先解锁：{', '.join(locked)}",
        )
    for record in records:
        record.report_generated = payload.report_generated
        audit(
            session,
            "record.report_generated" if payload.report_generated else "record.report_reset",
            "project_record",
            record.id,
            {
                "project_id": record.project_id,
                "pathology_number": record.case.pathology_number,
            },
        )
    session.commit()
    return [
        record_dict(require_record(session, record_id, include_values=True))
        for record_id in unique_ids
    ]


@router.put("/{record_id}/lock", response_model=RecordRead)
def update_record_lock(
    record_id: str,
    payload: RecordLockUpdate,
    session: Session = Depends(get_session),
) -> dict:
    record = require_record(session, record_id, include_values=True)
    record.locked = payload.locked
    audit(
        session,
        "record.lock" if payload.locked else "record.unlock",
        "project_record",
        record.id,
    )
    session.commit()
    return record_dict(require_record(session, record.id, include_values=True))


@router.post("/{record_id}/assign-project", response_model=RecordRead)
def assign_record_project(
    record_id: str,
    payload: RecordAssignProject,
    session: Session = Depends(get_session),
) -> dict:
    source = require_record(session, record_id)
    target, created = assign_case_to_project(session, source, payload.target_project_id)
    audit(
        session,
        "record.assign_project",
        "project_record",
        target.id,
        {
            "source_record_id": source.id,
            "target_project_id": payload.target_project_id,
            "created": created,
        },
    )
    session.commit()
    return record_dict(require_record(session, target.id, include_values=True))


@router.post("/{record_id}/repeat", response_model=ExperimentRunRead)
def repeat_experiment(
    record_id: str,
    payload: RecordRepeat,
    session: Session = Depends(get_session),
) -> dict:
    record = require_record(session, record_id)
    record.status = "待实验"
    run = create_experiment_run(
        session,
        record,
        payload.experiment_date,
        allow_repeat=True,
    )
    audit(
        session,
        "experiment.repeat",
        "experiment_run",
        run.id,
        {"record_id": record.id, "experiment_date": payload.experiment_date.isoformat()},
    )
    session.commit()
    return experiment_run_dict(
        session.scalar(
            select(type(run))
            .where(type(run).id == run.id)
            .options(
                selectinload(type(run).record).selectinload(ProjectRecord.case),
                selectinload(type(run).record).selectinload(ProjectRecord.project),
            )
        )
    )


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_record(record_id: str, session: Session = Depends(get_session)) -> Response:
    record = require_record(session, record_id)
    if record.locked:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="记录已锁定，不能删除")
    case_id = record.case_id
    audit(
        session,
        "record.delete",
        "project_record",
        record.id,
        {"project_id": record.project_id, "pathology_number": record.case.pathology_number},
    )
    session.delete(record)
    session.flush()
    delete_orphan_case(session, case_id)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
