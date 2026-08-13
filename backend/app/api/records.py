from __future__ import annotations

import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import Float, String, and_, cast, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import FieldDefinition, Project, ProjectRecord, RecordValue
from app.schemas import (
    BulkDeleteExecute,
    BulkDeleteFilter,
    BulkDeletePreviewRead,
    BulkDeleteResult,
    RecordAssignProject,
    RecordCellBatchCommit,
    RecordCellBatchCommitRead,
    RecordCellBatchPreview,
    RecordCellBatchPreviewRead,
    RecordCellChange,
    RecordCellHighlightUpdate,
    RecordCreate,
    RecordCreateValidationRead,
    RecordExperimentNumberBatch,
    RecordHighlightUpdate,
    RecordIdList,
    RecordIdsRequest,
    RecordList,
    RecordLockUpdate,
    RecordOperationApply,
    RecordOperationApplyResult,
    RecordQueryRequest,
    RecordRead,
    RecordReplacePreview,
    RecordReplacePreviewRead,
    RecordReportStatusUpdate,
    RecordUpdate,
)
from app.services.cell_batches import (
    commit_cell_batch,
    current_cell_value,
    preview_cell_changes,
    preview_dict,
)
from app.services.field_validation import validate_field_value
from app.services.record_operations import apply_record_operation, snapshot_record
from app.services.records import (
    assign_record_to_project,
    replace_record_values,
    require_project,
    require_record,
    validate_core_record_values,
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
    project_ids: list[str] | None = None,
    scope: Literal["current", "all", "selected"] | None = None,
    record_status: str | None = None,
    search: str | None = None,
    experiment_date: date | None = None,
    report_generated: bool | None = None,
) -> list:
    filters = []
    if scope == "selected" and project_ids:
        filters.append(ProjectRecord.project_id.in_(project_ids))
    elif scope != "all" and project_id:
        filters.append(ProjectRecord.project_id == project_id)
    elif scope is None and project_ids:
        filters.append(ProjectRecord.project_id.in_(project_ids))
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
                ProjectRecord.project.has(Project.name.like(term)),
                ProjectRecord.pathology_number.like(term),
                ProjectRecord.experiment_number.like(term),
                value_match,
            )
        )
    return filters


