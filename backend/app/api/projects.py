from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import (
    FieldDefinition,
    FieldOption,
    Project,
    ProjectRecord,
    ReportTemplate,
)
from app.schemas import (
    FieldCreate,
    FieldOptionsReplace,
    FieldRead,
    FieldReorder,
    FieldUpdate,
    ProjectCreate,
    ProjectRead,
    ProjectUpdate,
)
from app.seed import add_core_fields
from app.services.records import require_project

router = APIRouter(prefix="/projects", tags=["项目与表头"])


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
    session.add(project)
    session.flush()
    add_core_fields(session, project)
    audit(session, "project.create", "project", project.id, {"name": project.name})
    session.commit()
    return load_project(session, project.id)


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
    audit(session, "project.delete", "project", project.id, {"name": project.name})
    session.delete(project)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    )
    session.add(field)
    session.flush()
    for index, value in enumerate(payload.options):
        session.add(FieldOption(field_id=field.id, value=value, sort_order=index))
    audit(
        session,
        "field.create",
        "field",
        field.id,
        {"project_id": project_id, "label": field.label},
    )
    session.commit()
    return session.scalar(
        select(FieldDefinition)
        .where(FieldDefinition.id == field.id)
        .options(selectinload(FieldDefinition.options))
    )


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
    }
    if payload.label is not None:
        field.label = payload.label
    if payload.data_type is not None:
        if field.is_core:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="核心字段不能修改数据类型",
            )
        field.data_type = payload.data_type
    if payload.sort_order is not None:
        field.sort_order = payload.sort_order
    if payload.width is not None:
        field.width = payload.width
    if payload.hidden is not None:
        field.hidden = payload.hidden
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
    field.options.clear()
    for index, value in enumerate(payload.options):
        field.options.append(FieldOption(value=value, sort_order=index))
    audit(
        session,
        "field.options.replace",
        "field",
        field.id,
        {"options": payload.options},
    )
    session.commit()
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
