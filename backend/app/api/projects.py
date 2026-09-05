from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.ledger_templates import apply_template_fields
from app.audit import audit
from app.database import get_session
from app.models import (
    FieldDefinition,
    FieldOption,
    LedgerTemplate,
    Project,
    ProjectRecord,
    RecordValue,
    ReportMapping,
    ReportTemplate,
    ReportTemplateVersion,
)
from app.schemas import (
    FieldBatchCreate,
    FieldBatchCreateResponse,
    FieldCreate,
    FieldOptionsReplace,
    FieldRead,
    FieldReorder,
    FieldUpdate,
    ProjectCreate,
    ProjectDuplicateCreate,
    ProjectForceDeleteRequest,
    ProjectForceDeleteResponse,
    ProjectRead,
    ProjectUpdate,
)
from app.seed import add_core_fields
from app.services.auto_exports import disable_tasks_for_deleted_project
from app.services.field_names import RESERVED_WORKBOOK_HEADERS, field_import_identifiers
from app.services.field_validation import validate_default_value
from app.services.records import require_project

router = APIRouter(prefix="/projects", tags=["项目与表头"])


def _ensure_unique_field_label(
    session: Session,
    project_id: str,
    label: str,
    *,
    exclude_field_id: str | None = None,
) -> None:
    normalized = label.strip()
    if normalized in RESERVED_WORKBOOK_HEADERS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="表头名称不能使用 系统保留字段",
        )
    fields = session.scalars(
        select(FieldDefinition).where(FieldDefinition.project_id == project_id)
    )
    for field in fields:
        if field.id == exclude_field_id:
            continue
        if normalized in field_import_identifiers(field):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="表头名称不能与其他表头名称或系统标识重复",
            )


def _validated_default(field: FieldDefinition, raw_value: str | None) -> str | None:
    normalized, issues = validate_default_value(field, raw_value)
    if issues:
        messages = "；".join(dict.fromkeys(issue.message for issue in issues))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"新记录默认值无效：{messages}",
        )
    return normalized


def load_project(session: Session, project_id: str) -> Project:
    project = session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.fields).selectinload(FieldDefinition.options))
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


@router.get("", response_model=list[ProjectRead])
def list_projects(session: Session = Depends(get_session)) -> list[Project]:
    return list(
        session.scalars(
            select(Project)
            .options(selectinload(Project.fields).selectinload(FieldDefinition.options))
            .order_by(Project.sort_order, Project.created_at)
        )
    )


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, session: Session = Depends(get_session)) -> Project:
    existing = session.scalar(select(Project).where(Project.name == payload.name))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目名称已存在")
    max_order = session.scalar(select(func.max(Project.sort_order))) or -1
    project = Project(name=payload.name, sort_order=max_order + 1)
    try:
        session.add(project)
        session.flush()
        if payload.template_id:
            template = session.get(LedgerTemplate, payload.template_id)
            if not template:
                session.rollback()
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Ledger template not found."
                )
            apply_template_fields(session, project, template)
        else:
            add_core_fields(session, project)
        audit(session, "project.create", "project", project.id, {"name": project.name})
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="项目名称已被其他请求占用，请刷新后重试",
        ) from error
    return load_project(session, project.id)