@router.get("", response_model=RecordList)
def list_records(
    project_id: str | None = None,
    scope: Literal["current", "all", "selected"] | None = Query(default=None),
    project_ids: list[str] | None = Query(default=None),
    record_status: str | None = Query(default=None, alias="status"),
    search: str | None = None,
    experiment_date: date | None = None,
    report_generated: bool | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
) -> dict:
    normalized_project_ids = list(
        dict.fromkeys(item.strip() for item in (project_ids or []) if item.strip())
    )
    if scope == "current" and not project_id:
        raise HTTPException(status_code=422, detail="当前项目搜索必须提供 project_id")
    if scope == "selected" and not normalized_project_ids:
        raise HTTPException(status_code=422, detail="选定项目搜索必须提供 project_ids")
    filters = record_filters(
        project_id=project_id,
        project_ids=normalized_project_ids,
        scope=scope,
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


def _query_field_expression(field: FieldDefinition):
    if field.system_key == "pathology_number":
        return ProjectRecord.pathology_number
    if field.system_key == "status":
        return ProjectRecord.status
    if field.system_key == "experiment_date":
        return ProjectRecord.experiment_date
    if field.system_key == "experiment_number":
        return ProjectRecord.experiment_number
    return (
        select(RecordValue.value_text)
        .where(
            RecordValue.record_id == ProjectRecord.id,
            RecordValue.field_id == field.id,
        )
        .correlate(ProjectRecord)
        .scalar_subquery()
    )


def _complex_record_statement(
    session: Session,
    payload: RecordQueryRequest,
):
    require_project(session, payload.project_id)
    requested_field_ids = {item.field_id for item in payload.field_filters}
    if payload.sort:
        requested_field_ids.add(payload.sort.field_id)
    fields = {
        field.id: field
        for field in session.scalars(
            select(FieldDefinition).where(
                FieldDefinition.project_id == payload.project_id,
                FieldDefinition.id.in_(requested_field_ids),
            )
        )
    }
    if requested_field_ids - set(fields):
        raise HTTPException(status_code=422, detail="筛选或排序表头不属于当前项目")
    filters = record_filters(
        project_id=payload.project_id,
        scope="current",
        record_status=payload.status,
        search=payload.search,
        report_generated=payload.report_generated,
    )
    if payload.experiment_date_from is not None:
        filters.append(ProjectRecord.experiment_date >= payload.experiment_date_from)
    if payload.experiment_date_to is not None:
        filters.append(ProjectRecord.experiment_date <= payload.experiment_date_to)
    for item in payload.field_filters:
        field = fields[item.field_id]
        expression = _query_field_expression(field)
        if item.operator == "contains":
            text = item.value or ""
            filters.append(func.lower(cast(expression, String)).like(f"%{text.lower()}%"))
        elif item.operator == "equals":
            filters.append(cast(expression, String) == (item.value or ""))
        elif item.operator == "in":
            selected_values = list(dict.fromkeys(item.values))
            includes_empty = "" in selected_values
            non_empty_values = [value for value in selected_values if value != ""]
            alternatives = []
            if non_empty_values:
                alternatives.append(cast(expression, String).in_(non_empty_values))
            if includes_empty:
                alternatives.append(or_(expression.is_(None), cast(expression, String) == ""))
            if alternatives:
                filters.append(or_(*alternatives))
            else:
                filters.append(cast(expression, String).in_([]))
        elif item.operator == "is_empty":
            filters.append(or_(expression.is_(None), cast(expression, String) == ""))
        elif item.operator == "not_empty":
            filters.append(and_(expression.is_not(None), cast(expression, String) != ""))
        elif item.operator == "date_between":
            try:
                start_value = date.fromisoformat(item.start) if item.start else None
                end_value = date.fromisoformat(item.end) if item.end else None
            except ValueError as error:
                raise HTTPException(status_code=422, detail="日期筛选格式无效") from error
            date_expression = expression if field.is_core else cast(expression, String)
            if start_value is not None:
                filters.append(
                    date_expression >= (start_value if field.is_core else start_value.isoformat())
                )
            if end_value is not None:
                filters.append(
                    date_expression <= (end_value if field.is_core else end_value.isoformat())
                )
        elif item.operator == "number_between":
            number_expression = cast(expression, Float)
            try:
                if item.start not in {None, ""}:
                    filters.append(number_expression >= float(item.start))
                if item.end not in {None, ""}:
                    filters.append(number_expression <= float(item.end))
            except ValueError as error:
                raise HTTPException(status_code=422, detail="数字筛选范围无效") from error
    statement = select(ProjectRecord).where(*filters)
    if payload.sort:
        sort_field = fields[payload.sort.field_id]
        sort_expression = _query_field_expression(sort_field)
        if sort_field.data_type == "number":
            sort_expression = cast(sort_expression, Float)
        order = sort_expression.desc() if payload.sort.direction == "desc" else sort_expression.asc()
        statement = statement.order_by(order, ProjectRecord.created_at.asc(), ProjectRecord.id.asc())
    else:
        statement = statement.order_by(ProjectRecord.created_at.asc(), ProjectRecord.id.asc())
    return statement


@router.post("/query", response_model=RecordList)
def query_records(
    payload: RecordQueryRequest,
    session: Session = Depends(get_session),
) -> dict:
    statement = _complex_record_statement(session, payload)
    count_statement = statement.order_by(None)
    total = session.scalar(select(func.count()).select_from(count_statement.subquery())) or 0
    records = list(
        session.scalars(
            statement.options(*record_load_options())
            .offset(payload.offset)
            .limit(payload.limit)
        )
    )
    return {
        "items": [record_dict(record) for record in records],
        "total": total,
        "limit": payload.limit,
        "offset": payload.offset,
    }


@router.post("/query/ids", response_model=RecordIdList)
def query_record_ids(
    payload: RecordQueryRequest,
    session: Session = Depends(get_session),
) -> dict:
    statement = _complex_record_statement(session, payload).order_by(None)
    ids = list(session.scalars(statement.with_only_columns(ProjectRecord.id)))
    return {"record_ids": ids, "total": len(ids)}


@router.post("/by-ids", response_model=list[RecordRead])
def get_records_by_ids(
    payload: RecordIdsRequest,
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
    missing = set(record_ids) - set(by_id)
    if missing:
        raise HTTPException(status_code=409, detail="部分所选记录已不存在，请刷新后重试")
    return [record_dict(by_id[record_id]) for record_id in record_ids]


@router.post("/cell-batches/preview", response_model=RecordCellBatchPreviewRead)
def preview_record_cell_batch(
    payload: RecordCellBatchPreview,
    session: Session = Depends(get_session),
) -> dict:
    require_project(session, payload.project_id)
    preview = preview_cell_changes(
        session,
        project_id=payload.project_id,
        changes=payload.changes,
        new_records=payload.new_records,
    )
    return preview_dict(preview)


@router.post("/cell-batches/commit", response_model=RecordCellBatchCommitRead)
def commit_record_cell_batch(
    payload: RecordCellBatchCommit,
    session: Session = Depends(get_session),
) -> dict:
    return commit_cell_batch(
        session,
        token=payload.token,
        accept_warnings=payload.accept_warnings,
        include_snapshots=payload.include_snapshots,
    )


def _replace_text(
    value: str,
    *,
    find: str,
    replacement: str,
    match_mode: str,
    case_sensitive: bool,
) -> str | None:
    if match_mode == "whole":
        matches = value == find if case_sensitive else value.casefold() == find.casefold()
        return replacement if matches else None
    if not find:
        raise HTTPException(status_code=422, detail="子串查找内容不能为空")
    if case_sensitive:
        return value.replace(find, replacement) if find in value else None
    pattern = re.compile(re.escape(find), flags=re.IGNORECASE)
    return pattern.sub(lambda _: replacement, value) if pattern.search(value) else None


@router.post("/replace/preview", response_model=RecordReplacePreviewRead)
def preview_record_replace(
    payload: RecordReplacePreview,
    session: Session = Depends(get_session),
) -> dict:
    field = session.scalar(
        select(FieldDefinition)
        .where(
            FieldDefinition.id == payload.field_id,
            FieldDefinition.project_id == payload.project_id,
        )
        .options(selectinload(FieldDefinition.options))
    )
    if not field:
        raise HTTPException(status_code=404, detail="表头不存在")
    record_ids = list(dict.fromkeys(payload.record_ids))
    records = list(
        session.scalars(
            select(ProjectRecord)
            .where(
                ProjectRecord.id.in_(record_ids),
                ProjectRecord.project_id == payload.project_id,
            )
            .options(
                selectinload(ProjectRecord.project),
                selectinload(ProjectRecord.values),
            )
        )
    )
    by_id = {record.id: record for record in records}
    missing = set(record_ids) - set(by_id)
    if missing:
        raise HTTPException(status_code=409, detail="筛选结果已变化，请刷新后重试")
    changes = []
    for record_id in record_ids:
        record = by_id[record_id]
        current = current_cell_value(record, field)
        replaced = _replace_text(
            current,
            find=payload.find,
            replacement=payload.replacement,
            match_mode=payload.match_mode,
            case_sensitive=payload.case_sensitive,
        )
        if replaced is not None and replaced != current:
            changes.append(
                {
                    "record_id": record.id,
                    "field_id": field.id,
                    "value": replaced,
                    "expected_value": current,
                }
            )
    typed_changes = [RecordCellChange(**change) for change in changes]
    preview = preview_cell_changes(
        session,
        project_id=payload.project_id,
        changes=typed_changes,
        source="replace",
    )
    result = preview_dict(preview)
    return {
        "token": result["token"],
        "matched_count": result["affected_count"],
        "skipped_locked": result["skipped_locked"],
        "issues": result["issues"],
        "samples": typed_changes[:50],
        "expires_at": result["expires_at"],
    }


@router.post("/replace/commit", response_model=RecordCellBatchCommitRead)
def commit_record_replace(
    payload: RecordCellBatchCommit,
    session: Session = Depends(get_session),
) -> dict:
    return commit_cell_batch(
        session,
        token=payload.token,
        accept_warnings=payload.accept_warnings,
        include_snapshots=payload.include_snapshots,
    )


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
    project_ids = {record.project_id for record in ordered}
    if len(project_ids) != 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Experiment numbers can only be assigned within one ledger.",
        )
    project_id = next(iter(project_ids))
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
                ProjectRecord.project_id == project_id,
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
    try:
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
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="实验编号已被其他记录占用，请刷新后重试",
        ) from error
    return [record_dict(require_record(session, record.id, include_values=True)) for record in ordered]


