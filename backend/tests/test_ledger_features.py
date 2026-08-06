from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class FakePreviewService:
    def __init__(self) -> None:
        self.native_jobs: dict[str, dict[str, object]] = {}

    def capabilities(self) -> dict[str, object]:
        return {
            "microsoft_office": True,
            "microsoft_writer": True,
            "microsoft_spreadsheet": True,
            "wps_writer": True,
            "wps_spreadsheet": True,
            "native_preview": True,
            "preferred_engine": "microsoft",
        }

    def convert_xlsx_to_pdf(self, input_path: Path, output_path: Path, engine: str = "auto") -> str:
        assert input_path.is_file()
        output_path.write_bytes(b"%PDF-1.7 fake preview")
        return "word" if engine in {"auto", "word"} else "wps"

    def start_native_preview(
        self,
        input_path: Path,
        work_root: Path,
        document_type: str,
        action: str,
        engine: str = "auto",
    ) -> dict[str, object]:
        assert input_path.is_file()
        job_id = "a" * 32
        result = {
            "job_id": job_id,
            "status": "open",
            "action": action,
            "print_engine": "word" if engine in {"auto", "word"} else "wps",
            "document_type": document_type,
            "filename": input_path.name,
            "error": None,
        }
        self.native_jobs[job_id] = result
        return result

    def native_job(self, job_id: str) -> dict[str, object] | None:
        return self.native_jobs.get(job_id)


def minimal_docx() -> bytes:
    document_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>{{case_no}}</w:t></w:r></w:p></w:body>
</w:document>"""
    content_types = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>"""
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("word/document.xml", document_xml)
    return stream.getvalue()


@pytest.fixture
def feature_client(tmp_path: Path) -> Iterator[TestClient]:
    data_dir = tmp_path / "data"
    settings = Settings(
        data_dir=data_dir,
        database_url=f"sqlite:///{(data_dir / 'test.db').as_posix()}",
        auto_create_schema=True,
    )
    app = create_app(settings=settings, preview_service=FakePreviewService())
    with TestClient(app) as client:
        yield client


def test_ledger_templates_and_project_duplicate(feature_client: TestClient) -> None:
    projects = feature_client.get("/api/projects").json()
    source = projects[0]
    custom = feature_client.post(
        f"/api/projects/{source['id']}/fields",
        json={"label": "复制字段", "data_type": "text", "width": 180, "options": []},
    ).json()
    record = feature_client.post(
        "/api/records",
        json={
            "project_id": source["id"],
            "pathology_number": "copy-case",
            "experiment_number": "copy-number",
            "values": {custom["id"]: "copy-value"},
        },
    ).json()

    template = feature_client.post(
        "/api/ledger-templates",
        json={"name": "复制模板", "source_project_id": source["id"]},
    )
    assert template.status_code == 201
    template_id = template.json()["id"]
    templated_project = feature_client.post(
        "/api/projects",
        json={"name": "套用模板台账", "template_id": template_id},
    )
    assert templated_project.status_code == 201
    assert [field["label"] for field in templated_project.json()["fields"]] == [
        field["label"] for field in source["fields"]
    ] + ["复制字段"]

    copied = feature_client.post(
        f"/api/projects/{source['id']}/duplicate",
        json={"name": "完整复制台账"},
    )
    assert copied.status_code == 201
    copied_project_id = copied.json()["id"]
    copied_records = feature_client.get(
        "/api/records", params={"project_id": copied_project_id, "limit": 1000}
    ).json()["items"]
    assert len(copied_records) == 1
    assert copied_records[0]["id"] != record["id"]
    assert copied_records[0]["experiment_number"] == "copy-number"
    copied_field = next(
        field for field in copied.json()["fields"] if field["label"] == "复制字段"
    )
    assert copied_records[0]["values"][copied_field["id"]] == "copy-value"


