from __future__ import annotations

from app.models import (
    ExperimentPlan,
    ExperimentPlanItem,
    ProjectRecord,
    ReportMapping,
    ReportTemplate,
    ReportTemplateVersion,
)


def record_dict(record: ProjectRecord) -> dict:
    return {
        "id": record.id,
        "project_id": record.project_id,
        "project_name": record.project.name,
        "pathology_number": record.pathology_number,
        "status": record.status,
        "experiment_date": record.experiment_date,
        "experiment_number": record.experiment_number,
        "report_generated": record.report_generated,
        "locked": record.locked,
        "values": {value.field_id: value.value_text for value in record.values},
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


def experiment_plan_item_dict(item: ExperimentPlanItem) -> dict:
    number = f"{item.plan.prefix}-{item.position}" if item.plan.prefix else ""
    return {
        "id": item.id,
        "plan_id": item.plan_id,
        "record_id": item.record_id,
        "project_id": item.record.project_id,
        "project_name": item.record.project.name,
        "pathology_number": item.record.pathology_number,
        "experiment_date": item.record.experiment_date,
        "previous_experiment_number": item.record.experiment_number,
        "position": item.position,
        "experiment_number": number,
        "status": item.record.status,
    }


def experiment_plan_dict(plan: ExperimentPlan) -> dict:
    return {
        "id": plan.id,
        "prefix": plan.prefix,
        "last_applied_at": plan.last_applied_at,
        "items": [experiment_plan_item_dict(item) for item in plan.items],
        "created_at": plan.created_at,
        "updated_at": plan.updated_at,
    }


def mapping_dict(mapping: ReportMapping) -> dict:
    return {
        "id": mapping.id,
        "placeholder": mapping.placeholder,
        "source_type": mapping.source_type,
        "field_id": mapping.field_id,
        "fixed_value": mapping.fixed_value,
    }


def template_version_dict(version: ReportTemplateVersion) -> dict:
    return {
        "id": version.id,
        "version_number": version.version_number,
        "original_filename": version.original_filename,
        "placeholders": version.placeholders,
        "mappings": [mapping_dict(mapping) for mapping in version.mappings],
        "created_at": version.created_at,
    }


def template_dict(template: ReportTemplate) -> dict:
    return {
        "id": template.id,
        "project_id": template.project_id,
        "project_name": template.project.name,
        "name": template.name,
        "versions": [template_version_dict(version) for version in template.versions],
        "created_at": template.created_at,
    }
