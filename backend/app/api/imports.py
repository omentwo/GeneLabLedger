from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import FieldDefinition, Project, ProjectRecord
from app.schemas import (
    WorkbookImportCommit,
    WorkbookImportPreviewRead,
    WorkbookImportPreviewRow,
    WorkbookImportResult,
)
from app.services.field_names import RESERVED_WORKBOOK_HEADERS, field_import_identifiers
from app.services.field_validation import new_record_field_value, validate_field_value
from app.services.records import next_record_position, replace_record_values, require_project
from app.services.workbook_import import InvalidWorkbook, ParsedSheet, parse_xlsx

router = APIRouter(prefix="/imports", tags=["Excel 导入"])
MAX_WORKBOOK_BYTES = 20 * 1024 * 1024
VALID_STATUSES = {"待实验", "已完成"}


def _clean_date(value: str) -> tuple[date | None, str | None]:
    text = value.strip()
    if not text:
        return None, None
    try:
        return date.fromisoformat(text), None
    except ValueError:
        return None, f"实验日期格式无效：{value}"


def _select_sheet(
    sheets: list[ParsedSheet],
    project: Project,
    requested_name: str | None,
) -> ParsedSheet:
    available = [sheet for sheet in sheets if not sheet.name.startswith("__")]
    if not available:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Excel 文件中没有可导入的工作表",
        )
    if requested_name:
        selected = next((sheet for sheet in available if sheet.name == requested_name), None)
        if not selected:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="指定的工作表不存在",
            )
        return selected
    return next((sheet for sheet in available if sheet.name == project.name), available[0])


def _field_map(session: Session, project_id: str) -> dict[str, FieldDefinition]:
    fields = list(
        session.scalars(
            select(FieldDefinition)
            .where(FieldDefinition.project_id == project_id)
            .options(selectinload(FieldDefinition.options))
            .order_by(FieldDefinition.sort_order)
        )
    )
    result: dict[str, FieldDefinition] = {}
    conflicts: set[str] = set()
    for field in fields:
        for identifier in field_import_identifiers(field):
            if identifier in RESERVED_WORKBOOK_HEADERS:
                conflicts.add(identifier)
            existing = result.get(identifier)
            if existing is not None and existing.id != field.id:
                conflicts.add(identifier)
                continue
            result[identifier] = field
    if conflicts:
        names = "、".join(sorted(conflicts))
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"项目表头存在导入命名冲突：{names}；请先重命名冲突表头",
        )
    return result


def _custom_value_issues(
    fields: list[FieldDefinition],
    values: dict[str, str],
    *,
    is_new: bool,
) -> tuple[dict[str, str], dict[str, list[str]]]:
    custom_fields = [field for field in fields if not field.is_core]
    by_id = {field.id: field for field in custom_fields}
    messages = {"error": [], "warning": [], "suggestion": []}
    unknown = set(values) - set(by_id)
    if unknown:
        messages["error"].append(
            f"存在不属于当前项目的字段：{', '.join(sorted(unknown))}"
        )
    normalized: dict[str, str] = {}
    for field in custom_fields:
        if not is_new and field.id not in values:
            continue
        raw_value = new_record_field_value(field, values) if is_new else values[field.id]
        value, issues = validate_field_value(field, raw_value)
        normalized[field.id] = value
        for issue in issues:
            messages[issue.severity].append(issue.message)
    return normalized, messages


def _preview_rows(
    session: Session,
    project: Project,
    sheet: ParsedSheet,
) -> tuple[list[WorkbookImportPreviewRow], list[str]]:
    fields = _field_map(session, project.id)
    header_indexes = {header.strip(): index for index, header in enumerate(sheet.headers) if header.strip()}
    normalized_headers = [header.strip() for header in sheet.headers if header.strip()]
    duplicate_headers = sorted(
        {header for header in normalized_headers if normalized_headers.count(header) > 1}
    )
    unknown_headers = [
        header
        for header in header_indexes
        if header not in fields and header not in RESERVED_WORKBOOK_HEADERS
    ]
    errors: list[str] = []
    if duplicate_headers:
        errors.append(f"存在重复表头：{', '.join(duplicate_headers)}")
    if unknown_headers:
        errors.append(f"存在当前项目无法识别的表头：{', '.join(unknown_headers)}")
    rows: list[WorkbookImportPreviewRow] = []
    project_fields = list({field.id: field for field in fields.values()}.values())
    for row_number, raw in enumerate(sheet.rows, start=2):
        if not any(value.strip() for value in raw):
            continue
        row_errors: list[str] = []
        record_id = raw[header_indexes["_record_id"]].strip() if "_record_id" in header_indexes else None
        source_project_id = (
            raw[header_indexes["_project_id"]].strip() if "_project_id" in header_indexes else ""
        )
        if source_project_id and source_project_id != project.id:
            row_errors.append("工作簿中的项目 UUID 与当前项目不一致")
        record = None
        action = "update" if record_id else "create"
        if record_id:
            try:
                uuid.UUID(record_id)
            except ValueError:
                row_errors.append("记录 UUID 格式无效")
            else:
                record = session.get(ProjectRecord, record_id)
                if not record:
                    row_errors.append("记录 UUID 不存在")
        if record and record.project_id != project.id:
            row_errors.append("记录 UUID 属于其他项目")
        if record and record.locked:
            row_errors.append("记录已锁定")

        core: dict[str, str] = {}
        values: dict[str, str] = {}
        for header, index in header_indexes.items():
            field = fields.get(header)
            if not field:
                continue
            value = raw[index].strip() if index < len(raw) else ""
            if field.system_key:
                core[field.system_key] = value
            elif not field.is_core:
                values[field.id] = value

        pathology_number = core.get("pathology_number", "").strip()
        block_number = core.get("block_number", "").strip() or None
        if not pathology_number:
            row_errors.append("病理号不能为空")
        record_status = core.get("status", "待实验").strip() or "待实验"
        if record_status not in VALID_STATUSES:
            row_errors.append(f"状态无效：{record_status}")
            record_status = "待实验"
        experiment_date, date_error = _clean_date(core.get("experiment_date", ""))
        if date_error:
            row_errors.append(date_error)
        experiment_number = core.get("experiment_number", "").strip() or None
        normalized_values, value_issues = _custom_value_issues(
            project_fields,
            values,
            is_new=action == "create",
        )
        row_errors.extend(value_issues["error"])
        rows.append(
            WorkbookImportPreviewRow(
                row_number=row_number,
                record_id=record_id,
                pathology_number=pathology_number or "（缺失）",
                block_number=block_number,
                status=record_status,
                experiment_date=experiment_date,
                experiment_number=experiment_number,
                values=normalized_values,
                action=action,
                errors=row_errors,
                warnings=value_issues["warning"],
                suggestions=value_issues["suggestion"],
            )
        )
    return rows, errors


