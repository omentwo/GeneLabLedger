from __future__ import annotations

import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.config import Settings
from app.database import get_session
from app.models import (
    FieldDefinition,
    Project,
    ProjectRecord,
    ReportMapping,
    ReportTemplate,
    ReportTemplateVersion,
)
from app.schemas import (
    NativePreviewRead,
    PrintEngineRead,
    PrinterRead,
    ReportBatchItem,
    ReportMappingsReplace,
    ReportNativePreviewCreate,
    ReportPrintCreate,
    ReportPrintPreviewCreate,
    ReportPrintPreviewRead,
    ReportPrintRead,
    ReportTemplateDeleteResponse,
    ReportTemplateRead,
    ReportTemplateVersionRead,
)
from app.services.docx_template import (
    InvalidDocxTemplate,
    extract_placeholders,
    render_docx,
)
from app.services.office_preview import OfficePreviewError, PreviewEngineUnavailable
from app.services.office_printing import (
    OfficePrintError,
    OfficePrintService,
)
from app.services.preview_files import cleanup_print_previews
from app.services.serializers import template_dict, template_version_dict
from app.timezones import ASIA_SHANGHAI

router = APIRouter(tags=["报告模板与直接打印"])


def safe_filename(value: str, fallback: str = "report") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" ._")
    return cleaned[:120] or fallback


def settings_from(request: Request) -> Settings:
    return request.app.state.settings


def printer_service_from(request: Request) -> OfficePrintService:
    return request.app.state.printer_service


def load_template(session: Session, template_id: str) -> ReportTemplate:
    template = session.scalar(
        select(ReportTemplate)
        .where(ReportTemplate.id == template_id)
        .options(
            selectinload(ReportTemplate.project),
            selectinload(ReportTemplate.versions).selectinload(ReportTemplateVersion.mappings),
        )
    )
    if not template:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="报告模板不存在")
    return template


def load_version(session: Session, version_id: str) -> ReportTemplateVersion:
    version = session.scalar(
        select(ReportTemplateVersion)
        .where(ReportTemplateVersion.id == version_id)
        .options(
            selectinload(ReportTemplateVersion.template).selectinload(ReportTemplate.project),
            selectinload(ReportTemplateVersion.mappings).selectinload(ReportMapping.field),
        )
    )
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="报告模板版本不存在")
    return version


def load_report_record(session: Session, record_id: str) -> ProjectRecord:
    record = session.scalar(
        select(ProjectRecord)
        .where(ProjectRecord.id == record_id)
        .options(
            selectinload(ProjectRecord.project),
            selectinload(ProjectRecord.values),
        )
    )
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="台账记录不存在")
    return record


async def read_docx_upload(file: UploadFile, settings: Settings) -> bytes:
    filename = file.filename or ""
    if Path(filename).suffix.lower() != ".docx":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="只允许上传 .docx 模板",
        )
    size_limit = settings.max_template_size_mb * 1024 * 1024
    content = await file.read(size_limit + 1)
    if len(content) > size_limit:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"模板不能超过 {settings.max_template_size_mb}MB",
        )
    try:
        placeholders = extract_placeholders(content)
    except InvalidDocxTemplate as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    if not placeholders:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="模板中没有识别到 {{占位符}}",
        )
    return content