@router.post("/operations/apply", response_model=RecordOperationApplyResult)
def apply_operation(
    payload: RecordOperationApply,
    session: Session = Depends(get_session),
) -> dict:
    records, deleted_ids = apply_record_operation(session, payload)
    return {
        "records": [record_dict(record) for record in records],
        "deleted_ids": deleted_ids,
    }


@router.post("/validate-new", response_model=RecordCreateValidationRead)
def validate_new_record(
    payload: RecordCreate,
    session: Session = Depends(get_session),
) -> dict:
    require_project(session, payload.project_id)
    fields = list(
        session.scalars(
            select(FieldDefinition)
            .where(FieldDefinition.project_id == payload.project_id)
            .options(selectinload(FieldDefinition.options))
        )
    )
    fields_by_id = {field.id: field for field in fields}
    invalid_value_fields = {
        field_id
        for field_id in payload.values
        if field_id not in fields_by_id or fields_by_id[field_id].is_core
    }
    if invalid_value_fields:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="新增记录包含无效的自定义表头",
        )
    issues = []
    core_values = {
        "pathology_number": payload.pathology_number,
        "status": payload.status,
        "experiment_date": payload.experiment_date.isoformat() if payload.experiment_date else "",
        "experiment_number": payload.experiment_number or "",
    }
    for field in fields:
        raw_value = (
            core_values.get(field.system_key or "", "")
            if field.is_core
            else payload.values.get(field.id, "")
        )
        _, field_issues = validate_field_value(field, raw_value)
        issues.extend(
            {
                "record_id": "new",
                "field_id": field.id,
                "severity": issue.severity,
                "message": issue.message,
            }
            for issue in field_issues
        )
    if payload.experiment_number:
        existing_number = session.scalar(
            select(ProjectRecord.id).where(
                ProjectRecord.project_id == payload.project_id,
                ProjectRecord.experiment_number == payload.experiment_number,
            )
        )
        number_field = next(
            (field for field in fields if field.system_key == "experiment_number"),
            None,
        )
        if existing_number and number_field:
            issues.append(
                {
                    "record_id": "new",
                    "field_id": number_field.id,
                    "severity": "error",
                    "message": "实验编号已存在",
                }
            )
    return {"issues": issues}