@router.post("/{project_id}/duplicate", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def duplicate_project(
    project_id: str,
    payload: ProjectDuplicateCreate,
    request: Request,
    session: Session = Depends(get_session),
) -> Project:
    source = session.scalar(
        select(Project)
        .where(Project.id == project_id)
        .options(
            selectinload(Project.fields).selectinload(FieldDefinition.options),
            selectinload(Project.records).selectinload(ProjectRecord.values),
            selectinload(Project.report_templates)
            .selectinload(ReportTemplate.versions)
            .selectinload(ReportTemplateVersion.mappings),
        )
    )
    if not source:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ledger not found.")
    name = payload.name or f"{source.name} - Copy"
    if session.scalar(select(Project).where(Project.name == name)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ledger name already exists.")
    settings = request.app.state.settings
    copied_paths: list[Path] = []
    new_project = Project(
        name=name,
        sort_order=(session.scalar(select(func.max(Project.sort_order))) or -1) + 1,
        experiment_enabled=source.experiment_enabled,
    )
    field_map: dict[str, FieldDefinition] = {}
    try:
        session.add(new_project)
        session.flush()
        for source_field in sorted(source.fields, key=lambda item: (item.sort_order, item.created_at)):
            cloned_field = FieldDefinition(
                project_id=new_project.id,
                key=source_field.key,
                label=source_field.label,
                data_type=source_field.data_type,
                system_key=source_field.system_key,
                is_core=source_field.is_core,
                hidden=source_field.hidden,
                sort_order=source_field.sort_order,
                width=source_field.width,
                validation_mode=source_field.validation_mode,
                validation_rules=dict(source_field.validation_rules or {}),
                default_value=source_field.default_value,
            )
            session.add(cloned_field)
            session.flush()
            field_map[source_field.id] = cloned_field
            for option in source_field.options:
                session.add(
                    FieldOption(field_id=cloned_field.id, value=option.value, sort_order=option.sort_order)
                )

        for source_record in source.records:
            cloned_record = ProjectRecord(
                project_id=new_project.id,
                position=source_record.position,
                status=source_record.status,
                experiment_date=source_record.experiment_date,
                pathology_number=source_record.pathology_number,
                block_number=source_record.block_number,
                experiment_number=source_record.experiment_number,
                report_generated=source_record.report_generated,
                locked=source_record.locked,
                highlight_color=source_record.highlight_color,
                cell_highlight_colors={
                    field_map[field_id].id: color
                    for field_id, color in (source_record.cell_highlight_colors or {}).items()
                    if field_id in field_map
                },
            )
            session.add(cloned_record)
            session.flush()
            for source_value in source_record.values:
                cloned_field = field_map.get(source_value.field_id)
                if cloned_field:
                    session.add(
                        RecordValue(
                            record_id=cloned_record.id,
                            field_id=cloned_field.id,
                            value_text=source_value.value_text,
                        )
                    )

        for source_template in source.report_templates:
            cloned_template = ReportTemplate(project_id=new_project.id, name=source_template.name)
            session.add(cloned_template)
            session.flush()
            for source_version in source_template.versions:
                source_path = Path(source_version.storage_path)
                target_dir = settings.template_dir / cloned_template.id
                target_dir.mkdir(parents=True, exist_ok=True)
                target_path = target_dir / f"v{source_version.version_number}{source_path.suffix or '.docx'}"
                if source_path.exists():
                    shutil.copy2(source_path, target_path)
                    copied_paths.append(target_path)
                else:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT, detail="A report template file is missing."
                    )
                cloned_version = ReportTemplateVersion(
                    template_id=cloned_template.id,
                    version_number=source_version.version_number,
                    original_filename=source_version.original_filename,
                    storage_path=str(target_path),
                    placeholders=list(source_version.placeholders or []),
                )
                session.add(cloned_version)
                session.flush()
                for source_mapping in source_version.mappings:
                    session.add(
                        ReportMapping(
                            template_version_id=cloned_version.id,
                            placeholder=source_mapping.placeholder,
                            source_type=source_mapping.source_type,
                            field_id=field_map.get(source_mapping.field_id).id
                            if source_mapping.field_id in field_map
                            else None,
                            fixed_value=source_mapping.fixed_value,
                        )
                    )
        audit(session, "project.duplicate", "project", new_project.id, {"source_project_id": source.id})
        session.commit()
    except HTTPException:
        session.rollback()
        for path in copied_paths:
            path.unlink(missing_ok=True)
        raise
    except Exception as error:
        session.rollback()
        for path in copied_paths:
            path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Ledger copy failed; no changes were saved."
        ) from error
    return load_project(session, new_project.id)


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    session: Session = Depends(get_session),
) -> Project:
    project = require_project(session, project_id)
    before = {
        "name": project.name,
        "sort_order": project.sort_order,
        "experiment_enabled": project.experiment_enabled,
    }
    if payload.name is not None:
        duplicate = session.scalar(
            select(Project).where(Project.name == payload.name, Project.id != project.id)
        )
        if duplicate:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目名称已存在")
        project.name = payload.name
    if payload.sort_order is not None:
        project.sort_order = payload.sort_order
    if payload.experiment_enabled is not None:
        project.experiment_enabled = payload.experiment_enabled
    try:
        audit(
            session,
            "project.update",
            "project",
            project.id,
            {
                "before": before,
                "after": {
                    "name": project.name,
                    "sort_order": project.sort_order,
                    "experiment_enabled": project.experiment_enabled,
                },
            },
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="项目名称已被其他请求占用，请刷新后重试",
        ) from error
    return load_project(session, project.id)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: str,
    session: Session = Depends(get_session),
) -> Response:
    project = require_project(session, project_id)
    record_count = session.scalar(
        select(func.count()).select_from(ProjectRecord).where(ProjectRecord.project_id == project.id)
    )
    template_count = session.scalar(
        select(func.count()).select_from(ReportTemplate).where(ReportTemplate.project_id == project.id)
    )
    if record_count or template_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="项目已有台账记录或报告模板，不能直接删除",
        )
    disable_tasks_for_deleted_project(session, project.id)
    audit(session, "project.delete", "project", project.id, {"name": project.name})
    session.delete(project)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{project_id}/force-delete",
    response_model=ProjectForceDeleteResponse,
)
def force_delete_project(
    project_id: str,
    payload: ProjectForceDeleteRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectForceDeleteResponse:
    """Permanently delete one ledger and its owned data after exact-name confirmation.

    The normal DELETE endpoint intentionally remains conservative.  This endpoint
    performs all dependent-row deletes in one transaction, scoped only to the
    selected project, and refuses unexpected cross-ledger references before making
    any change.
    """

    project = require_project(session, project_id)
    if payload.confirm_name != project.name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="必须输入完全匹配的台账名称才能强制删除",
        )

    field_ids = list(
        session.scalars(select(FieldDefinition.id).where(FieldDefinition.project_id == project.id))
    )
    record_ids = list(
        session.scalars(select(ProjectRecord.id).where(ProjectRecord.project_id == project.id))
    )
    template_ids = list(
        session.scalars(select(ReportTemplate.id).where(ReportTemplate.project_id == project.id))
    )
    version_ids = (
        list(
            session.scalars(
                select(ReportTemplateVersion.id).where(
                    ReportTemplateVersion.template_id.in_(template_ids)
                )
            )
        )
        if template_ids
        else []
    )

    # A corrupt/manual database must not let deleting one ledger mutate another
    # ledger through a field reference.  The normal APIs prevent these relations,
    # but force-delete treats their presence as a hard safety error.
    if field_ids:
        cross_ledger_values = session.scalar(
            select(func.count())
            .select_from(RecordValue)
            .join(ProjectRecord, RecordValue.record_id == ProjectRecord.id)
            .where(
                RecordValue.field_id.in_(field_ids),
                ProjectRecord.project_id != project.id,
            )
        ) or 0
        cross_ledger_mappings = session.scalar(
            select(func.count())
            .select_from(ReportMapping)
            .join(ReportTemplateVersion, ReportMapping.template_version_id == ReportTemplateVersion.id)
            .join(ReportTemplate, ReportTemplateVersion.template_id == ReportTemplate.id)
            .where(
                ReportMapping.field_id.in_(field_ids),
                ReportTemplate.project_id != project.id,
            )
        ) or 0
        if cross_ledger_values or cross_ledger_mappings:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="发现跨台账关联，已拒绝强制删除；未修改任何数据",
            )

    template_directories: list[Path] = []
    cleanup_warnings: list[str] = []
    template_root = request.app.state.settings.template_dir.resolve()
    for template_id in template_ids:
        try:
            candidate = (template_root / template_id).resolve()
            candidate.relative_to(template_root)
        except ValueError:
            cleanup_warnings.append("部分报告模板文件路径不在受控目录内，已保留文件")
        except OSError:
            cleanup_warnings.append("部分报告模板文件路径无法校验，已保留文件")
        else:
            if candidate == template_root:
                cleanup_warnings.append("报告模板目录路径无效，已保留文件")
            else:
                template_directories.append(candidate)

    updated_auto_export_tasks = disable_tasks_for_deleted_project(session, project.id)

    deleted_record_values = 0
    deleted_records = 0
    deleted_field_options = 0
    deleted_fields = 0
    deleted_report_mappings = 0
    deleted_report_versions = 0
    deleted_report_templates = 0
    try:
        audit(
            session,
            "project.force_delete",
            "project",
            project.id,
            {
                "name": project.name,
                "record_count": len(record_ids),
                "field_count": len(field_ids),
                "report_template_count": len(template_ids),
            },
        )
        if record_ids:
            deleted_record_values = (
                session.execute(delete(RecordValue).where(RecordValue.record_id.in_(record_ids))).rowcount
                or 0
            )
            deleted_records = (
                session.execute(delete(ProjectRecord).where(ProjectRecord.id.in_(record_ids))).rowcount
                or 0
            )
        if version_ids:
            deleted_report_mappings = (
                session.execute(
                    delete(ReportMapping).where(ReportMapping.template_version_id.in_(version_ids))
                ).rowcount
                or 0
            )
            deleted_report_versions = (
                session.execute(
                    delete(ReportTemplateVersion).where(ReportTemplateVersion.id.in_(version_ids))
                ).rowcount
                or 0
            )
        if template_ids:
            deleted_report_templates = (
                session.execute(delete(ReportTemplate).where(ReportTemplate.id.in_(template_ids))).rowcount
                or 0
            )
        if field_ids:
            deleted_field_options = (
                session.execute(delete(FieldOption).where(FieldOption.field_id.in_(field_ids))).rowcount
                or 0
            )
            deleted_fields = (
                session.execute(delete(FieldDefinition).where(FieldDefinition.id.in_(field_ids))).rowcount
                or 0
            )
        session.delete(project)
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="强制删除失败，数据库未发生改变；请检查台账关联后重试",
        ) from error
    except Exception as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="强制删除失败，数据库未发生改变",
        ) from error

    removed_template_directories = 0
    for directory in template_directories:
        if not directory.exists():
            continue
        if not directory.is_dir():
            cleanup_warnings.append("部分报告模板文件不是受控目录，已保留文件")
            continue
        try:
            shutil.rmtree(directory)
            removed_template_directories += 1
        except OSError:
            cleanup_warnings.append("部分报告模板文件未能清理，请稍后手动检查")

    return ProjectForceDeleteResponse(
        project_id=project.id,
        project_name=project.name,
        deleted_records=deleted_records,
        deleted_record_values=deleted_record_values,
        deleted_fields=deleted_fields,
        deleted_field_options=deleted_field_options,
        deleted_report_templates=deleted_report_templates,
        deleted_report_versions=deleted_report_versions,
        deleted_report_mappings=deleted_report_mappings,
        updated_auto_export_tasks=updated_auto_export_tasks,
        removed_template_directories=removed_template_directories,
        cleanup_warnings=cleanup_warnings,
    )