def store_template_version(
    settings: Settings,
    template: ReportTemplate,
    version_number: int,
    storage_key: str,
    content: bytes,
) -> tuple[Path, list[str]]:
    placeholders = extract_placeholders(content)
    target_dir = settings.template_dir / template.id
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"v{version_number}-{storage_key}.docx"
    temporary_path = target_dir / f".{target_path.name}.{uuid.uuid4().hex}.tmp"
    try:
        temporary_path.write_bytes(content)
        temporary_path.replace(target_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return target_path, placeholders


@router.get("/report-templates", response_model=list[ReportTemplateRead])
def list_report_templates(
    project_id: str | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    statement = select(ReportTemplate).options(
        selectinload(ReportTemplate.project),
        selectinload(ReportTemplate.versions).selectinload(ReportTemplateVersion.mappings),
    )
    if project_id:
        statement = statement.where(ReportTemplate.project_id == project_id)
    templates = list(session.scalars(statement.order_by(ReportTemplate.created_at.desc())))
    return [template_dict(template) for template in templates]


@router.post(
    "/report-templates",
    response_model=ReportTemplateRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_report_template(
    request: Request,
    project_id: str = Form(...),
    name: str = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> dict:
    settings = settings_from(request)
    project = session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="模板名称不能为空")
    duplicate = session.scalar(
        select(ReportTemplate).where(
            ReportTemplate.project_id == project_id,
            ReportTemplate.name == clean_name,
        )
    )
    if duplicate:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="当前项目已有同名模板")
    content = await read_docx_upload(file, settings)
    template = ReportTemplate(project_id=project_id, name=clean_name)
    session.add(template)
    target_path: Path | None = None
    try:
        session.flush()
        version_id = str(uuid.uuid4())
        target_path, placeholders = store_template_version(
            settings,
            template,
            1,
            version_id,
            content,
        )
        version = ReportTemplateVersion(
            id=version_id,
            template_id=template.id,
            version_number=1,
            original_filename=file.filename or "template.docx",
            storage_path=str(target_path.resolve()),
            placeholders=placeholders,
        )
        session.add(version)
        session.flush()
        for placeholder in placeholders:
            session.add(
                ReportMapping(
                    template_version_id=version.id,
                    placeholder=placeholder,
                    source_type="unmapped",
                )
            )
        audit(
            session,
            "report_template.create",
            "report_template",
            template.id,
            {"project_id": project_id, "name": clean_name, "placeholders": placeholders},
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        if target_path:
            shutil.rmtree(target_path.parent, ignore_errors=True)
        raise HTTPException(status_code=409, detail="当前项目已有同名模板") from error
    except Exception:
        session.rollback()
        if target_path:
            shutil.rmtree(target_path.parent, ignore_errors=True)
        raise
    return template_dict(load_template(session, template.id))


@router.post(
    "/report-templates/{template_id}/versions",
    response_model=ReportTemplateVersionRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_report_template_version(
    template_id: str,
    request: Request,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> dict:
    settings = settings_from(request)
    template = load_template(session, template_id)
    content = await read_docx_upload(file, settings)
    current_max = (
        session.scalar(
            select(func.max(ReportTemplateVersion.version_number)).where(
                ReportTemplateVersion.template_id == template.id
            )
        )
        or 0
    )
    version_number = current_max + 1
    version_id = str(uuid.uuid4())
    target_path: Path | None = None
    try:
        target_path, placeholders = store_template_version(
            settings,
            template,
            version_number,
            version_id,
            content,
        )
        version = ReportTemplateVersion(
            id=version_id,
            template_id=template.id,
            version_number=version_number,
            original_filename=file.filename or "template.docx",
            storage_path=str(target_path.resolve()),
            placeholders=placeholders,
        )
        session.add(version)
        session.flush()
        for placeholder in placeholders:
            session.add(
                ReportMapping(
                    template_version_id=version.id,
                    placeholder=placeholder,
                    source_type="unmapped",
                )
            )
        audit(
            session,
            "report_template.version.create",
            "report_template_version",
            version.id,
            {"template_id": template.id, "version_number": version_number},
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        if target_path:
            target_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="模板版本已被其他请求占用，请重试",
        ) from error
    except Exception:
        session.rollback()
        if target_path:
            target_path.unlink(missing_ok=True)
        raise
    return template_version_dict(load_version(session, version.id))


@router.put(
    "/report-template-versions/{version_id}/mappings",
    response_model=ReportTemplateVersionRead,
)
def replace_report_mappings(
    version_id: str,
    payload: ReportMappingsReplace,
    session: Session = Depends(get_session),
) -> dict:
    version = load_version(session, version_id)
    provided = {mapping.placeholder: mapping for mapping in payload.mappings}
    if len(provided) != len(payload.mappings):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="同一占位符不能重复配置",
        )
    unknown = set(provided) - set(version.placeholders)
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"模板中不存在这些占位符：{', '.join(sorted(unknown))}",
        )
    existing = {mapping.placeholder: mapping for mapping in version.mappings}
    for placeholder in version.placeholders:
        incoming = provided.get(placeholder)
        mapping = existing.get(placeholder)
        if not mapping:
            mapping = ReportMapping(template_version_id=version.id, placeholder=placeholder)
            session.add(mapping)
        if not incoming:
            mapping.source_type = "unmapped"
            mapping.field_id = None
            mapping.fixed_value = None
            continue
        if incoming.source_type == "field":
            field = session.get(FieldDefinition, incoming.field_id) if incoming.field_id else None
            if not field or field.project_id != version.template.project_id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"占位符 {placeholder} 选择了无效的台账字段",
                )
        mapping.source_type = incoming.source_type
        mapping.field_id = incoming.field_id if incoming.source_type == "field" else None
        mapping.fixed_value = incoming.fixed_value if incoming.source_type == "fixed" else None
    audit(
        session,
        "report_template.mappings.replace",
        "report_template_version",
        version.id,
    )
    session.commit()
    return template_version_dict(load_version(session, version.id))


def resolve_mapping_values(
    version: ReportTemplateVersion,
    record: ProjectRecord,
) -> dict[str, str]:
    values_by_field = {value.field_id: value.value_text for value in record.values}
    replacements: dict[str, str] = {}
    invalid: list[str] = []
    current_date = datetime.now(ASIA_SHANGHAI).date().isoformat()
    for mapping in version.mappings:
        if mapping.source_type == "unmapped":
            invalid.append(mapping.placeholder)
            continue
        if mapping.source_type == "blank":
            replacements[mapping.placeholder] = ""
        elif mapping.source_type == "fixed":
            replacements[mapping.placeholder] = mapping.fixed_value or ""
        elif mapping.source_type == "current_date":
            replacements[mapping.placeholder] = current_date
        elif mapping.source_type == "experiment_number":
            replacements[mapping.placeholder] = record.experiment_number or ""
        elif mapping.source_type == "pathology_with_block":
            pathology_number = record.pathology_number.strip()
            block_number = (record.block_number or "").strip()
            replacements[mapping.placeholder] = (
                f"{pathology_number}-{block_number}" if block_number else pathology_number
            )
        elif mapping.source_type == "field":
            field = mapping.field
            if not field:
                invalid.append(mapping.placeholder)
                continue
            if field.system_key == "pathology_number":
                replacements[mapping.placeholder] = record.pathology_number
            elif field.system_key == "block_number":
                replacements[mapping.placeholder] = record.block_number or ""
            elif field.system_key == "status":
                replacements[mapping.placeholder] = record.status
            elif field.system_key == "experiment_date":
                replacements[mapping.placeholder] = (
                    record.experiment_date.isoformat() if record.experiment_date else ""
                )
            elif field.system_key == "experiment_number":
                replacements[mapping.placeholder] = record.experiment_number or ""
            else:
                replacements[mapping.placeholder] = values_by_field.get(field.id, "")
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"模板存在未映射或已失效的占位符：{', '.join(invalid)}",
        )
    return replacements


def render_report_documents(
    session: Session,
    version: ReportTemplateVersion,
    items: list,
    output_directory: Path,
) -> tuple[list[Path], list[str]]:
    documents: list[Path] = []
    record_ids: list[str] = []
    for index, item in enumerate(items, start=1):
        record = load_report_record(session, item.project_record_id)
        if record.project_id != version.template.project_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="模板所属项目与台账记录不一致",
            )
        replacements = resolve_mapping_values(version, record)
        base_name = safe_filename(
            f"{index:03d}_{record.pathology_number}",
            fallback=f"report_{index:03d}",
        )
        output_path = output_directory / f"{base_name}.docx"
        render_docx(Path(version.storage_path), output_path, replacements)
        documents.append(output_path)
        record_ids.append(record.id)
    return documents, record_ids


