from __future__ import annotations

from app.models import (
    ExperimentBatch,
    ExperimentRun,
    ProjectRecord,
    ReportMapping,
    ReportTemplate,
    ReportTemplateVersion,
)


def record_dict(record: ProjectRecord) -> dict:
    return {
        "id": record.id,
        "case_id": record.case_id,
        "project_id": record.project_id,
        "project_name": record.project.name,
        "pathology_number": record.case.pathology_number,
        "status": record.status,
        "experiment_date": record.current_experiment_date,
        "experiment_number": record.experiment_number,
        "report_generated": record.report_generated,
        "locked": record.locked,
        "values": {value.field_id: value.value_text for value in record.values},
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


def experiment_run_dict(run: ExperimentRun) -> dict:
    return {
        "id": run.id,
        "batch_id": run.batch_id,
        "record_id": run.record_id,
        "project_id": run.record.project_id,
        "project_name": run.record.project.name,
        "pathology_number": run.record.case.pathology_number,
        "position": run.position,
        "experiment_number": run.experiment_number,
        "is_repeat": run.is_repeat,
        "status": run.record.status,
    }


def experiment_batch_dict(batch: ExperimentBatch | None, experiment_date: object) -> dict:
    return {
        "id": batch.id if batch else None,
        "experiment_date": experiment_date,
        "runs": [experiment_run_dict(run) for run in batch.runs] if batch else [],
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
