from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import ProjectRecord, RecordValue
from app.schemas import (
    BulkDeleteExecute,
    BulkDeleteFilter,
    BulkDeletePreviewRead,
    BulkDeleteResult,
    RecordAssignProject,
    RecordCreate,
    RecordExperimentNumberBatch,
    RecordList,
    RecordLockUpdate,
    RecordRead,
    RecordReportStatusUpdate,
    RecordUpdate,
)
from app.services.records import (
    assign_record_to_project,
    replace_record_values,
    require_project,
    require_record,
)
from app.services.serializers import record_dict
from app.timezones import ASIA_SHANGHAI

router = APIRouter(prefix="/records", tags=["台账记录"])


def record_load_options() -> tuple:
    return (
        selectinload(ProjectRecord.project),
        selectinload(ProjectRecord.values),
    )


def record_filters(
    *,
    project_id: str | None = None,
    record_status: str | None = None,
    search: str | None = None,
    experiment_date: date | None = None,
    report_generated: bool | None = None,
) -> list:
    filters = []
    if project_id:
        filters.append(ProjectRecord.project_id == project_id)
    if record_status:
        filters.append(ProjectRecord.status == record_status)
    if experiment_date:
        filters.append(ProjectRecord.experiment_date == experiment_date)
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
                ProjectRecord.pathology_number.like(term),
                ProjectRecord.experiment_number.like(term),
                value_match,
            )
        )
    return filters


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
    filters = record_filters(
        project_id=project_id,
        record_status=record_status,
        search=search,
        experiment_date=experiment_date,
        report_generated=report_generated,
    )
    base = select(ProjectRecord).where(*filters)
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


@router.post("/experiment-numbers", response_model=list[RecordRead])
def assign_experiment_numbers(
    payload: RecordExperimentNumberBatch,
    session: Session = Depends(get_session),
) -> list[dict]:
    record_ids = list(dict.fromkeys(payload.record_ids))
    records = list(
        session.scalars(
            select(ProjectRecord)
            .where(ProjectRecord.id.in_(record_ids))
            .options(*record_load_options())
        )
    )
    by_id = {record.id: record for record in records}
    missing = [record_id for record_id in record_ids if record_id not in by_id]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"部分台账记录不存在：{', '.join(missing)}",
        )
    ordered = [by_id[record_id] for record_id in record_ids]
    locked = [record.pathology_number for record in ordered if record.locked]
    if locked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"记录已锁定，请先解锁：{', '.join(locked[:20])}",
        )
    not_pending = [record.pathology_number for record in ordered if record.status != "待实验"]
    if not_pending:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"只有“待实验”记录可以编号：{', '.join(not_pending[:20])}",
        )
    numbers = [f"{payload.prefix}-{index}" for index in range(1, len(ordered) + 1)]
    conflicts = list(
        session.scalars(
            select(ProjectRecord)
            .where(
                ProjectRecord.experiment_number.in_(numbers),
                ~ProjectRecord.id.in_(record_ids),
            )
        )
    )
    if conflicts:
        conflict_numbers = sorted(
            {record.experiment_number for record in conflicts if record.experiment_number}
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"实验编号已存在：{', '.join(conflict_numbers)}",
        )
    before = {record.id: record.experiment_number for record in ordered}
    for record in ordered:
        record.experiment_number = None
    session.flush()
    for record, number in zip(ordered, numbers, strict=True):
        record.experiment_number = number
        audit(
            session,
            "record.experiment_number.update",
            "project_record",
            record.id,
            {"before": before[record.id], "after": number, "source": "experiment_numbering"},
        )
    session.commit()
    return [record_dict(require_record(session, record.id, include_values=True)) for record in ordered]


@router.get("/{record_id}", response_model=RecordRead)
def get_record(record_id: str, session: Session = Depends(get_session)) -> dict:
    return record_dict(require_record(session, record_id, include_values=True))


