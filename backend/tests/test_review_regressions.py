from __future__ import annotations

import pytest
from test_docx_template import split_placeholder_docx

from app.api.ledger_templates import _clean_fields
from app.models import ProjectRecord
from app.schemas import LedgerTemplateField
from app.services.docx_template import InvalidDocxTemplate, render_docx


def test_excel_import_routes_are_removed(client):
    for route in ("preview", "commit"):
        assert client.post(f"/api/imports/workbook/{route}").status_code == 404
    assert not any("/imports/" in path for path in client.get("/openapi.json").json()["paths"])


def test_auto_export_routes_are_removed(client):
    assert client.get("/api/auto-export/tasks").status_code == 404
    assert not any("/auto-export" in path for path in client.get("/openapi.json").json()["paths"])


def test_numeric_filters_exclude_partial_and_invalid_numbers(client, seeded_projects):
    project = seeded_projects["TB"]
    field = client.post(
        f"/api/projects/{project['id']}/fields",
        json={
            "label": "数值",
            "data_type": "number",
        },
    ).json()
    for value in ("abc", "3 pcs", "0", "3.5", "1e1", "", "NaN", "Infinity"):
        response = client.post(
            "/api/records",
            json={
                "project_id": project["id"],
                "pathology_number": value or "empty",
                "values": {field["id"]: value},
            },
        )
        assert response.status_code == 201, response.text
    query = {
        "project_id": project["id"],
        "field_filters": [
            {
                "field_id": field["id"],
                "operator": "number_between",
                "start": "0",
                "end": "10",
            }
        ],
    }
    response = client.post("/api/records/query", json=query)
    assert response.status_code == 200, response.text
    assert {row["pathology_number"] for row in response.json()["items"]} == {"0", "3.5", "1e1"}
    query["field_filters"] = [{"field_id": field["id"], "operator": "equals", "value": ""}]
    assert [
        row["pathology_number"] for row in client.post("/api/records/query", json=query).json()["items"]
    ] == ["empty"]


def test_cross_page_highlight_snapshots_undo_without_deleting(client, seeded_projects):
    project_id = seeded_projects["TB"]["id"]
    with client.app.state.database.session_factory() as session:
        session.add_all(
            ProjectRecord(project_id=project_id, pathology_number=f"P-{i}", position=i + 1)
            for i in range(201)
        )
        session.commit()
    page1 = client.post("/api/records/query", json={"project_id": project_id}).json()["items"]
    page2 = client.post("/api/records/query", json={"project_id": project_id, "offset": 200}).json()["items"]
    ids = [page1[0]["id"], page2[0]["id"]]
    before = client.post("/api/records/by-ids", json={"record_ids": ids}).json()
    after = client.put("/api/records/highlight", json={"record_ids": ids, "highlight_color": "#fff2cc"})
    assert after.status_code == 200, after.text
    undo = client.post(
        "/api/records/operations/apply",
        json={
            "operation_id": "cross-page",
            "project_id": project_id,
            "direction": "undo",
            "before": before,
            "after": after.json(),
        },
    )
    assert undo.status_code == 200, undo.text
    assert undo.json()["deleted_ids"] == []
    assert len(undo.json()["records"]) == 2
    assert all(row["highlight_color"] is None for row in undo.json()["records"])
    assert client.post("/api/records/query", json={"project_id": project_id}).json()["total"] == 201


def test_layout_compare_and_swap_preserves_other_window(client):
    key = "/api/settings/ledger_layout_settings"
    first = {"version": 1, "projects": {"p": {"sort": "new"}}}
    assert client.put(key, json={"value": first, "expected_value": None}).status_code == 200
    stale = client.put(key, json={"value": {"projects": {}}, "expected_value": None})
    assert stale.status_code == 409
    assert client.get(key).json()["value"] == first


def test_legacy_block_template_keeps_custom_field(seeded_projects):
    fields = [
        LedgerTemplateField.model_validate({**field, "options": [item["value"] for item in field["options"]]})
        for field in seeded_projects["TB"]["fields"]
        if field["system_key"] != "block_number"
    ]
    fields.append(
        LedgerTemplateField(key="legacy_block", label="蜡块号", data_type="text", default_value="A")
    )
    cleaned = _clean_fields(fields)
    assert sum(field["system_key"] == "block_number" for field in cleaned) == 1
    legacy = next(field for field in cleaned if field["key"] == "legacy_block")
    assert legacy["label"] == "蜡块号（旧自定义）"
    assert legacy["default_value"] == "A"
    assert not legacy["is_core"]


def test_docx_same_path_does_not_damage_template(tmp_path):
    path = tmp_path / "template.docx"
    original = split_placeholder_docx()
    path.write_bytes(original)
    with pytest.raises(InvalidDocxTemplate):
        render_docx(path, path, {"case_no": "changed"})
    assert path.read_bytes() == original


def test_preview_all_uses_each_projects_own_fields(client, seeded_projects):
    import io
    import zipfile

    from app.api.preview import _build_ledger_source
    from app.models import Project
    from app.schemas import LedgerNativePreviewCreate

    projects = list(seeded_projects.values())
    for index, project in enumerate(projects):
        custom = client.post(
            f"/api/projects/{project['id']}/fields",
            json={
                "label": f"项目字段{index}",
                "data_type": "text",
            },
        ).json()
        client.post(
            "/api/records",
            json={
                "project_id": project["id"],
                "pathology_number": f"CASE{index}",
                "values": {custom["id"]: f"VALUE{index}"},
            },
        )
    with client.app.state.database.session_factory() as session:
        project = session.get(Project, projects[0]["id"])
        content, _, scope, _ = _build_ledger_source(session, project, LedgerNativePreviewCreate(scope="all"))
    assert scope == "all"
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        sheets = [
            archive.read(name).decode()
            for name in archive.namelist()
            if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")
        ]
    assert len(sheets) == 2
    for index in range(2):
        matching = next(sheet for sheet in sheets if f"CASE{index}" in sheet)
        assert f"VALUE{index}" in matching
        assert f"项目字段{index}" in matching
        assert f"CASE{1 - index}" not in matching


def test_preview_checks_limit_before_loading_records(client, seeded_projects, monkeypatch):
    from fastapi import HTTPException

    from app.api.preview import _build_ledger_source
    from app.models import Project
    from app.schemas import LedgerNativePreviewCreate

    with client.app.state.database.session_factory() as session:
        project = session.get(Project, seeded_projects["TB"]["id"])
        _ = project.fields
        monkeypatch.setattr(session, "scalar", lambda *args, **kwargs: 10_001)
        with pytest.raises(HTTPException) as error:
            _build_ledger_source(session, project, LedgerNativePreviewCreate(scope="project"))
        assert error.value.status_code == 422


def test_report_template_flush_race_returns_conflict(client, seeded_projects, monkeypatch):
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm import Session

    from app.models import ReportTemplate

    original = Session.flush

    def conflicting_flush(session, *args, **kwargs):
        if any(isinstance(item, ReportTemplate) for item in session.new):
            raise IntegrityError("insert", {}, Exception("duplicate name"))
        return original(session, *args, **kwargs)

    monkeypatch.setattr(Session, "flush", conflicting_flush)
    response = client.post(
        "/api/report-templates",
        data={
            "project_id": seeded_projects["TB"]["id"],
            "name": "race",
        },
        files={
            "file": (
                "template.docx",
                split_placeholder_docx(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert response.status_code == 409, response.text