def test_force_delete_is_name_confirmed_and_scoped_to_one_ledger(feature_client: TestClient) -> None:
    projects = feature_client.get("/api/projects").json()
    source = projects[0]
    other = projects[1]
    source_record = feature_client.post(
        "/api/records",
        json={"project_id": source["id"], "pathology_number": "force-delete-source"},
    ).json()
    other_record = feature_client.post(
        "/api/records",
        json={"project_id": other["id"], "pathology_number": "force-delete-other"},
    ).json()
    uploaded = feature_client.post(
        "/api/report-templates",
        data={"project_id": source["id"], "name": "force-delete-template"},
        files={
            "file": (
                "report.docx",
                minimal_docx(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert uploaded.status_code == 201
    template_id = uploaded.json()["id"]
    template_directory = feature_client.app.state.settings.template_dir / template_id
    assert template_directory.is_dir()

    blocked = feature_client.delete(f"/api/projects/{source['id']}")
    assert blocked.status_code == 409

    wrong_name = feature_client.post(
        f"/api/projects/{source['id']}/force-delete",
        json={"confirm_name": "not-the-ledger-name"},
    )
    assert wrong_name.status_code == 422
    assert feature_client.get(f"/api/records/{source_record['id']}").status_code == 200

    deleted = feature_client.post(
        f"/api/projects/{source['id']}/force-delete",
        json={"confirm_name": source["name"]},
    )
    assert deleted.status_code == 200
    summary = deleted.json()
    assert summary["deleted_records"] == 1
    assert summary["deleted_report_templates"] == 1
    assert summary["removed_template_directories"] == 1
    assert not template_directory.exists()

    remaining_projects = feature_client.get("/api/projects").json()
    assert source["id"] not in {project["id"] for project in remaining_projects}
    assert other["id"] in {project["id"] for project in remaining_projects}
    assert feature_client.get(f"/api/records/{source_record['id']}").status_code == 404
    assert feature_client.get(f"/api/records/{other_record['id']}").status_code == 200


def test_force_delete_of_copy_keeps_source_report_template(feature_client: TestClient) -> None:
    source = feature_client.get("/api/projects").json()[0]
    uploaded = feature_client.post(
        "/api/report-templates",
        data={"project_id": source["id"], "name": "source-template-for-copy"},
        files={
            "file": (
                "report.docx",
                minimal_docx(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert uploaded.status_code == 201
    source_template = uploaded.json()
    source_directory = feature_client.app.state.settings.template_dir / source_template["id"]
    copied = feature_client.post(
        f"/api/projects/{source['id']}/duplicate",
        json={"name": "source-template-copy"},
    )
    assert copied.status_code == 201
    copied_templates = feature_client.get(
        "/api/report-templates", params={"project_id": copied.json()["id"]}
    ).json()
    assert len(copied_templates) == 1
    copied_directory = feature_client.app.state.settings.template_dir / copied_templates[0]["id"]
    assert source_directory.is_dir()
    assert copied_directory.is_dir()

    deleted = feature_client.post(
        f"/api/projects/{copied.json()['id']}/force-delete",
        json={"confirm_name": copied.json()["name"]},
    )
    assert deleted.status_code == 200
    assert not copied_directory.exists()
    assert source_directory.is_dir()
    source_templates = feature_client.get(
        "/api/report-templates", params={"project_id": source["id"]}
    ).json()
    assert any(template["id"] == source_template["id"] for template in source_templates)


def test_ledger_print_preview_uses_selected_scope(feature_client: TestClient) -> None:
    project = feature_client.get("/api/projects").json()[0]
    record = feature_client.post(
        "/api/records",
        json={"project_id": project["id"], "pathology_number": "preview-case"},
    ).json()
    field = project["fields"][1]
    response = feature_client.post(
        f"/api/ledgers/{project['id']}/print-preview",
        json={
            "scope": "selection",
            "cells": [{"record_id": record["id"], "field_id": field["id"]}],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["scope"] == "selection"
    assert payload["selected_cell_count"] == 1
    preview = feature_client.get(payload["url"])
    assert preview.status_code == 200
    assert preview.content.startswith(b"%PDF")


def test_ledger_native_preview_task_uses_generated_snapshot(feature_client: TestClient) -> None:
    project = feature_client.get("/api/projects").json()[0]
    response = feature_client.post(
        f"/api/ledgers/{project['id']}/native-preview",
        json={"scope": "all", "action": "preview", "print_engine": "auto"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "open"
    assert payload["action"] == "preview"
    assert payload["document_type"] == "xlsx"
    status_response = feature_client.get(f"/api/native-preview/{payload['job_id']}")
    assert status_response.status_code == 200
    assert status_response.json()["job_id"] == payload["job_id"]


def test_report_native_preview_task_uses_rendered_docx(feature_client: TestClient) -> None:
    project = feature_client.get("/api/projects").json()[0]
    record = feature_client.post(
        "/api/records",
        json={"project_id": project["id"], "pathology_number": "native-report"},
    ).json()
    pathology_field = next(
        field for field in project["fields"] if field["system_key"] == "pathology_number"
    )
    uploaded = feature_client.post(
        "/api/report-templates",
        data={"project_id": project["id"], "name": "native-report-template"},
        files={
            "file": (
                "report.docx",
                minimal_docx(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert uploaded.status_code == 201
    version = uploaded.json()["versions"][0]
    mapped = feature_client.put(
        f"/api/report-template-versions/{version['id']}/mappings",
        json={
            "mappings": [
                {
                    "placeholder": "case_no",
                    "source_type": "field",
                    "field_id": pathology_field["id"],
                }
            ]
        },
    )
    assert mapped.status_code == 200
    response = feature_client.post(
        f"/api/report-template-versions/{version['id']}/native-preview",
        json={
            "template_version_id": version["id"],
            "record_ids": [record["id"]],
            "action": "open",
            "print_engine": "auto",
        },
    )
    assert response.status_code == 200
    assert response.json()["document_type"] == "docx"
    assert response.json()["action"] == "open"