@router.get("/{record_id}", response_model=RecordRead)
def get_record(record_id: str, session: Session = Depends(get_session)) -> dict:
    return record_dict(require_record(session, record_id, include_values=True))


@router.post("", response_model=RecordRead, status_code=status.HTTP_201_CREATED)
def create_record(payload: RecordCreate, session: Session = Depends(get_session)) -> dict:
    require_project(session, payload.project_id)
    normalized_core = validate_core_record_values(
        session,
        payload.project_id,
        {
            "pathology_number": payload.pathology_number,
            "status": payload.status,
            "experiment_date": payload.experiment_date.isoformat() if payload.experiment_date else "",
            "experiment_number": payload.experiment_number or "",
        },
    )
    if payload.experiment_number:
        existing = session.scalar(
            select(ProjectRecord).where(
                ProjectRecord.project_id == payload.project_id,
                ProjectRecord.experiment_number == payload.experiment_number,
            )
        )
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="实验编号已存在")
    record = ProjectRecord(
        project_id=payload.project_id,
        pathology_number=normalized_core["pathology_number"],
        status=normalized_core["status"],
        experiment_date=(
            date.fromisoformat(normalized_core["experiment_date"])
            if normalized_core["experiment_date"]
            else None
        ),
        experiment_number=normalized_core["experiment_number"] or None,
        highlight_color=payload.highlight_color,
    )
    try:
        session.add(record)
        session.flush()
        replace_record_values(
            session,
            record,
            payload.values,
            include_required_missing=True,
        )
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
                "highlight_color": record.highlight_color,
            },
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="实验编号已被其他记录占用，请刷新后重试",
        ) from error
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
        "highlight_color": record.highlight_color,
    }
    core_changes: dict[str, object] = {}
    if payload.pathology_number is not None:
        core_changes["pathology_number"] = payload.pathology_number
    if payload.status is not None:
        core_changes["status"] = payload.status
    if "experiment_date" in payload.model_fields_set:
        core_changes["experiment_date"] = (
            payload.experiment_date.isoformat() if payload.experiment_date else ""
        )
    if "experiment_number" in payload.model_fields_set:
        existing = session.scalar(
            select(ProjectRecord).where(
                ProjectRecord.project_id == record.project_id,
                ProjectRecord.experiment_number == payload.experiment_number,
                ProjectRecord.id != record.id,
            )
        ) if payload.experiment_number else None
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="实验编号已存在")
        core_changes["experiment_number"] = payload.experiment_number or ""
    normalized_core = validate_core_record_values(session, record.project_id, core_changes)
    if "pathology_number" in normalized_core:
        record.pathology_number = normalized_core["pathology_number"]
    if "status" in normalized_core:
        record.status = normalized_core["status"]
    if "experiment_date" in normalized_core:
        record.experiment_date = (
            date.fromisoformat(normalized_core["experiment_date"])
            if normalized_core["experiment_date"]
            else None
        )
    if "experiment_number" in normalized_core:
        record.experiment_number = normalized_core["experiment_number"] or None
    if "highlight_color" in payload.model_fields_set:
        record.highlight_color = payload.highlight_color
    if payload.values is not None:
        replace_record_values(session, record, payload.values)
    try:
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
                    "highlight_color": record.highlight_color,
                },
            },
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="实验编号已被其他记录占用，请刷新后重试",
        ) from error
    return record_dict(require_record(session, record.id, include_values=True))