@router.get("/{project_id}/fields", response_model=list[FieldRead])
def list_fields(project_id: str, session: Session = Depends(get_session)) -> list[FieldDefinition]:
    require_project(session, project_id)
    return list(
        session.scalars(
            select(FieldDefinition)
            .where(FieldDefinition.project_id == project_id)
            .options(selectinload(FieldDefinition.options))
            .order_by(FieldDefinition.sort_order, FieldDefinition.created_at)
        )
    )


@router.post("/{project_id}/fields", response_model=FieldRead, status_code=status.HTTP_201_CREATED)
def create_field(
    project_id: str,
    payload: FieldCreate,
    session: Session = Depends(get_session),
) -> FieldDefinition:
    require_project(session, project_id)
    _ensure_unique_field_label(session, project_id, payload.label)
    max_order = (
        session.scalar(
            select(func.max(FieldDefinition.sort_order)).where(FieldDefinition.project_id == project_id)
        )
        or -1
    )
    field = FieldDefinition(
        project_id=project_id,
        key=f"custom_{uuid.uuid4().hex}",
        label=payload.label,
        data_type=payload.data_type,
        sort_order=max_order + 1,
        width=payload.width,
        is_core=False,
        validation_mode=payload.validation_mode,
        validation_rules=payload.validation_rules.model_dump(mode="json", exclude_none=True),
    )
    for index, value in enumerate(payload.options):
        field.options.append(FieldOption(value=value, sort_order=index))
    field.default_value = _validated_default(field, payload.default_value)
    try:
        session.add(field)
        session.flush()
        audit(
            session,
            "field.create",
            "field",
            field.id,
            {"project_id": project_id, "label": field.label},
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="表头备选项存在重复值，请检查后重试",
        ) from error
    return session.scalar(
        select(FieldDefinition)
        .where(FieldDefinition.id == field.id)
        .options(selectinload(FieldDefinition.options))
    )


