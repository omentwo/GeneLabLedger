from __future__ import annotations

import io
import zipfile

from fastapi.testclient import TestClient

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def minimal_docx() -> bytes:
    document_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>病理号：{{case_no}}</w:t></w:r></w:p>
    <w:p><w:r><w:t>实验编号：{{experiment_no}}</w:t></w:r></w:p>
  </w:body>
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


def workbook_bytes(client: TestClient, headers: list[str], rows: list[list[str]]) -> bytes:
    response = client.post(
        "/api/exports/workbook",
        json={
            "filename": "导入测试",
            "sheets": [
                {
                    "name": "TB",
                    "headers": headers,
                    "rows": rows,
                    "hidden_columns": [1, 2],
                }
            ],
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith(XLSX_MEDIA_TYPE)
    return response.content


def test_seed_health_and_json_settings(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    assert set(seeded_projects) == {"TB", "BRAFV600E"}
    for project in seeded_projects.values():
        assert [field["label"] for field in project["fields"]] == [
            "日期",
            "病理号",
            "实验编号",
            "状态",
        ]
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["print_engines"][0]["resolved_engine"] == "word"

    assert client.get("/api/settings/queue_columns").json()["value"] is None
    payload = {"value": [{"key": "pathology", "name": "病理号", "export": True}]}
    saved = client.put("/api/settings/queue_columns", json=payload)
    assert saved.status_code == 200
    assert saved.json() == {"key": "queue_columns", **payload}


def test_pathology_number_is_plain_record_data_and_duplicates_are_independent(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb_id = seeded_projects["TB"]["id"]
    braf_id = seeded_projects["BRAFV600E"]["id"]
    first = client.post(
        "/api/records",
        json={"project_id": tb_id, "pathology_number": "26-00001"},
    ).json()
    second = client.post(
        "/api/records",
        json={"project_id": tb_id, "pathology_number": "26-00001"},
    ).json()
    assigned = client.post(
        f"/api/records/{first['id']}/assign-project",
        json={"target_project_id": braf_id},
    ).json()

    assert len({first["id"], second["id"], assigned["id"]}) == 3
    assert first["pathology_number"] == second["pathology_number"] == assigned["pathology_number"]

    updated = client.patch(
        f"/api/records/{first['id']}",
        json={"pathology_number": "26-CHANGED"},
    ).json()
    assert updated["pathology_number"] == "26-CHANGED"
    assert client.get(f"/api/records/{second['id']}").json()["pathology_number"] == "26-00001"
    assert client.get(f"/api/records/{assigned['id']}").json()["pathology_number"] == "26-00001"


def test_experiment_numbering_only_updates_numbers_and_remains_editable(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb_id = seeded_projects["TB"]["id"]
    first = client.post(
        "/api/records",
        json={
            "project_id": tb_id,
            "pathology_number": "PLAN-001",
            "experiment_date": "2026-07-30",
        },
    ).json()
    second = client.post(
        "/api/records",
        json={
            "project_id": tb_id,
            "pathology_number": "PLAN-002",
            "experiment_date": "2026-07-31",
        },
    ).json()
    completed = client.post(
        "/api/records",
        json={
            "project_id": tb_id,
            "pathology_number": "PLAN-DONE",
            "status": "已完成",
        },
    ).json()

    assert client.put(f"/api/records/{first['id']}/lock", json={"locked": True}).status_code == 200
    blocked = client.post(
        "/api/records/experiment-numbers",
        json={"record_ids": [second["id"], first["id"]], "prefix": "20260801"},
    )
    assert blocked.status_code == 409
    assert client.put(f"/api/records/{first['id']}/lock", json={"locked": False}).status_code == 200
    applied = client.post(
        "/api/records/experiment-numbers",
        json={"record_ids": [second["id"], first["id"]], "prefix": "20260801"},
    )
    assert applied.status_code == 200
    assert [record["experiment_number"] for record in applied.json()] == [
        "20260801-1",
        "20260801-2",
    ]

    refreshed_first = client.get(f"/api/records/{first['id']}").json()
    refreshed_second = client.get(f"/api/records/{second['id']}").json()
    assert refreshed_first["experiment_number"] == "20260801-2"
    assert refreshed_second["experiment_number"] == "20260801-1"
    assert refreshed_first["experiment_date"] == "2026-07-30"
    assert refreshed_second["experiment_date"] == "2026-07-31"
    assert refreshed_first["status"] == refreshed_second["status"] == "待实验"

    changed = client.patch(
        f"/api/records/{second['id']}",
        json={"experiment_number": "MANUAL-1"},
    )
    assert changed.status_code == 200
    assert changed.json()["experiment_number"] == "MANUAL-1"
    assert client.get(f"/api/records/{first['id']}").json()["experiment_date"] == "2026-07-30"
    assert client.get(f"/api/records/{second['id']}").json()["status"] == "待实验"
    rejected = client.post(
        "/api/records/experiment-numbers",
        json={"record_ids": [completed["id"]], "prefix": "CUSTOM"},
    )
    assert rejected.status_code == 409


def test_records_are_listed_oldest_first_and_custom_fields_are_independent(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    custom = client.post(
        f"/api/projects/{tb['id']}/fields",
        json={"label": "DNA浓度", "data_type": "text"},
    ).json()
    first = client.post(
        "/api/records",
        json={
            "project_id": tb["id"],
            "pathology_number": "ORDER-001",
            "values": {custom["id"]: "100ng"},
        },
    ).json()
    second = client.post(
        "/api/records",
        json={"project_id": tb["id"], "pathology_number": "ORDER-002"},
    ).json()
    listed = client.get(f"/api/records?project_id={tb['id']}&limit=1000").json()["items"]
    assert [record["id"] for record in listed] == [first["id"], second["id"]]

    updated = client.patch(
        f"/api/records/{second['id']}",
        json={"values": {custom["id"]: "150ng"}},
    )
    assert updated.status_code == 200
    assert updated.json()["values"][custom["id"]] == "150ng"
    assert client.get(f"/api/records/{first['id']}").json()["values"][custom["id"]] == "100ng"


def test_record_search_supports_project_scopes(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    braf = seeded_projects["BRAFV600E"]
    current_record = client.post(
        "/api/records",
        json={
            "project_id": tb["id"],
            "pathology_number": "SCOPE-CURRENT",
        },
    ).json()
    other_project = client.post(
        "/api/records",
        json={
            "project_id": braf["id"],
            "pathology_number": "SCOPE-OTHER",
        },
    ).json()

    current_result = client.get(
        "/api/records",
        params={
            "scope": "current",
            "project_id": tb["id"],
            "search": "SCOPE-",
        },
    )
    assert [record["id"] for record in current_result.json()["items"]] == [current_record["id"]]

    all_result = client.get(
        "/api/records",
        params={"scope": "all", "search": "SCOPE-OTHER"},
    )
    assert [record["id"] for record in all_result.json()["items"]] == [other_project["id"]]

    selected_result = client.get(
        "/api/records",
        params=[
            ("scope", "selected"),
            ("project_ids", braf["id"]),
            ("search", "SCOPE-OTHER"),
        ],
    )
    assert [record["id"] for record in selected_result.json()["items"]] == [other_project["id"]]


def test_record_operation_undo_redo_updates_and_restores_exact_record_id(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    custom = client.post(
        f"/api/projects/{tb['id']}/fields",
        json={"label": "撤销字段", "data_type": "text"},
    ).json()
    created = client.post(
        "/api/records",
        json={
            "project_id": tb["id"],
            "pathology_number": "HISTORY-001",
            "values": {custom["id"]: "before"},
        },
    ).json()
    before = client.get(f"/api/records/{created['id']}").json()
    updated = client.patch(
        f"/api/records/{created['id']}",
        json={"status": "已完成", "values": {custom["id"]: "after"}},
    )
    assert updated.status_code == 200
    after = updated.json()

    undone = client.post(
        "/api/records/operations/apply",
        json={
            "operation_id": "history-update-1",
            "project_id": tb["id"],
            "direction": "undo",
            "before": [before],
            "after": [after],
        },
    )
    assert undone.status_code == 200
    assert undone.json()["records"][0]["id"] == created["id"]
    assert undone.json()["records"][0]["status"] == "待实验"
    assert undone.json()["records"][0]["values"][custom["id"]] == "before"

    redone = client.post(
        "/api/records/operations/apply",
        json={
            "operation_id": "history-update-1",
            "project_id": tb["id"],
            "direction": "redo",
            "before": [before],
            "after": [after],
        },
    )
    assert redone.status_code == 200
    assert redone.json()["records"][0]["id"] == created["id"]
    assert redone.json()["records"][0]["status"] == "已完成"
    assert redone.json()["records"][0]["values"][custom["id"]] == "after"

    assert client.delete(f"/api/records/{created['id']}").status_code == 204
    restored = client.post(
        "/api/records/operations/apply",
        json={
            "operation_id": "history-delete-1",
            "project_id": tb["id"],
            "direction": "undo",
            "before": [after],
            "after": [],
        },
    )
    assert restored.status_code == 200
    assert restored.json()["records"][0]["id"] == created["id"]
    assert client.get(f"/api/records/{created['id']}").json()["values"][custom["id"]] == "after"

    deleted_again = client.post(
        "/api/records/operations/apply",
        json={
            "operation_id": "history-delete-1",
            "project_id": tb["id"],
            "direction": "redo",
            "before": [after],
            "after": [],
        },
    )
    assert deleted_again.status_code == 200
    assert deleted_again.json()["deleted_ids"] == [created["id"]]
    assert client.get(f"/api/records/{created['id']}").status_code == 404


def test_record_operation_rejects_conflicts_without_partial_changes(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb_id = seeded_projects["TB"]["id"]
    record = client.post(
        "/api/records",
        json={"project_id": tb_id, "pathology_number": "HISTORY-CONFLICT"},
    ).json()
    before = client.get(f"/api/records/{record['id']}").json()
    changed = client.patch(
        f"/api/records/{record['id']}",
        json={"pathology_number": "HISTORY-CONFLICT-EXTERNAL"},
    ).json()
    response = client.post(
        "/api/records/operations/apply",
        json={
            "operation_id": "history-conflict-1",
            "project_id": tb_id,
            "direction": "undo",
            "before": [before],
            "after": [record],
        },
    )
    assert response.status_code == 409
    assert client.get(f"/api/records/{record['id']}").json()["pathology_number"] == changed[
        "pathology_number"
    ]


def test_excel_export_can_be_previewed_and_imported_by_uuid(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    custom = client.post(
        f"/api/projects/{tb['id']}/fields",
        json={"label": "DNA浓度", "data_type": "text"},
    ).json()
    headers = ["_record_id", "_project_id", "日期", "病理号", "实验编号", "状态", "DNA浓度"]
    created_workbook = workbook_bytes(
        client,
        headers,
        [["", tb["id"], "2026-08-01", "IMPORT-001", "IMP-1", "待实验", "100"]],
    )
    preview = client.post(
        "/api/imports/workbook/preview",
        data={"project_id": tb["id"], "sheet_name": "TB"},
        files={"file": ("import.xlsx", created_workbook, XLSX_MEDIA_TYPE)},
    )
    assert preview.status_code == 200
    preview_data = preview.json()
    assert preview_data["errors"] == []
    assert preview_data["create_count"] == 1
    assert preview_data["rows"][0]["values"] == {custom["id"]: "100"}

    row = preview_data["rows"][0]
    committed = client.post(
        "/api/imports/workbook/commit",
        json={
            "project_id": tb["id"],
            "rows": [
                {
                    key: row[key]
                    for key in (
                        "row_number",
                        "record_id",
                        "pathology_number",
                        "status",
                        "experiment_date",
                        "experiment_number",
                        "values",
                    )
                }
            ],
        },
    )
    assert committed.status_code == 200
    record_id = committed.json()["record_ids"][0]

    update_workbook = workbook_bytes(
        client,
        headers,
        [[record_id, tb["id"], "2026-08-02", "IMPORT-001", "IMP-2", "已完成", "200"]],
    )
    update_preview = client.post(
        "/api/imports/workbook/preview",
        data={"project_id": tb["id"], "sheet_name": "TB"},
        files={"file": ("update.xlsx", update_workbook, XLSX_MEDIA_TYPE)},
    ).json()
    assert update_preview["update_count"] == 1
    update_row = update_preview["rows"][0]
    updated = client.post(
        "/api/imports/workbook/commit",
        json={
            "project_id": tb["id"],
            "rows": [
                {
                    key: update_row[key]
                    for key in (
                        "row_number",
                        "record_id",
                        "pathology_number",
                        "status",
                        "experiment_date",
                        "experiment_number",
                        "values",
                    )
                }
            ],
        },
    )
    assert updated.status_code == 200
    assert updated.json() == {"created": 0, "updated": 1, "record_ids": [record_id]}
    refreshed = client.get(f"/api/records/{record_id}").json()
    assert refreshed["status"] == "已完成"
    assert refreshed["experiment_date"] == "2026-08-02"
    assert refreshed["experiment_number"] == "IMP-2"
    assert refreshed["values"][custom["id"]] == "200"


def test_bulk_delete_by_ledger_date_requires_fresh_preview_and_unlocked_records(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb_id = seeded_projects["TB"]["id"]
    first = client.post(
        "/api/records",
        json={
            "project_id": tb_id,
            "pathology_number": "DELETE-001",
            "experiment_date": "2026-08-01",
        },
    ).json()
    second = client.post(
        "/api/records",
        json={
            "project_id": tb_id,
            "pathology_number": "DELETE-002",
            "experiment_date": "2026-08-02",
        },
    ).json()
    assert client.put(f"/api/records/{second['id']}/lock", json={"locked": True}).status_code == 200
    delete_filter = {
        "project_id": tb_id,
        "date_field": "experiment_date",
        "start_date": "2026-08-01",
        "end_date": "2026-08-02",
    }
    preview = client.post("/api/records/bulk-delete/preview", json=delete_filter).json()
    assert preview["total"] == 2
    assert preview["locked_count"] == 1
    blocked = client.post(
        "/api/records/bulk-delete/execute",
        json={"filter": delete_filter, "expected_record_ids": preview["record_ids"]},
    )
    assert blocked.status_code == 409

    assert client.put(f"/api/records/{second['id']}/lock", json={"locked": False}).status_code == 200
    deleted = client.post(
        "/api/records/bulk-delete/execute",
        json={"filter": delete_filter, "expected_record_ids": preview["record_ids"]},
    )
    assert deleted.status_code == 200
    deleted_payload = deleted.json()
    assert deleted_payload["deleted"] == 2
    assert {record["id"] for record in deleted_payload["deleted_records"]} == {
        first["id"],
        second["id"],
    }
    assert client.get(f"/api/records/{first['id']}").status_code == 404
    assert client.get(f"/api/records/{second['id']}").status_code == 404


def test_direct_print_uses_temporary_docx_and_document_download_is_removed(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    pathology_field = next(
        field for field in tb["fields"] if field["system_key"] == "pathology_number"
    )
    record = client.post(
        "/api/records",
        json={"project_id": tb["id"], "pathology_number": "REPORT-001"},
    ).json()
    assert client.patch(
        f"/api/records/{record['id']}",
        json={"experiment_number": "RPT-1"},
    ).status_code == 200

    uploaded = client.post(
        "/api/report-templates",
        data={"project_id": tb["id"], "name": "直接打印模板"},
        files={"file": ("report.docx", minimal_docx(), DOCX_MEDIA_TYPE)},
    )
    assert uploaded.status_code == 201
    version = uploaded.json()["versions"][0]
    mapped = client.put(
        f"/api/report-template-versions/{version['id']}/mappings",
        json={
            "mappings": [
                {
                    "placeholder": "case_no",
                    "source_type": "field",
                    "field_id": pathology_field["id"],
                },
                {
                    "placeholder": "experiment_no",
                    "source_type": "experiment_number",
                },
            ]
        },
    )
    assert mapped.status_code == 200

    printed = client.post(
        "/api/reports/print",
        json={
            "template_version_id": version["id"],
            "printer_name": "测试打印机",
            "items": [{"project_record_id": record["id"]}],
            "print_engine": "auto",
        },
    )
    assert printed.status_code == 200
    assert printed.json() == {
        "printer_name": "测试打印机",
        "printed_count": 1,
        "print_engine": "word",
    }
    printer = client.app.state.printer_service
    assert "REPORT-001" in printer.printed_document_xml[0]
    assert "RPT-1" in printer.printed_document_xml[0]
    assert list(client.app.state.settings.report_work_dir.iterdir()) == []
    assert "/api/reports/documents" not in client.get("/openapi.json").json()["paths"]


def test_workbook_export_hides_metadata_columns(client: TestClient) -> None:
    content = workbook_bytes(
        client,
        ["_record_id", "_project_id", "病理号"],
        [["record-1", "project-1", "25-99999"]],
    )
    assert content.startswith(b"PK")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        worksheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
    assert '<col min="1" max="1"' in worksheet
    assert '<col min="2" max="2"' in worksheet
    assert worksheet.count('hidden="1"') == 2
    assert "25-99999" in worksheet


def test_audit_logs_support_new_experiment_and_import_labels(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    record = client.post(
        "/api/records",
        json={"project_id": seeded_projects["TB"]["id"], "pathology_number": "AUDIT-001"},
    ).json()
    updated = client.post(
        "/api/records/experiment-numbers",
        json={"record_ids": [record["id"]], "prefix": "AUDIT"},
    )
    assert updated.status_code == 200
    by_label = client.get("/api/audit-logs?search=回写实验编号&limit=50")
    assert any(log["entity_id"] == record["id"] for log in by_label.json()["items"])
    empty = client.get("/api/audit-logs?search=完全不存在的关键词&limit=50").json()
    assert empty["items"] == []
    assert empty["total"] == 0


def test_records_can_be_highlighted_individually_or_in_batch(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    first = client.post(
        "/api/records",
        json={"project_id": project_id, "pathology_number": "HIGHLIGHT-001"},
    ).json()
    second = client.post(
        "/api/records",
        json={"project_id": project_id, "pathology_number": "HIGHLIGHT-002"},
    ).json()

    batch = client.put(
        "/api/records/highlight",
        json={
            "record_ids": [first["id"], second["id"]],
            "highlight_color": "#FFF2CC",
        },
    )
    assert batch.status_code == 200
    assert [record["highlight_color"] for record in batch.json()] == ["#fff2cc", "#fff2cc"]

    field_ids = [field["id"] for field in seeded_projects["TB"]["fields"][:2]]
    cells = client.put(
        "/api/records/cell-highlights",
        json={
            "cells": [
                {"record_id": first["id"], "field_id": field_ids[0]},
                {"record_id": second["id"], "field_id": field_ids[1]},
            ],
            "highlight_color": "#D9EAD3",
        },
    )
    assert cells.status_code == 200
    highlighted_by_id = {record["id"]: record for record in cells.json()}
    assert highlighted_by_id[first["id"]]["cell_highlight_colors"] == {field_ids[0]: "#d9ead3"}
    assert highlighted_by_id[second["id"]]["cell_highlight_colors"] == {field_ids[1]: "#d9ead3"}

    clear_cells = client.put(
        "/api/records/cell-highlights",
        json={
            "cells": [{"record_id": first["id"], "field_id": field_ids[0]}],
            "highlight_color": None,
        },
    )
    assert clear_cells.status_code == 200
    assert field_ids[0] not in clear_cells.json()[0]["cell_highlight_colors"]
    assert clear_cells.json()[0]["cell_highlight_colors"] == {}
    assert clear_cells.json()[0]["id"] == first["id"]

    locked = client.put(f"/api/records/{first['id']}/lock", json={"locked": True})
    assert locked.status_code == 200
    clear = client.put(
        "/api/records/highlight",
        json={"record_ids": [first["id"]], "highlight_color": None},
    )
    assert clear.status_code == 200
    assert clear.json()[0]["highlight_color"] is None

    invalid = client.put(
        "/api/records/highlight",
        json={"record_ids": [second["id"]], "highlight_color": "yellow"},
    )
    assert invalid.status_code == 422