@router.post("/workbook/preview", response_model=WorkbookImportPreviewRead)
async def preview_workbook(
    project_id: str = Form(...),
    sheet_name: str | None = Form(default=None),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> dict:
    project = require_project(session, project_id)
    content = await file.read(MAX_WORKBOOK_BYTES + 1)
    if len(content) > MAX_WORKBOOK_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Excel 文件不能超过 20MB",
        )
    try:
        sheets = parse_xlsx(content)
    except InvalidWorkbook as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    selected = _select_sheet(sheets, project, sheet_name)
    rows, errors = _preview_rows(session, project, selected)
    return {
        "filename": file.filename or "导入文件.xlsx",
        "project_id": project.id,
        "selected_sheet": selected.name,
        "available_sheets": [sheet.name for sheet in sheets if not sheet.name.startswith("__")],
        "rows": rows,
        "create_count": sum(row.action == "create" and not row.errors for row in rows),
        "update_count": sum(row.action == "update" and not row.errors for row in rows),
        "errors": errors,
    }


@router.post("/workbook/commit", response_model=WorkbookImportResult)
def commit_workbook(
    payload: WorkbookImportCommit,
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
    target_ids = [row.record_id for row in payload.rows if row.record_id]
    if len(target_ids) != len(set(target_ids)):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="导入内容中存在重复的记录 UUID",
        )
    existing = {
        record.id: record
        for record in session.scalars(
            select(ProjectRecord)
            .where(ProjectRecord.id.in_(target_ids))
            .options(selectinload(ProjectRecord.values))
        )
    }
    for row in payload.rows:
        if row.record_id:
            try:
                uuid.UUID(row.record_id)
            except ValueError as error:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"第 {row.row_number} 行记录 UUID 无效",
                ) from error
        record = existing.get(row.record_id or "")
        if row.record_id and not record:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"第 {row.row_number} 行记录 UUID 不存在",
            )
        if record and record.project_id != payload.project_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"第 {row.row_number} 行记录不属于当前项目",
            )
        if record and record.locked:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"第 {row.row_number} 行记录已锁定",
            )

    prepared_values: list[dict[str, str]] = []
    validation_errors: list[str] = []
    validation_warnings: list[str] = []
    for row in payload.rows:
        normalized, issues = _custom_value_issues(
            fields,
            row.values,
            is_new=row.record_id is None,
        )
        prepared_values.append(normalized)
        validation_errors.extend(
            f"第 {row.row_number} 行：{message}" for message in issues["error"]
        )
        validation_warnings.extend(
            f"第 {row.row_number} 行：{message}" for message in issues["warning"]
        )
    if validation_errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="；".join(dict.fromkeys(validation_errors)),
        )
    if validation_warnings and not payload.accept_warnings:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="导入内容存在验证警告，请确认后继续："
            + "；".join(dict.fromkeys(validation_warnings)),
        )

    try:
        created = 0
        updated = 0
        record_ids: list[str] = []
        next_position = next_record_position(session, payload.project_id)
        for row, normalized_values in zip(payload.rows, prepared_values, strict=True):
            record = existing.get(row.record_id or "")
            action = "update"
            if not record:
                record = ProjectRecord(
                    id=row.record_id or str(uuid.uuid4()),
                    project_id=payload.project_id,
                    position=next_position,
                    pathology_number=row.pathology_number,
                    block_number=row.block_number,
                )
                next_position += 1
                session.add(record)
                session.flush()
                created += 1
                action = "create"
            else:
                updated += 1
            record.pathology_number = row.pathology_number
            record.block_number = row.block_number
            record.status = row.status
            record.experiment_date = row.experiment_date
            record.experiment_number = row.experiment_number or None
            replace_record_values(
                session,
                record,
                normalized_values,
                include_required_missing=action == "create",
                apply_defaults=action == "create",
            )
            record_ids.append(record.id)
            audit(
                session,
                f"record.import.{action}",
                "project_record",
                record.id,
                {"row_number": row.row_number, "project_id": payload.project_id},
            )
        audit(
            session,
            "record.import.commit",
            "project",
            payload.project_id,
            {"created": created, "updated": updated, "record_ids": record_ids},
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="导入数据与现有记录冲突，请刷新后重试",
        ) from error
    return {"created": created, "updated": updated, "record_ids": record_ids}