@router.post("/{project_id}/fields/batch", response_model=FieldBatchCreateResponse)
def batch_create_fields(
    project_id: str,
    payload: FieldBatchCreate,
    session: Session = Depends(get_session),
) -> dict[str, list[FieldDefinition]]:
    require_project(session, project_id)
    existing_fields = list(
        session.scalars(
            select(FieldDefinition)
            .where(FieldDefinition.project_id == project_id)
            .options(selectinload(FieldDefinition.options))
            .order_by(FieldDefinition.sort_order, FieldDefinition.created_at)
        )
    )
    by_label = {field.label.strip(): field for field in existing_fields}
    retained: list[FieldDefinition] = []
    new_labels: list[str] = []
    for label in payload.labels:
        existing = by_label.get(label)
        if existing is not None:
            retained.append(existing)
            continue
        _ensure_unique_field_label(session, project_id, label)
        new_labels.append(label)

    max_order = session.scalar(
        select(func.max(FieldDefinition.sort_order)).where(FieldDefinition.project_id == project_id)
    )
    next_order = (max_order if max_order is not None else -1) + 1
    created = [
        FieldDefinition(
            project_id=project_id,
            key=f"custom_{uuid.uuid4().hex}",
            label=label,
            data_type="text",
            sort_order=next_order + index,
            width=120,
            is_core=False,
            hidden=False,
            validation_mode="suggestion",
            validation_rules={},
            default_value=None,
        )
        for index, label in enumerate(new_labels)
    ]
    try:
        session.add_all(created)
        session.flush()
        for field in created:
            audit(
                session,
                "field.create",
                "field",
                field.id,
                {"project_id": project_id, "label": field.label, "source": "batch"},
            )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="批量创建表头失败，所有新增内容均未保存",
        ) from error
    except Exception:
        session.rollback()
        raise

    return {"retained": retained, "created": created}


