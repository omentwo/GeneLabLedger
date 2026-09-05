from __future__ import annotations

import re
import shutil
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_session
from app.models import FieldDefinition, Project, ProjectRecord, RecordValue
from app.schemas import (
    LedgerNativePreviewCreate,
    LedgerPrintPreviewCreate,
    LedgerPrintPreviewRead,
    NativePreviewRead,
    PreviewCapabilitiesRead,
)
from app.services.office_preview import OfficePreviewError, OfficePreviewService, PreviewEngineUnavailable
from app.services.preview_files import cleanup_print_previews
from app.services.workbooks import build_xlsx

router = APIRouter(tags=["ledger-preview"])


def preview_service_from(request: Request) -> OfficePreviewService:
    return request.app.state.preview_service


def _display_value(record: ProjectRecord, field: FieldDefinition, values: dict[str, str]) -> object:
    if field.system_key == "experiment_date":
        return record.experiment_date.isoformat() if record.experiment_date else ""
    if field.system_key == "pathology_number":
        return record.pathology_number
    if field.system_key == "block_number":
        return record.block_number or ""
    if field.system_key == "experiment_number":
        return record.experiment_number or ""
    if field.system_key == "status":
        return record.status
    return values.get(field.id, "")


def _search_filters(project_id: str, payload: LedgerPrintPreviewCreate) -> list[Any]:
    filters: list[Any] = [ProjectRecord.project_id == project_id]
    if payload.status:
        filters.append(ProjectRecord.status == payload.status)
    if payload.experiment_date:
        filters.append(ProjectRecord.experiment_date == payload.experiment_date)
    if payload.report_generated is not None:
        filters.append(ProjectRecord.report_generated == payload.report_generated)
    if payload.search and payload.search.strip():
        term = f"%{payload.search.strip()}%"
        value_match = (
            select(RecordValue.id)
            .where(RecordValue.record_id == ProjectRecord.id, RecordValue.value_text.like(term))
            .exists()
        )
        filters.append(
            or_(
                ProjectRecord.pathology_number.like(term),
                ProjectRecord.block_number.like(term),
                ProjectRecord.experiment_number.like(term),
                value_match,
            )
        )
    return filters


def _preview_filters(project_id: str, payload: LedgerPrintPreviewCreate) -> list[Any]:
    if payload.scope == "project":
        return [ProjectRecord.project_id == project_id]
    return _search_filters(project_id, payload)


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" ._")
    return (cleaned or "ledger")[:100]


def _build_ledger_sheet(
    session: Session,
    project: Project,
    payload: LedgerPrintPreviewCreate,
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
    filters = _preview_filters(project.id, payload)
    if payload.scope == "selection":
        filters = [
            ProjectRecord.project_id == project.id,
            ProjectRecord.id.in_({item.record_id for item in payload.cells}),
        ]
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
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
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
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The selected cells are not part of this ledger.",
            )
        ordered_records = [
            record_by_id[record_id]
            for record_id in record_by_id
            if any(target[0] == record_id for target in selected_targets)
        ]
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
    payload: LedgerPrintPreviewCreate,
) -> tuple[bytes, str, str, int]:
    if payload.scope != "all":
        sheet, count = _build_ledger_sheet(session, project, payload)
        return build_xlsx([sheet]), f"{_safe_filename(project.name)}.xlsx", payload.scope, count
    projects = list(
        session.scalars(
            select(Project).options(selectinload(Project.fields)).order_by(Project.sort_order, Project.id)
        )
    )
    counts = dict(
        session.execute(
            select(ProjectRecord.project_id, func.count()).group_by(ProjectRecord.project_id)
        ).all()
    )
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


@router.post("/ledgers/{ledger_id}/print-preview", response_model=LedgerPrintPreviewRead)
def create_ledger_print_preview(
    ledger_id: str,
    payload: LedgerPrintPreviewCreate,
    request: Request,
    session: Session = Depends(get_session),
    service: OfficePreviewService = Depends(preview_service_from),
) -> dict[str, object]:
    project = session.scalar(
        select(Project).where(Project.id == ledger_id).options(selectinload(Project.fields))
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ledger not found.")
    document_bytes, _, scope, selected_count = _build_ledger_source(session, project, payload)

    preview_id = uuid.uuid4().hex
    settings = request.app.state.settings
    cleanup_print_previews(
        settings.report_work_dir,
        max_age_seconds=settings.preview_ttl_seconds,
    )
    preview_dir = settings.report_work_dir / "ledger-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    input_path = preview_dir / f"{preview_id}.xlsx"
    output_path = preview_dir / f"{preview_id}.pdf"
    input_path.write_bytes(document_bytes)
    try:
        resolved_engine = service.convert_xlsx_to_pdf(input_path, output_path, payload.print_engine)
    except (PreviewEngineUnavailable, OfficePreviewError) as error:
        input_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    finally:
        input_path.unlink(missing_ok=True)
    return {
        "preview_id": preview_id,
        "url": f"/api/print-preview/{preview_id}",
        "filename": f"{_safe_filename(project.name)}.pdf",
        "print_engine": resolved_engine,
        "scope": scope,
        "selected_cell_count": selected_count,
    }


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
            action=payload.action,
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


@router.get("/print-preview/{preview_id}")
def get_ledger_print_preview(preview_id: str, request: Request) -> FileResponse:
    if not re.fullmatch(r"[0-9a-f]{32}", preview_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Preview not found.")
    settings = request.app.state.settings
    report_work_dir = settings.report_work_dir
    cleanup_print_previews(
        report_work_dir,
        max_age_seconds=settings.preview_ttl_seconds,
    )
    paths = [
        report_work_dir / "ledger-previews" / f"{preview_id}.pdf",
        report_work_dir / "report-previews" / f"{preview_id}.pdf",
    ]
    path = next((candidate for candidate in paths if candidate.is_file()), None)
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Preview not found or expired.")
    return FileResponse(path, media_type="application/pdf", filename=f"{preview_id}.pdf")
