from __future__ import annotations

import re
import shutil
import uuid
import zipfile
from datetime import date
from pathlib import Path
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload
from starlette.background import BackgroundTask

from app.audit import audit
from app.config import Settings
from app.database import get_session
from app.models import (
    ExperimentRun,
    FieldDefinition,
    Project,
    ProjectRecord,
    ReportMapping,
    ReportTemplate,
    ReportTemplateVersion,
)
from app.schemas import (
    PrintEngineRead,
    PrinterRead,
    ReportDocumentsCreate,
    ReportMappingsReplace,
    ReportPrintCreate,
    ReportPrintRead,
    ReportTemplateRead,
    ReportTemplateVersionRead,
)
from app.services.docx_template import (
    InvalidDocxTemplate,
    extract_placeholders,
    render_docx,
)
from app.services.office_printing import (
    OfficePrintError,
    OfficePrintService,
)
from app.services.serializers import template_dict, template_version_dict

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
            selectinload(ProjectRecord.case),
            selectinload(ProjectRecord.project),
            selectinload(ProjectRecord.values),
        )
    )
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="台账记录不存在")
    return record


def load_report_run(
    session: Session,
    record: ProjectRecord,
    run_id: str | None,
) -> ExperimentRun | None:
    statement = (
        select(ExperimentRun)
        .where(ExperimentRun.record_id == record.id)
        .options(selectinload(ExperimentRun.batch))
    )
    if run_id:
        run = session.scalar(statement.where(ExperimentRun.id == run_id))
        if not run:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="指定实验记录不属于当前台账记录",
            )
        return run
    return session.scalar(
        statement.order_by(ExperimentRun.created_at.desc(), ExperimentRun.id.desc()).limit(1)
    )


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
    original_filename: str,
    content: bytes,
) -> tuple[Path, list[str]]:
    placeholders = extract_placeholders(content)
    target_dir = settings.template_dir / template.id
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"v{version_number}.docx"
    target_path.write_bytes(content)
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
    session.flush()
    target_path: Path | None = None
    try:
        target_path, placeholders = store_template_version(
            settings,
            template,
            1,
            file.filename or "template.docx",
            content,
        )
        version = ReportTemplateVersion(
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
    target_path, placeholders = store_template_version(
        settings,
        template,
        version_number,
        file.filename or "template.docx",
        content,
    )
    version = ReportTemplateVersion(
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
    session: Session,
    version: ReportTemplateVersion,
    record: ProjectRecord,
    run: ExperimentRun | None,
) -> dict[str, str]:
    values_by_field = {value.field_id: value.value_text for value in record.values}
    replacements: dict[str, str] = {}
    invalid: list[str] = []
    for mapping in version.mappings:
        if mapping.source_type == "unmapped":
            invalid.append(mapping.placeholder)
            continue
        if mapping.source_type == "blank":
            replacements[mapping.placeholder] = ""
        elif mapping.source_type == "fixed":
            replacements[mapping.placeholder] = mapping.fixed_value or ""
        elif mapping.source_type == "current_date":
            replacements[mapping.placeholder] = date.today().isoformat()
        elif mapping.source_type == "experiment_number":
            replacements[mapping.placeholder] = (
                run.experiment_number if run else record.experiment_number or ""
            )
        elif mapping.source_type == "field":
            field = mapping.field
            if not field:
                invalid.append(mapping.placeholder)
                continue
            if field.system_key == "pathology_number":
                replacements[mapping.placeholder] = record.case.pathology_number
            elif field.system_key == "status":
                replacements[mapping.placeholder] = record.status
            elif field.system_key == "experiment_date":
                chosen_date = run.batch.experiment_date if run else record.current_experiment_date
                replacements[mapping.placeholder] = chosen_date.isoformat() if chosen_date else ""
            elif field.system_key == "experiment_number":
                replacements[mapping.placeholder] = (
                    run.experiment_number if run else record.experiment_number or ""
                )
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
        run = load_report_run(session, record, item.experiment_run_id)
        replacements = resolve_mapping_values(session, version, record, run)
        base_name = safe_filename(
            f"{index:03d}_{record.case.pathology_number}",
            fallback=f"report_{index:03d}",
        )
        output_path = output_directory / f"{base_name}.docx"
        render_docx(Path(version.storage_path), output_path, replacements)
        documents.append(output_path)
        record_ids.append(record.id)
    return documents, record_ids


@router.post("/reports/documents")
def generate_report_documents(
    payload: ReportDocumentsCreate,
    request: Request,
    session: Session = Depends(get_session),
) -> FileResponse:
    version = load_version(session, payload.template_version_id)
    settings = settings_from(request)
    workspace = settings.report_work_dir / f"word-{uuid.uuid4().hex}"
    workspace.mkdir(parents=True, exist_ok=False)
    try:
        documents, record_ids = render_report_documents(
            session,
            version,
            payload.items,
            workspace,
        )
        audit(
            session,
            "report.documents.generate",
            "report_template_version",
            version.id,
            {
                "record_ids": record_ids,
                "generated_reports": len(documents),
            },
        )
        session.commit()
        cleanup_task = BackgroundTask(shutil.rmtree, workspace, ignore_errors=True)
        if len(documents) == 1:
            filename = f"{safe_filename(version.template.name)}_{documents[0].name}"
            return FileResponse(
                documents[0],
                media_type=(
                    "application/vnd.openxmlformats-officedocument."
                    "wordprocessingml.document"
                ),
                headers={
                    "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
                    "Cache-Control": "no-store",
                },
                background=cleanup_task,
            )
        archive_name = f"{safe_filename(version.template.name)}_{len(documents)}份报告.zip"
        archive_path = workspace / archive_name
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for document in documents:
                archive.write(document, document.name)
        return FileResponse(
            archive_path,
            media_type="application/zip",
            headers={
                "Content-Disposition": (
                    f"attachment; filename*=UTF-8''{quote(archive_name)}"
                ),
                "Cache-Control": "no-store",
            },
            background=cleanup_task,
        )
    except InvalidDocxTemplate as error:
        session.rollback()
        shutil.rmtree(workspace, ignore_errors=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    except Exception:
        session.rollback()
        shutil.rmtree(workspace, ignore_errors=True)
        raise


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


@router.delete("/report-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report_template(
    template_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> Response:
    template = load_template(session, template_id)
    template_directory = settings_from(request).template_dir / template.id
    audit(
        session,
        "report_template.delete",
        "report_template",
        template.id,
        {"name": template.name, "project_id": template.project_id},
    )
    session.delete(template)
    session.commit()
    if template_directory.is_dir():
        shutil.rmtree(template_directory)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