@router.patch("/fields/{field_id}", response_model=FieldRead)
def update_field(
    field_id: str,
    payload: FieldUpdate,
    session: Session = Depends(get_session),
) -> FieldDefinition:
    field = session.get(FieldDefinition, field_id)
    if not field:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="表头不存在")
    before = {
        "label": field.label,
        "data_type": field.data_type,
        "sort_order": field.sort_order,
        "width": field.width,
        "hidden": field.hidden,
        "validation_mode": field.validation_mode,
        "validation_rules": dict(field.validation_rules or {}),
        "default_value": field.default_value,
    }
    if payload.label is not None:
        _ensure_unique_field_label(
            session,
            field.project_id,
            payload.label,
            exclude_field_id=field.id,
        )
        field.label = payload.label
    if payload.data_type is not None:
        if field.is_core and payload.data_type != field.data_type:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="核心字段不能修改数据类型",
            )
        if not field.is_core:
            field.data_type = payload.data_type
    if payload.sort_order is not None:
        field.sort_order = payload.sort_order
    if payload.width is not None:
        field.width = payload.width
    if payload.hidden is not None:
        field.hidden = payload.hidden
    if payload.validation_mode is not None:
        if field.is_core:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="核心字段的验证模式不能修改",
            )
        field.validation_mode = payload.validation_mode
    if payload.validation_rules is not None:
        if field.is_core:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="核心字段的验证规则不能修改",
            )
        field.validation_rules = payload.validation_rules.model_dump(mode="json", exclude_none=True)
    if "default_value" in payload.model_fields_set:
        if field.is_core:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="核心字段不能设置新记录默认值",
            )
        field.default_value = payload.default_value
    if not field.is_core:
        field.default_value = _validated_default(field, field.default_value)
    audit(
        session,
        "field.update",
        "field",
        field.id,
        {
            "before": before,
            "after": {
                "label": field.label,
                "data_type": field.data_type,
                "sort_order": field.sort_order,
                "width": field.width,
                "hidden": field.hidden,
                "validation_mode": field.validation_mode,
                "validation_rules": dict(field.validation_rules or {}),
                "default_value": field.default_value,
            },
        },
    )
    session.commit()
    return session.scalar(
        select(FieldDefinition)
        .where(FieldDefinition.id == field.id)
        .options(selectinload(FieldDefinition.options))
    )


