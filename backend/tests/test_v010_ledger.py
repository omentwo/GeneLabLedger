from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.database import Database


def project_fields(project: dict) -> dict[str, dict]:
    return {field["system_key"] or field["label"]: field for field in project["fields"]}


def create_custom_field(
    client: TestClient,
    project_id: str,
    *,
    label: str,
    data_type: str = "text",
    validation_mode: str = "suggestion",
    validation_rules: dict | None = None,
    options: list[str] | None = None,
) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/fields",
        json={
            "label": label,
            "data_type": data_type,
            "validation_mode": validation_mode,
            "validation_rules": validation_rules or {},
            "options": options or [],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_record(
    client: TestClient,
    project_id: str,
    pathology_number: str,
    *,
    values: dict[str, str] | None = None,
    status: str = "待实验",
    experiment_date: str | None = None,
) -> dict:
    response = client.post(
        "/api/records",
        json={
            "project_id": project_id,
            "pathology_number": pathology_number,
            "status": status,
            "experiment_date": experiment_date,
            "values": values or {},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_strict_field_validation_is_shared_by_create_update_and_preview(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    concentration = create_custom_field(
        client,
        project_id,
        label="DNA浓度",
        data_type="number",
        validation_mode="strict",
        validation_rules={"required": True, "min_number": 10, "decimal_places": 1},
    )

    missing = client.post(
        "/api/records",
        json={"project_id": project_id, "pathology_number": "V-EMPTY"},
    )
    assert missing.status_code == 422
    below_minimum = client.post(
        "/api/records",
        json={
            "project_id": project_id,
            "pathology_number": "V-LOW",
            "values": {concentration["id"]: "9"},
        },
    )
    assert below_minimum.status_code == 422

    record = create_record(
        client,
        project_id,
        "V-OK",
        values={concentration["id"]: "15.0"},
    )
    rejected_update = client.patch(
        f"/api/records/{record['id']}",
        json={"values": {concentration["id"]: "invalid"}},
    )
    assert rejected_update.status_code == 422
    assert client.get(f"/api/records/{record['id']}").json()["values"][concentration["id"]] == "15.0"

    validation = client.post(
        "/api/records/validate-new",
        json={
            "project_id": project_id,
            "pathology_number": "V-PREVIEW",
            "values": {concentration["id"]: "10.123"},
        },
    )
    assert validation.status_code == 200
    assert any(issue["severity"] == "error" for issue in validation.json()["issues"])


def test_warning_requires_confirmation_and_stale_preview_is_rejected(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    field = create_custom_field(
        client,
        project_id,
        label="OD",
        data_type="number",
        validation_mode="warning",
        validation_rules={"min_number": 1},
    )
    record = create_record(client, project_id, "WARN-1", values={field["id"]: "2"})

    preview = client.post(
        "/api/records/cell-batches/preview",
        json={
            "project_id": project_id,
            "changes": [
                {
                    "record_id": record["id"],
                    "field_id": field["id"],
                    "value": "0.5",
                    "expected_value": "2",
                }
            ],
        },
    )
    assert preview.status_code == 200
    body = preview.json()
    assert [issue["severity"] for issue in body["issues"]] == ["warning"]
    assert client.post(
        "/api/records/cell-batches/commit",
        json={"token": body["token"], "accept_warnings": False},
    ).status_code == 409
    committed = client.post(
        "/api/records/cell-batches/commit",
        json={"token": body["token"], "accept_warnings": True},
    )
    assert committed.status_code == 200
    assert committed.json()["changes"][0] == {
        "record_id": record["id"],
        "field_id": field["id"],
        "before": "2",
        "after": "0.5",
    }

    stale_preview = client.post(
        "/api/records/cell-batches/preview",
        json={
            "project_id": project_id,
            "changes": [
                {
                    "record_id": record["id"],
                    "field_id": field["id"],
                    "value": "3",
                    "expected_value": "0.5",
                }
            ],
        },
    ).json()
    assert client.patch(
        f"/api/records/{record['id']}",
        json={"values": {field["id"]: "4"}},
    ).status_code == 200
    conflict = client.post(
        "/api/records/cell-batches/commit",
        json={"token": stale_preview["token"], "accept_warnings": True},
    )
    assert conflict.status_code == 409


def test_new_record_preview_rejects_unknown_fields_and_duplicate_experiment_number(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    created = client.post(
        "/api/records",
        json={
            "project_id": project_id,
            "pathology_number": "PREVIEW-NUMBER-1",
            "experiment_number": "EXP-PREVIEW-1",
        },
    )
    assert created.status_code == 201, created.text

    unknown = client.post(
        "/api/records/validate-new",
        json={
            "project_id": project_id,
            "pathology_number": "PREVIEW-UNKNOWN",
            "values": {"not-a-project-field": "value"},
        },
    )
    assert unknown.status_code == 422

    duplicate = client.post(
        "/api/records/validate-new",
        json={
            "project_id": project_id,
            "pathology_number": "PREVIEW-NUMBER-2",
            "experiment_number": "EXP-PREVIEW-1",
        },
    )
    assert duplicate.status_code == 200
    assert any(
        issue["severity"] == "error" and "实验编号" in issue["message"]
        for issue in duplicate.json()["issues"]
    )


def test_mixed_cell_and_new_record_batch_is_atomic_and_undoable(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project = seeded_projects["TB"]
    project_id = project["id"]
    custom = create_custom_field(
        client,
        project_id,
        label="结果",
        validation_mode="strict",
        validation_rules={"required": True, "max_length": 20},
    )
    existing = create_record(
        client,
        project_id,
        "BATCH-OLD",
        values={custom["id"]: "旧值"},
    )
    locked = create_record(
        client,
        project_id,
        "BATCH-LOCKED",
        values={custom["id"]: "锁定值"},
    )
    assert client.put(f"/api/records/{locked['id']}/lock", json={"locked": True}).status_code == 200

    preview = client.post(
        "/api/records/cell-batches/preview",
        json={
            "project_id": project_id,
            "changes": [
                {
                    "record_id": existing["id"],
                    "field_id": custom["id"],
                    "value": "新值",
                    "expected_value": "旧值",
                },
                {
                    "record_id": locked["id"],
                    "field_id": custom["id"],
                    "value": "不能写入",
                    "expected_value": "锁定值",
                },
            ],
            "new_records": [
                {
                    "client_id": "draft-1",
                    "pathology_number": "BATCH-NEW",
                    "status": "待实验",
                    "experiment_date": "2026-08-12",
                    "experiment_number": None,
                    "values": {custom["id"]: "新增值"},
                }
            ],
        },
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["skipped_locked"] == 1
    committed = client.post(
        "/api/records/cell-batches/commit",
        json={
            "token": preview.json()["token"],
            "accept_warnings": False,
            "include_snapshots": True,
        },
    )
    assert committed.status_code == 200, committed.text
    result = committed.json()
    assert len(result["created_record_ids"]) == 1
    assert len(result["before"]) == 1
    assert len(result["after"]) == 2
    assert client.get(f"/api/records/{existing['id']}").json()["values"][custom["id"]] == "新值"
    assert client.get(f"/api/records/{locked['id']}").json()["values"][custom["id"]] == "锁定值"

    undo = client.post(
        "/api/records/operations/apply",
        json={
            "operation_id": "mixed-batch-undo",
            "project_id": project_id,
            "direction": "undo",
            "before": result["before"],
            "after": result["after"],
        },
    )
    assert undo.status_code == 200, undo.text
    assert result["created_record_ids"][0] in undo.json()["deleted_ids"]
    assert client.get(f"/api/records/{existing['id']}").json()["values"][custom["id"]] == "旧值"

    invalid = client.post(
        "/api/records/cell-batches/preview",
        json={
            "project_id": project_id,
            "changes": [
                {
                    "record_id": existing["id"],
                    "field_id": custom["id"],
                    "value": "",
                    "expected_value": "旧值",
                }
            ],
            "new_records": [
                {
                    "client_id": "draft-invalid",
                    "pathology_number": "SHOULD-NOT-EXIST",
                    "status": "待实验",
                    "experiment_date": None,
                    "experiment_number": None,
                    "values": {custom["id"]: "有效"},
                }
            ],
        },
    ).json()
    assert any(issue["severity"] == "error" for issue in invalid["issues"])
    blocked = client.post(
        "/api/records/cell-batches/commit",
        json={"token": invalid["token"], "accept_warnings": True},
    )
    assert blocked.status_code == 422
    ids = client.post(
        "/api/records/query/ids",
        json={
            "project_id": project_id,
            "search": "SHOULD-NOT-EXIST",
            "field_filters": [],
            "limit": 1,
            "offset": 0,
        },
    ).json()
    assert ids == {"record_ids": [], "total": 0}


def test_dynamic_query_pagination_sort_filters_and_all_ids(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project = seeded_projects["TB"]
    project_id = project["id"]
    number = create_custom_field(client, project_id, label="定量", data_type="number")
    for pathology, value, experiment_date in [
        ("QUERY-2", "2", "2026-06-01"),
        ("QUERY-10", "10", "2026-07-01"),
        ("QUERY-5", "5", "2026-08-01"),
    ]:
        create_record(
            client,
            project_id,
            pathology,
            values={number["id"]: value},
            experiment_date=experiment_date,
        )

    payload = {
        "project_id": project_id,
        "search": "QUERY-",
        "field_filters": [
            {"field_id": number["id"], "operator": "number_between", "start": "2", "end": "10"}
        ],
        "sort": {"field_id": number["id"], "direction": "desc"},
        "limit": 2,
        "offset": 0,
    }
    first_page = client.post("/api/records/query", json=payload)
    assert first_page.status_code == 200, first_page.text
    assert first_page.json()["total"] == 3
    assert [item["pathology_number"] for item in first_page.json()["items"]] == [
        "QUERY-10",
        "QUERY-5",
    ]
    second_page = client.post("/api/records/query", json={**payload, "offset": 2}).json()
    assert [item["pathology_number"] for item in second_page["items"]] == ["QUERY-2"]
    all_ids = client.post("/api/records/query/ids", json={**payload, "limit": 1}).json()
    assert all_ids["total"] == 3
    assert len(all_ids["record_ids"]) == 3


def test_named_views_are_project_scoped_defaulted_and_use_stable_field_ids(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project = seeded_projects["TB"]
    project_id = project["id"]
    fields = project_fields(project)
    custom = create_custom_field(client, project_id, label="视图字段")
    created = client.post(
        f"/api/projects/{project_id}/view-presets",
        json={
            "name": "录入视图",
            "is_default": True,
            "state": {
                "columns": [
                    {
                        "field_id": fields["pathology_number"]["id"],
                        "width": 200,
                        "hidden": False,
                        "pinned": True,
                    },
                    {
                        "field_id": custom["id"],
                        "width": 160,
                        "hidden": False,
                        "pinned": True,
                    },
                ],
                "frozen_until_field_id": custom["id"],
                "sort": {"field_id": custom["id"], "direction": "asc"},
                "filters": {custom["id"]: {"kind": "text", "value": "阳性"}},
            },
        },
    )
    assert created.status_code == 201, created.text
    view = created.json()
    pathology_column = next(
        column
        for column in view["state"]["columns"]
        if column["field_id"] == fields["pathology_number"]["id"]
    )
    assert pathology_column["pinned"] is False
    assert len(view["state"]["columns"]) == len(project["fields"]) + 1

    second = client.post(
        f"/api/projects/{project_id}/view-presets",
        json={"name": "复核视图", "is_default": True, "state": {"columns": []}},
    )
    assert second.status_code == 201
    views = client.get(f"/api/projects/{project_id}/view-presets").json()
    assert [item["name"] for item in views if item["is_default"]] == ["复核视图"]

    assert client.patch(
        f"/api/projects/fields/{custom['id']}",
        json={"label": "改名后字段"},
    ).status_code == 200
    unchanged = client.get(f"/api/projects/{project_id}/view-presets").json()
    first_view = next(item for item in unchanged if item["id"] == view["id"])
    assert first_view["state"]["sort"]["field_id"] == custom["id"]
    assert client.delete(f"/api/projects/view-presets/{view['id']}").status_code == 204


def test_desktop_schema_upgrade_creates_backup_before_v010_changes(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE field_definitions (id VARCHAR(36) PRIMARY KEY)")
        connection.commit()

    database = Database(f"sqlite:///{database_path.as_posix()}")
    try:
        database.create_all()
    finally:
        database.dispose()

    backups = list((tmp_path / "backups").glob("ledger-before-v0.10.0-*.db"))
    assert len(backups) == 1
    with sqlite3.connect(database_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(field_definitions)")}
        view_exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_view_presets'"
        ).fetchone()
    assert {"validation_mode", "validation_rules"}.issubset(columns)
    assert view_exists == (1,)
    with sqlite3.connect(backups[0]) as connection:
        backup_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(field_definitions)")
        }
    assert backup_columns == {"id"}