@router.get("/printers", response_model=list[PrinterRead])
def list_printers(request: Request) -> list[dict[str, object]]:
    return printer_service_from(request).list_printers()


@router.get("/print-engines", response_model=list[PrintEngineRead])
def list_print_engines(request: Request) -> list[dict[str, object]]:
    return printer_service_from(request).engine_statuses()


@router.post("/reports/print", response_model=ReportPrintRead)
def print_reports(
    payload: ReportPrintCreate,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    version = load_version(session, payload.template_version_id)
    printer_service = printer_service_from(request)
    settings = settings_from(request)
    print_root = settings.report_work_dir / f"print-{uuid.uuid4().hex}"
    print_root.mkdir(parents=True, exist_ok=False)
    try:
        documents, record_ids = render_report_documents(
            session,
            version,
            payload.items,
            print_root,
        )
        resolved_engine = printer_service.print_documents(
            documents,
            payload.printer_name,
            payload.print_engine,
        )
        audit(
            session,
            "report.print",
            "report_template_version",
            version.id,
            {
                "printer_name": payload.printer_name,
                "print_engine": resolved_engine,
                "record_ids": record_ids,
                "printed_reports": len(documents),
            },
        )
        session.commit()
    except (InvalidDocxTemplate, OfficePrintError) as error:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    finally:
        shutil.rmtree(print_root, ignore_errors=True)
    return {
        "printer_name": payload.printer_name,
        "printed_count": len(documents),
        "print_engine": resolved_engine,
    }


@router.post(
    "/report-template-versions/{version_id}/print-preview",
    response_model=ReportPrintPreviewRead,
)
def preview_report(
    version_id: str,
    payload: ReportPrintPreviewCreate,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    if payload.template_version_id != version_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Template version does not match the preview path.",
        )
    if len(payload.record_ids) != 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Preview one report at a time.",
        )
    version = load_version(session, version_id)
    settings = settings_from(request)
    preview_service = request.app.state.preview_service
    cleanup_print_previews(
        settings.report_work_dir,
        max_age_seconds=settings.preview_ttl_seconds,
    )
    preview_id = uuid.uuid4().hex
    work_root = settings.report_work_dir / f"report-preview-{preview_id}"
    preview_dir = settings.report_work_dir / "report-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    output_path = preview_dir / f"{preview_id}.pdf"
    work_root.mkdir(parents=True, exist_ok=False)
    try:
        documents, record_ids = render_report_documents(
            session,
            version,
            [ReportBatchItem(project_record_id=payload.record_ids[0])],
            work_root,
        )
        resolved_engine = preview_service.convert_docx_to_pdf(documents[0], output_path, payload.print_engine)
    except (InvalidDocxTemplate, OfficePreviewError, PreviewEngineUnavailable) as error:
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    finally:
        shutil.rmtree(work_root, ignore_errors=True)
    return {
        "preview_id": preview_id,
        "url": f"/api/print-preview/{preview_id}",
        "filename": f"report-{record_ids[0]}.pdf",
        "print_engine": resolved_engine,
        "record_count": 1,
    }


