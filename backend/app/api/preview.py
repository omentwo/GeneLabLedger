from __future__ import annotations

import re
import shutil
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_session
from app.models import FieldDefinition, Project, ProjectRecord
from app.schemas import (
    LedgerNativePreviewCreate,
    NativePreviewRead,
    PreviewCapabilitiesRead,
)
from app.services.filenames import safe_filename
from app.services.office_preview import OfficePreviewError, OfficePreviewService
from app.services.records import core_record_value, record_search_filter
from app.services.workbooks import build_xlsx

router = APIRouter(tags=["ledger-preview"])


def preview_service_from(request: Request) -> OfficePreviewService:
    return request.app.state.preview_service


def _display_value(record: ProjectRecord, field: FieldDefinition, values: dict[str, str]) -> str:
    core = core_record_value(record, field)
    return core if core is not None else values.get(field.id, "")


def _search_filters(project_id: str, payload: LedgerNativePreviewCreate) -> list[Any]:
    filters: list[Any] = [ProjectRecord.project_id == project_id]
    if not payload.include_locked:
        filters.append(ProjectRecord.locked.is_(False))
    if payload.status:
        filters.append(ProjectRecord.status == payload.status)
    if payload.experiment_date:
        filters.append(ProjectRecord.experiment_date == payload.experiment_date)
    if payload.report_generated is not None:
        filters.append(ProjectRecord.report_generated == payload.report_generated)
    if payload.search and payload.search.strip():
        # 台账表格的搜索匹配项目名（搜索词命中项目名时返回该项目全部行），
        # 打印预览作为"所见即所得"必须使用同一谓词语义，否则同一筛选
        # 在表格与打印页返回的行不一致。
        search_clause = record_search_filter(payload.search, include_project_name=True)
        if search_clause is not None:
            filters.append(search_clause)
    return filters


def _preview_filters(project_id: str, payload: LedgerNativePreviewCreate) -> list[Any]:
    if payload.scope == "project":
        filters: list[Any] = [ProjectRecord.project_id == project_id]
        if payload.record_ids is not None:
            # WYSIWYG：只打印前端当前筛选/显示范围下的那批记录（id 集合由
            # /records/query/ids 取得），让"当前台账"与表格所见一致。
            filters.append(ProjectRecord.id.in_(payload.record_ids))
        if not payload.include_locked:
            filters.append(ProjectRecord.locked.is_(False))
        return filters
    return _search_filters(project_id, payload)


def _build_ledger_sheet(
    session: Session,
    project: Project,
    payload: LedgerNativePreviewCreate,
) -> tuple[tuple[str, list[str], list[list[object]]], int]:
    fields = [
        field
        for field in sorted(project.fields, key=lambda item: (item.sort_order, item.created_at))
        if not field.hidden
    ]
    if not fields:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="The ledger has no printable fields."
        )
    if payload.scope == "selection":
        selected_field_ids = {item.field_id for item in payload.cells}
        indices = [index for index, field in enumerate(fields) if field.id in selected_field_ids]
        if not indices:
            raise HTTPException(status_code=422, detail="请选择当前台账的可见单元格")
        fields = fields[min(indices) : max(indices) + 1]
        filters = [
            ProjectRecord.project_id == project.id,
            ProjectRecord.id.in_({item.record_id for item in payload.cells}),
        ]
        if not payload.include_locked:
            filters.append(ProjectRecord.locked.is_(False))
    else:
        filters = _preview_filters(project.id, payload)
    row_count = session.scalar(select(func.count()).select_from(ProjectRecord).where(*filters)) or 0
    if (row_count + 1) * len(fields) > 2_000_000 or row_count > 10_000 or len(fields) > 200:
        raise HTTPException(
            status_code=422, detail="预览内容过大，请缩小范围（最多 10000 行、200 列、200 万格）"
        )
    base_query = (
        select(ProjectRecord)
        .where(*filters)
        .options(selectinload(ProjectRecord.values))
        .order_by(ProjectRecord.position.asc(), ProjectRecord.id.asc())
    )
    all_records = list(session.scalars(base_query))
    selected_targets = {(item.record_id, item.field_id) for item in payload.cells}
    if payload.scope == "selection":
        if not selected_targets:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Select at least one cell to preview.",
            )
        record_by_id = {record.id: record for record in all_records}
        field_by_id = {field.id: field for field in fields}
        selected_targets = {
            (record_id, field_id)
            for record_id, field_id in selected_targets
            if record_id in record_by_id and field_id in field_by_id
        }
        if not selected_targets:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="The selected cells are not part of this ledger.",
            )
        selected_record_ids = {record_id for record_id, _ in selected_targets}
        ordered_records = [record_by_id[record_id] for record_id in selected_record_ids]
        ordered_records.sort(key=lambda record: (record.position, record.id))
        selected_field_ids = {field_id for _, field_id in selected_targets}
        ordered_fields = [field for field in fields if field.id in selected_field_ids]
        first_field_index = min(fields.index(field) for field in ordered_fields)
        last_field_index = max(fields.index(field) for field in ordered_fields)
        ordered_fields = fields[first_field_index : last_field_index + 1]
        rows: list[list[object]] = []
        for record in ordered_records:
            values = {value.field_id: value.value_text for value in record.values}
            rows.append(
                [
                    _display_value(record, field, values) if (record.id, field.id) in selected_targets else ""
                    for field in ordered_fields
                ]
            )
        headers = [field.label for field in ordered_fields]
        selected_count = len(selected_targets)
    else:
        ordered_records = all_records
        rows = []
        for record in ordered_records:
            values = {value.field_id: value.value_text for value in record.values}
            rows.append([_display_value(record, field, values) for field in fields])
        headers = [field.label for field in fields]
        selected_count = len(rows) * len(headers)
    return (project.name, headers, rows), selected_count