@router.put("/fields/{field_id}/options", response_model=FieldRead)
def replace_field_options(
    field_id: str,
    payload: FieldOptionsReplace,
    session: Session = Depends(get_session),
) -> FieldDefinition:
    field = session.scalar(
        select(FieldDefinition)
        .where(FieldDefinition.id == field_id)
        .options(selectinload(FieldDefinition.options))
    )
    if not field:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="表头不存在")
    if field.system_key == "status" and payload.options != ["待实验", "已完成"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="状态核心字段固定使用“待实验、已完成”",
        )
    try:
        field.options.clear()
        session.flush()
        for index, value in enumerate(payload.options):
            field.options.append(FieldOption(value=value, sort_order=index))
        if field.default_value is not None:
            field.default_value = _validated_default(field, field.default_value)
        audit(
            session,
            "field.options.replace",
            "field",
            field.id,
            {"options": payload.options},
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="备选项存在重复值，请检查后重试",
        ) from error
    return field


@router.put("/{project_id}/fields/reorder", response_model=list[FieldRead])
def reorder_fields(
    project_id: str,
    payload: FieldReorder,
    session: Session = Depends(get_session),
) -> list[FieldDefinition]:
    fields = list(
        session.scalars(
            select(FieldDefinition)
            .where(FieldDefinition.project_id == project_id)
            .options(selectinload(FieldDefinition.options))
        )
    )
    if {field.id for field in fields} != set(payload.field_ids) or len(fields) != len(payload.field_ids):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="排序必须包含当前项目的全部表头，且不能重复",
        )
    by_id = {field.id: field for field in fields}
    for index, field_id in enumerate(payload.field_ids):
        by_id[field_id].sort_order = index
    audit(
        session,
        "field.reorder",
        "project",
        project_id,
        {"field_ids": payload.field_ids},
    )
    session.commit()
    return [by_id[field_id] for field_id in payload.field_ids]


@router.delete("/fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_field(field_id: str, session: Session = Depends(get_session)) -> Response:
    field = session.get(FieldDefinition, field_id)
    if not field:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="表头不存在")
    if field.is_core:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="日期、病理号、实验编号和状态是核心字段，不能删除",
        )
    details = {"project_id": field.project_id, "label": field.label}
    audit(session, "field.delete", "field", field.id, details)
    session.delete(field)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="表头仍被其他数据引用，无法删除",
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)