@router.post(
    "/report-template-versions/{version_id}/native-preview",
    response_model=NativePreviewRead,
)
def native_preview_report(
    version_id: str,
    payload: ReportNativePreviewCreate,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    if payload.template_version_id != version_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Template version does not match the preview path.",
        )
    version = load_version(session, version_id)
    settings = settings_from(request)
    preview_service = request.app.state.preview_service
    job_root = settings.report_work_dir / "native-previews" / uuid.uuid4().hex
    render_root = job_root / "render"
    job_root.mkdir(parents=True, exist_ok=False)
    try:
        documents, record_ids = render_report_documents(
            session,
            version,
            [ReportBatchItem(project_record_id=payload.record_ids[0])],
            render_root,
        )
        if not documents:
            raise OfficePreviewError("No report document was generated for native preview.")
        result = preview_service.start_native_preview(
            input_path=documents[0],
            work_root=job_root,
            document_type="docx",
            action=payload.action,
            engine=payload.print_engine,
        )
    except (InvalidDocxTemplate, OfficePreviewError) as error:
        shutil.rmtree(job_root, ignore_errors=True)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    result["filename"] = f"report-{record_ids[0]}.docx"
    return result


@router.delete(
    "/report-templates/{template_id}",
    response_model=ReportTemplateDeleteResponse,
)
def delete_report_template(
    template_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> ReportTemplateDeleteResponse:
    template = load_template(session, template_id)
    cleanup_warnings: list[str] = []
    template_directory: Path | None = None
    try:
        template_root = settings_from(request).template_dir.resolve()
        candidate = (template_root / template.id).resolve()
        candidate.relative_to(template_root)
    except ValueError:
        cleanup_warnings.append("报告模板文件路径不在受控目录内，已保留文件")
    except OSError:
        cleanup_warnings.append("报告模板文件路径无法校验，已保留文件")
    else:
        if candidate == template_root:
            cleanup_warnings.append("报告模板目录路径无效，已保留文件")
        else:
            template_directory = candidate
    audit(
        session,
        "report_template.delete",
        "report_template",
        template.id,
        {"name": template.name, "project_id": template.project_id},
    )
    session.delete(template)
    session.commit()
    removed_template_directory = False
    if template_directory is not None and template_directory.is_dir():
        try:
            shutil.rmtree(template_directory)
            removed_template_directory = True
        except OSError:
            cleanup_warnings.append("报告模板文件未能清理，请稍后手动检查")
    elif template_directory is not None and template_directory.exists():
        cleanup_warnings.append("报告模板文件路径不是受控目录，已保留文件")
    return ReportTemplateDeleteResponse(
        template_id=template.id,
        removed_template_directory=removed_template_directory,
        cleanup_warnings=cleanup_warnings,
    )
