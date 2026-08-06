from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import FieldDefinition, FieldOption, LedgerTemplate, Project
from app.schemas import (
    LedgerTemplateCreate,
    LedgerTemplateField,
    LedgerTemplateRead,
    LedgerTemplateUpdate,
)

router = APIRouter(tags=["ledger-templates"])


def _clean_fields(values: list[LedgerTemplateField]) -> list[dict[str, Any]]:
    if not values:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A ledger template must contain at least one field.",
        )
    seen_keys: set[str] = set()
    seen_system_keys: set[str] = set()
    result: list[dict[str, Any]] = []
    for index, field in enumerate(values):
        key = field.key.strip()
        if key in seen_keys:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Template field keys must be unique."
            )
        seen_keys.add(key)
        system_key = field.system_key.strip() if field.system_key else None
        if system_key and system_key in seen_system_keys:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Template system keys must be unique.",
            )
        if system_key:
            seen_system_keys.add(system_key)
        item = field.model_dump()
        item["key"] = key
        item["label"] = field.label.strip()
        item["system_key"] = system_key
        item["sort_order"] = field.sort_order if field.sort_order is not None else index
        item["options"] = list(field.options)
        result.append(item)
    result.sort(key=lambda item: (item["sort_order"], item["key"]))
    for index, item in enumerate(result):
        item["sort_order"] = index
    return result


def project_field_payload(project: Project) -> list[dict[str, Any]]:
    fields = sorted(project.fields, key=lambda field: (field.sort_order, field.created_at))
    return [
        {
            "key": field.key,
            "label": field.label,
            "data_type": field.data_type,
            "system_key": field.system_key,
            "is_core": field.is_core,
            "hidden": field.hidden,
            "sort_order": index,
            "width": field.width,
            "options": [
                option.value for option in sorted(field.options, key=lambda option: option.sort_order)
            ],
        }
        for index, field in enumerate(fields)
    ]


def template_dict(template: LedgerTemplate) -> dict[str, Any]:
    return {
        "id": template.id,
        "name": template.name,
        "description": template.description,
        "fields": template.fields or [],
        "created_at": template.created_at,
        "updated_at": template.updated_at,
    }


def apply_template_fields(session: Session, project: Project, template: LedgerTemplate) -> None:
    for index, item in enumerate(template.fields or []):
        field = FieldDefinition(
            project_id=project.id,
            key=item.get("key") or f"custom_{index}",
            label=item.get("label") or item.get("key") or f"Field {index + 1}",
            data_type=item.get("data_type") or "text",
            system_key=item.get("system_key"),
            is_core=bool(item.get("is_core", False)),
            hidden=bool(item.get("hidden", False)),
            sort_order=int(item.get("sort_order", index)),
            width=int(item.get("width", 120)),
        )
        session.add(field)
        session.flush()
        for option_index, value in enumerate(item.get("options") or []):
            session.add(FieldOption(field_id=field.id, value=str(value), sort_order=option_index))


def _template_or_404(session: Session, template_id: str) -> LedgerTemplate:
    template = session.get(LedgerTemplate, template_id)
    if not template:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ledger template not found.")
    return template


@router.get("/ledger-templates", response_model=list[LedgerTemplateRead])
def list_ledger_templates(session: Session = Depends(get_session)) -> list[LedgerTemplate]:
    return list(
        session.scalars(select(LedgerTemplate).order_by(LedgerTemplate.name, LedgerTemplate.created_at))
    )


@router.post("/ledger-templates", response_model=LedgerTemplateRead, status_code=status.HTTP_201_CREATED)
def create_ledger_template(
    payload: LedgerTemplateCreate,
    session: Session = Depends(get_session),
) -> LedgerTemplate:
    if session.scalar(select(LedgerTemplate).where(LedgerTemplate.name == payload.name)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Ledger template name already exists."
        )
    fields = payload.fields
    if payload.source_project_id:
        project = session.scalar(
            select(Project)
            .where(Project.id == payload.source_project_id)
            .options(selectinload(Project.fields).selectinload(FieldDefinition.options))
        )
        if not project:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source ledger not found.")
        fields = [LedgerTemplateField.model_validate(item) for item in project_field_payload(project)]
    template = LedgerTemplate(
        name=payload.name,
        description=payload.description,
        fields=_clean_fields(fields),
    )
    try:
        session.add(template)
        session.flush()
        audit(session, "ledger_template.create", "ledger_template", template.id, {"name": template.name})
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Ledger template name already exists."
        ) from error
    return template


@router.patch("/ledger-templates/{template_id}", response_model=LedgerTemplateRead)
def update_ledger_template(
    template_id: str,
    payload: LedgerTemplateUpdate,
    session: Session = Depends(get_session),
) -> LedgerTemplate:
    template = _template_or_404(session, template_id)
    if payload.name is not None and payload.name != template.name:
        if session.scalar(
            select(LedgerTemplate).where(
                LedgerTemplate.name == payload.name, LedgerTemplate.id != template.id
            )
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Ledger template name already exists."
            )
        template.name = payload.name
    if payload.description is not None:
        template.description = payload.description
    if payload.source_project_id:
        project = session.scalar(
            select(Project)
            .where(Project.id == payload.source_project_id)
            .options(selectinload(Project.fields).selectinload(FieldDefinition.options))
        )
        if not project:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source ledger not found.")
        template.fields = project_field_payload(project)
    elif payload.fields is not None:
        template.fields = _clean_fields(payload.fields)
    audit(session, "ledger_template.update", "ledger_template", template.id, {"name": template.name})
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Ledger template name already exists."
        ) from error
    return template


@router.delete("/ledger-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ledger_template(template_id: str, session: Session = Depends(get_session)) -> None:
    template = _template_or_404(session, template_id)
    audit(session, "ledger_template.delete", "ledger_template", template.id, {"name": template.name})
    session.delete(template)
    session.commit()