def _build_ledger_source(
    session: Session,
    project: Project,
    payload: LedgerNativePreviewCreate,
) -> tuple[bytes, str, str, int]:
    if payload.scope != "all":
        sheet, count = _build_ledger_sheet(session, project, payload)
        filename = safe_filename(project.name, fallback="ledger", max_length=100) + ".xlsx"
        return build_xlsx([sheet]), filename, payload.scope, count
    projects = list(
        session.scalars(
            select(Project).options(selectinload(Project.fields)).order_by(Project.sort_order, Project.id)
        )
    )
    count_statement = select(ProjectRecord.project_id, func.count()).group_by(
        ProjectRecord.project_id
    )
    if not payload.include_locked:
        count_statement = count_statement.where(ProjectRecord.locked.is_(False))
    counts = dict(session.execute(count_statement).all())
    printable_projects = [item for item in projects if any(not field.hidden for field in item.fields)]
    cell_count = sum(
        (counts.get(item.id, 0) + 1) * sum(not field.hidden for field in item.fields)
        for item in printable_projects
    )
    if len(printable_projects) > 100 or cell_count > 2_000_000:
        raise HTTPException(status_code=422, detail="预览内容过大，请缩小项目范围")
    sheets = []
    selected_count = 0
    for item in printable_projects:
        sheet, count = _build_ledger_sheet(session, item, payload.model_copy(update={"scope": "project"}))
        sheets.append(sheet)
        selected_count += count
    if not sheets:
        raise HTTPException(status_code=409, detail="没有可打印的表头")
    return build_xlsx(sheets), "全部台账.xlsx", "all", selected_count


@router.get("/preview/capabilities", response_model=PreviewCapabilitiesRead)
def preview_capabilities(
    request: Request,
    service: OfficePreviewService = Depends(preview_service_from),
) -> dict[str, object]:
    return service.capabilities()


@router.post("/ledgers/{ledger_id}/native-preview", response_model=NativePreviewRead)
def create_ledger_native_preview(
    ledger_id: str,
    payload: LedgerNativePreviewCreate,
    request: Request,
    session: Session = Depends(get_session),
    service: OfficePreviewService = Depends(preview_service_from),
) -> dict[str, object]:
    project = session.scalar(
        select(Project).where(Project.id == ledger_id).options(selectinload(Project.fields))
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ledger not found.")
    try:
        document_bytes, filename, scope, _ = _build_ledger_source(session, project, payload)
    except HTTPException:
        raise
    job_root = request.app.state.settings.report_work_dir / "native-previews" / uuid.uuid4().hex
    job_root.mkdir(parents=True, exist_ok=False)
    input_path = job_root / filename
    input_path.write_bytes(document_bytes)
    try:
        result = service.start_native_preview(
            input_path=input_path,
            work_root=job_root,
            document_type="xlsx",
            engine=payload.print_engine,
        )
    except OfficePreviewError as error:
        shutil.rmtree(job_root, ignore_errors=True)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    result["scope"] = scope
    return result


@router.get("/native-preview/{job_id}", response_model=NativePreviewRead)
def get_native_preview_status(
    job_id: str,
    service: OfficePreviewService = Depends(preview_service_from),
) -> dict[str, object]:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Native preview task not found.")
    result = service.native_job(job_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Native preview task not found.")
    return result
