from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import FieldDefinition, FieldOption, Project

INITIAL_PROJECTS = ("TB", "BRAFV600E")
CORE_FIELDS = (
    {
        "key": "date",
        "label": "日期",
        "data_type": "date",
        "system_key": "experiment_date",
        "sort_order": 0,
        "width": 150,
    },
    {
        "key": "caseId",
        "label": "病理号",
        "data_type": "text",
        "system_key": "pathology_number",
        "sort_order": 1,
        "width": 120,
    },
    {
        "key": "blockNo",
        "label": "蜡块号",
        "data_type": "text",
        "system_key": "block_number",
        "sort_order": 2,
        "width": 110,
    },
    {
        "key": "experimentNo",
        "label": "实验编号",
        "data_type": "text",
        "system_key": "experiment_number",
        "sort_order": 3,
        "width": 145,
    },
    {
        "key": "status",
        "label": "状态",
        "data_type": "select",
        "system_key": "status",
        "sort_order": 4,
        "width": 120,
    },
)


def add_core_fields(session: Session, project: Project) -> None:
    existing_system_keys = {
        value
        for value in session.scalars(
            select(FieldDefinition.system_key).where(FieldDefinition.project_id == project.id)
        )
        if value
    }
    for definition in CORE_FIELDS:
        if definition["system_key"] in existing_system_keys:
            continue
        for existing_field in session.scalars(
            select(FieldDefinition).where(
                FieldDefinition.project_id == project.id,
                FieldDefinition.sort_order >= definition["sort_order"],
            )
        ):
            existing_field.sort_order += 1
        field = FieldDefinition(project_id=project.id, is_core=True, **definition)
        session.add(field)
        session.flush()
        if definition["system_key"] == "status":
            session.add_all(
                [
                    FieldOption(field_id=field.id, value="待实验", sort_order=0),
                    FieldOption(field_id=field.id, value="已完成", sort_order=1),
                ]
            )


def seed_initial_data(session: Session) -> None:
    project_count = session.scalar(select(func.count()).select_from(Project)) or 0
    if project_count == 0:
        for index, name in enumerate(INITIAL_PROJECTS):
            project = Project(name=name, sort_order=index)
            session.add(project)
            session.flush()
            add_core_fields(session, project)
    else:
        for project in session.scalars(select(Project).order_by(Project.sort_order)):
            add_core_fields(session, project)
    session.commit()