@router.post("", response_model=RecordRead, status_code=status.HTTP_201_CREATED)
def create_record(payload: RecordCreate, session: Session = Depends(get_session)) -> dict:
    require_project(session, payload.project_id)
    if payload.experiment_number:
        existing = session.scalar(
            select(ProjectRecord).where(ProjectRecord.experiment_number == payload.experiment_number)
        )
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="实验编号已存在")
    record = ProjectRecord(
        project_id=payload.project_id,
        pathology_number=payload.pathology_number,
        status=payload.status,
        experiment_date=payload.experiment_date,
        experiment_number=payload.experiment_number,
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
            "pathology_number": record.pathology_number,
            "status": record.status,
            "experiment_number": record.experiment_number,
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
        "pathology_number": record.pathology_number,
        "status": record.status,
        "experiment_date": record.experiment_date.isoformat() if record.experiment_date else None,
        "experiment_number": record.experiment_number,
    }
    if payload.pathology_number is not None:
        record.pathology_number = payload.pathology_number
    if payload.status is not None:
        record.status = payload.status
    if "experiment_date" in payload.model_fields_set:
        record.experiment_date = payload.experiment_date
    if "experiment_number" in payload.model_fields_set:
        existing = session.scalar(
            select(ProjectRecord).where(
                ProjectRecord.experiment_number == payload.experiment_number,
                ProjectRecord.id != record.id,
            )
        ) if payload.experiment_number else None
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="实验编号已存在")
        record.experiment_number = payload.experiment_number or None
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
                "pathology_number": record.pathology_number,
                "status": record.status,
                "experiment_date": (
                    record.experiment_date.isoformat() if record.experiment_date else None
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
    locked = [record.pathology_number for record in records if record.locked]
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
                "pathology_number": record.pathology_number,
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
    target = assign_record_to_project(session, source, payload.target_project_id)
    audit(
        session,
        "record.assign_project",
        "project_record",
        target.id,
        {
            "source_record_id": source.id,
            "target_project_id": payload.target_project_id,
        },
    )
    session.commit()
    return record_dict(require_record(session, target.id, include_values=True))


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_record(record_id: str, session: Session = Depends(get_session)) -> Response:
    record = require_record(session, record_id)
    if record.locked:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="记录已锁定，不能删除")
    audit(
        session,
        "record.delete",
        "project_record",
        record.id,
        {"project_id": record.project_id, "pathology_number": record.pathology_number},
    )
    session.delete(record)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def bulk_delete_conditions(payload: BulkDeleteFilter) -> list:
    conditions = [ProjectRecord.project_id == payload.project_id]
    if payload.date_field == "experiment_date":
        conditions.extend(
            [
                ProjectRecord.experiment_date >= payload.start_date,
                ProjectRecord.experiment_date <= payload.end_date,
            ]
        )
    else:
        start_at = datetime.combine(
            payload.start_date, time.min, tzinfo=ASIA_SHANGHAI
        ).astimezone(UTC)
        end_at = (
            datetime.combine(payload.end_date, time.min, tzinfo=ASIA_SHANGHAI) + timedelta(days=1)
        ).astimezone(UTC)
        column = (
            ProjectRecord.created_at
            if payload.date_field == "created_at"
            else ProjectRecord.updated_at
        )
        conditions.extend([column >= start_at, column < end_at])
    return conditions


def bulk_delete_records(session: Session, payload: BulkDeleteFilter) -> list[ProjectRecord]:
    return list(
        session.scalars(
            select(ProjectRecord)
            .where(*bulk_delete_conditions(payload))
            .order_by(ProjectRecord.created_at, ProjectRecord.id)
        )
    )


@router.post("/bulk-delete/preview", response_model=BulkDeletePreviewRead)
def preview_bulk_delete(
    payload: BulkDeleteFilter,
    session: Session = Depends(get_session),
) -> dict:
    require_project(session, payload.project_id)
    records = bulk_delete_records(session, payload)
    if len(records) > 10000:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="一次最多批量删除 10000 条记录，请缩小日期范围",
        )
    return {
        "total": len(records),
        "locked_count": sum(record.locked for record in records),
        "record_ids": [record.id for record in records],
        "items": [
            {
                "id": record.id,
                "pathology_number": record.pathology_number,
                "status": record.status,
                "experiment_date": record.experiment_date,
                "created_at": record.created_at,
                "updated_at": record.updated_at,
                "locked": record.locked,
            }
            for record in records[:200]
        ],
    }


@router.post("/bulk-delete/execute", response_model=BulkDeleteResult)
def execute_bulk_delete(
    payload: BulkDeleteExecute,
    session: Session = Depends(get_session),
) -> dict:
    require_project(session, payload.filter.project_id)
    records = bulk_delete_records(session, payload.filter)
    actual_ids = [record.id for record in records]
    if set(actual_ids) != set(payload.expected_record_ids) or len(actual_ids) != len(
        payload.expected_record_ids
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="待删除记录已发生变化，请重新预览后再删除",
        )
    locked = [record.pathology_number for record in records if record.locked]
    if locked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"包含锁定记录，请先解锁：{', '.join(locked[:20])}",
        )
    for record in records:
        audit(
            session,
            "record.delete",
            "project_record",
            record.id,
            {
                "project_id": record.project_id,
                "pathology_number": record.pathology_number,
                "bulk": True,
            },
        )
        session.delete(record)
    audit(
        session,
        "record.bulk_delete",
        "project",
        payload.filter.project_id,
        {
            "date_field": payload.filter.date_field,
            "start_date": payload.filter.start_date.isoformat(),
            "end_date": payload.filter.end_date.isoformat(),
            "record_ids": actual_ids,
        },
    )
    session.commit()
    return {"deleted": len(records)}