@router.put("/highlight", response_model=list[RecordRead])
def update_highlight(
    payload: RecordHighlightUpdate,
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
    for record in ordered:
        before = record.highlight_color
        record.highlight_color = payload.highlight_color
        if before != record.highlight_color:
            audit(
                session,
                "record.highlight.update",
                "project_record",
                record.id,
                {"before": before, "after": record.highlight_color},
            )
    session.commit()
    return [record_dict(require_record(session, record.id, include_values=True)) for record in ordered]


@router.put("/cell-highlights", response_model=list[RecordRead])
def update_cell_highlights(
    payload: RecordCellHighlightUpdate,
    session: Session = Depends(get_session),
) -> list[dict]:
    targets = list(
        dict.fromkeys((cell.record_id, cell.field_id) for cell in payload.cells)
    )
    record_ids = list(dict.fromkeys(record_id for record_id, _ in targets))
    field_ids = list(dict.fromkeys(field_id for _, field_id in targets))
    if not targets:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="记录 ID 和字段 ID 不能为空",
        )
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
    field_rows = list(
        session.execute(
            select(FieldDefinition.id, FieldDefinition.project_id).where(FieldDefinition.id.in_(field_ids))
        )
    )
    field_projects = {field_id: project_id for field_id, project_id in field_rows}
    missing_fields = [field_id for field_id in field_ids if field_id not in field_projects]
    if missing_fields:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"部分字段不存在：{', '.join(missing_fields)}",
        )
    targets_by_record: dict[str, set[str]] = {}
    invalid_fields: list[str] = []
    for record_id, field_id in targets:
        record = by_id[record_id]
        if field_projects[field_id] != record.project_id:
            invalid_fields.append(record_id)
            continue
        targets_by_record.setdefault(record_id, set()).add(field_id)
    if invalid_fields:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="选中的字段不属于对应台账记录所在项目",
        )

    ordered = [by_id[record_id] for record_id in record_ids]
    for record in ordered:
        before = dict(record.cell_highlight_colors or {})
        next_colors = dict(before)
        for field_id in targets_by_record.get(record.id, set()):
            if payload.highlight_color is None:
                next_colors.pop(field_id, None)
            else:
                next_colors[field_id] = payload.highlight_color
        if next_colors != before:
            record.cell_highlight_colors = next_colors
            audit(
                session,
                "record.cell_highlight.update",
                "project_record",
                record.id,
                {
                    "cells": [
                        {"record_id": record.id, "field_id": field_id}
                        for field_id in sorted(targets_by_record.get(record.id, set()))
                    ],
                    "before": before,
                    "after": next_colors,
                },
            )
    session.commit()
    return [record_dict(require_record(session, record.id, include_values=True)) for record in ordered]


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
            .options(selectinload(ProjectRecord.values))
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
    deleted_snapshots = [snapshot_record(record) for record in records]
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
    return {"deleted": len(records), "deleted_records": deleted_snapshots}
