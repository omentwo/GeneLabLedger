from __future__ import annotations

from app.models import ProjectRecord, ReportMapping, ReportTemplate, ReportTemplateVersion


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
        "highlight_color": record.highlight_color,
        "cell_highlight_colors": dict(record.cell_highlight_colors or {}),
        "values": {value.field_id: value.value_text for value in record.values},
        "created_at": record.created_at,
        "updated_at": record.updated_at,
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
