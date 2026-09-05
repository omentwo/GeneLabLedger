from __future__ import annotations

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.database import Database
from app.services import cell_batches


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
    default_value: str | None = None,
) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/fields",
        json={
            "label": label,
            "data_type": data_type,
            "validation_mode": validation_mode,
            "validation_rules": validation_rules or {},
            "options": options or [],
            "default_value": default_value,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_field_defaults_only_apply_to_future_records_and_labels_are_unique(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    reagent_batch = create_custom_field(
        client,
        project_id,
        label="实验试剂批号",
    )
    existing = create_record(client, project_id, "DEFAULT-OLD")

    updated = client.patch(
        f"/api/projects/fields/{reagent_batch['id']}",
        json={"default_value": "20260812"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["default_value"] == "20260812"

    created = create_record(client, project_id, "DEFAULT-NEW")
    assert created["values"][reagent_batch["id"]] == "20260812"
    explicitly_blank = create_record(
        client,
        project_id,
        "DEFAULT-BLANK",
        values={reagent_batch["id"]: ""},
    )
    assert reagent_batch["id"] not in explicitly_blank["values"]
    assert reagent_batch["id"] not in client.get(f"/api/records/{existing['id']}").json()["values"]

    duplicate = client.post(
        f"/api/projects/{project_id}/fields",
        json={"label": "实验试剂批号", "data_type": "text"},
    )
    assert duplicate.status_code == 409
    other = create_custom_field(client, project_id, label="其他字段")
    renamed = client.patch(
        f"/api/projects/fields/{other['id']}",
        json={"label": "实验试剂批号"},
    )
    assert renamed.status_code == 409


def test_core_field_visibility_can_change_without_allowing_a_type_change(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    pathology = project_fields(seeded_projects["TB"])["pathology_number"]

    hidden = client.patch(
        f"/api/projects/fields/{pathology['id']}",
        json={"data_type": pathology["data_type"], "hidden": True},
    )
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["hidden"] is True
    assert hidden.json()["data_type"] == pathology["data_type"]

    shown = client.patch(
        f"/api/projects/fields/{pathology['id']}",
        json={"hidden": False},
    )
    assert shown.status_code == 200, shown.text
    assert shown.json()["hidden"] is False

    rejected = client.patch(
        f"/api/projects/fields/{pathology['id']}",
        json={"data_type": "number"},
    )
    assert rejected.status_code == 409


def test_field_labels_cannot_conflict_with_import_identifiers(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    for label in ("status", "experiment_number", "_record_id", "_project_id"):
        rejected = client.post(
            f"/api/projects/{project_id}/fields",
            json={"label": label, "data_type": "text"},
        )
        assert rejected.status_code == 409, rejected.text

    custom = create_custom_field(client, project_id, label="可重命名字段")
    renamed = client.patch(
        f"/api/projects/fields/{custom['id']}",
        json={"label": "caseId"},
    )
    assert renamed.status_code == 409, renamed.text


def test_invalid_field_default_and_malformed_core_template_are_rejected(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    invalid_default = client.post(
        f"/api/projects/{project_id}/fields",
        json={
            "label": "试剂类型",
            "data_type": "select",
            "options": ["A", "B"],
            "default_value": "C",
        },
    )
    assert invalid_default.status_code == 422

    template_response = client.post(
        "/api/ledger-templates",
        json={"name": "核心字段保护模板", "source_project_id": project_id},
    )
    assert template_response.status_code == 201, template_response.text
    template = template_response.json()
    legacy_without_block = [field for field in template["fields"] if field["system_key"] != "block_number"]
    upgraded = client.patch(
        f"/api/ledger-templates/{template['id']}",
        json={"fields": legacy_without_block},
    )
    assert upgraded.status_code == 200, upgraded.text
    template = upgraded.json()
    assert any(field["system_key"] == "block_number" for field in template["fields"])

    missing_core = [
        field
        for field in template["fields"]
        if field["system_key"] != "experiment_number"
    ]
    rejected = client.patch(
        f"/api/ledger-templates/{template['id']}",
        json={"fields": missing_core},
    )
    assert rejected.status_code == 422

    changed_core = [dict(field) for field in template["fields"]]
    status_field = next(field for field in changed_core if field["system_key"] == "status")
    status_field["data_type"] = "text"
    rejected = client.patch(
        f"/api/ledger-templates/{template['id']}",
        json={"fields": changed_core},
    )
    assert rejected.status_code == 422

    conflicting_names = [dict(field) for field in template["fields"]]
    conflicting_names.append(
        {
            "key": "custom_template_status",
            "label": "status",
            "data_type": "text",
            "sort_order": len(conflicting_names),
        }
    )
    rejected = client.patch(
        f"/api/ledger-templates/{template['id']}",
        json={"fields": conflicting_names},
    )
    assert rejected.status_code == 422


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


def test_cell_batch_preview_token_cannot_be_committed_concurrently(
    client: TestClient,
    seeded_projects: dict[str, dict],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = seeded_projects["TB"]["id"]
    preview = client.post(
        "/api/records/cell-batches/preview",
        json={
            "project_id": project_id,
            "changes": [],
            "new_records": [
                {
                    "client_id": "token-race",
                    "pathology_number": "TOKEN-RACE-ONLY-ONCE",
                }
            ],
        },
    )
    assert preview.status_code == 200, preview.text
    token = preview.json()["token"]

    entered = threading.Event()
    release = threading.Event()
    original = cell_batches._field_and_record_maps

    def block_after_claim(*args: object, **kwargs: object) -> object:
        entered.set()
        if not release.wait(timeout=5):
            raise TimeoutError("commit test did not release the claimed token")
        return original(*args, **kwargs)

    monkeypatch.setattr(cell_batches, "_field_and_record_maps", block_after_claim)
    payload = {"token": token, "accept_warnings": False}
    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(
            client.post,
            "/api/records/cell-batches/commit",
            json=payload,
        )
        assert entered.wait(timeout=5)
        duplicate = client.post("/api/records/cell-batches/commit", json=payload)
        release.set()
        first = first_future.result(timeout=5)

    assert first.status_code == 200, first.text
    assert duplicate.status_code == 409, duplicate.text
    assert "正在提交" in duplicate.json()["detail"]
    replay = client.post("/api/records/cell-batches/commit", json=payload)
    assert replay.status_code == 410, replay.text
    records = client.get(
        "/api/records",
        params={"project_id": project_id, "limit": 1000},
    ).json()["items"]
    assert [record["pathology_number"] for record in records].count("TOKEN-RACE-ONLY-ONCE") == 1


def test_new_record_preview_rejects_unknown_fields_and_allows_duplicate_experiment_number(
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
    assert not any("实验编号" in issue["message"] for issue in duplicate.json()["issues"])
    created_duplicate = client.post(
        "/api/records",
        json={
            "project_id": project_id,
            "pathology_number": "PREVIEW-NUMBER-2",
            "experiment_number": "EXP-PREVIEW-1",
        },
    )
    assert created_duplicate.status_code == 201, created_duplicate.text


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
    assert client.patch(
        f"/api/records/{existing['id']}",
        json={"experiment_number": "BATCH-DUPLICATE"},
    ).status_code == 200
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
                    "experiment_number": "BATCH-DUPLICATE",
                    "values": {custom["id"]: "新增值"},
                },
                {
                    "client_id": "draft-2",
                    "pathology_number": "BATCH-NEW-2",
                    "status": "待实验",
                    "experiment_date": "2026-08-13",
                    "experiment_number": "BATCH-DUPLICATE",
                    "values": {custom["id"]: "新增值2"},
                },
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
    assert len(result["created_record_ids"]) == 2
    assert len(result["before"]) == 1
    assert len(result["after"]) == 3
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
    assert set(result["created_record_ids"]).issubset(undo.json()["deleted_ids"])
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


def test_cell_batch_preserves_order_for_multiple_anchored_drafts(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    anchor = create_record(client, project_id, "PASTE-ANCHOR")
    tail = create_record(client, project_id, "PASTE-TAIL")
    preview = client.post(
        "/api/records/cell-batches/preview",
        json={
            "project_id": project_id,
            "changes": [],
            "new_records": [
                {
                    "client_id": "draft-1",
                    "pathology_number": "PASTE-001",
                    "insert_after_record_id": anchor["id"],
                },
                {
                    "client_id": "draft-2",
                    "pathology_number": "PASTE-002",
                    "insert_after_record_id": anchor["id"],
                },
            ],
        },
    )
    assert preview.status_code == 200, preview.text
    committed = client.post(
        "/api/records/cell-batches/commit",
        json={"token": preview.json()["token"], "include_snapshots": True},
    )
    assert committed.status_code == 200, committed.text
    created_ids = committed.json()["created_record_ids"]

    listed = client.get(f"/api/records?project_id={project_id}&limit=1000").json()["items"]
    assert [record["id"] for record in listed] == [anchor["id"], *created_ids, tail["id"]]
    assert [record["position"] for record in listed] == [1, 2, 3, 4]


def test_cell_batch_preserves_order_for_multiple_drafts_before_an_anchor(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    head = create_record(client, project_id, "PASTE-BEFORE-HEAD")
    anchor = create_record(client, project_id, "PASTE-BEFORE-ANCHOR")
    preview = client.post(
        "/api/records/cell-batches/preview",
        json={
            "project_id": project_id,
            "changes": [],
            "new_records": [
                {
                    "client_id": "draft-before-1",
                    "pathology_number": "PASTE-BEFORE-001",
                    "insert_before_record_id": anchor["id"],
                },
                {
                    "client_id": "draft-before-2",
                    "pathology_number": "PASTE-BEFORE-002",
                    "insert_before_record_id": anchor["id"],
                },
            ],
        },
    )
    assert preview.status_code == 200, preview.text
    committed = client.post(
        "/api/records/cell-batches/commit",
        json={"token": preview.json()["token"], "include_snapshots": True},
    )
    assert committed.status_code == 200, committed.text
    created_ids = committed.json()["created_record_ids"]

    listed = client.get(f"/api/records?project_id={project_id}&limit=1000").json()["items"]
    assert [record["id"] for record in listed] == [head["id"], *created_ids, anchor["id"]]
    assert [record["position"] for record in listed] == [1, 2, 3, 4]


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


def test_batch_create_fields_retains_existing_headers_and_is_atomic(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project = seeded_projects["TB"]
    project_id = project["id"]
    fields = project_fields(project)
    response = client.post(
        f"/api/projects/{project_id}/fields/batch",
        json={"labels": ["病理号", "批量结果", "批量备注"]},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert [field["id"] for field in payload["retained"]] == [
        fields["pathology_number"]["id"]
    ]
    assert [field["label"] for field in payload["created"]] == ["批量结果", "批量备注"]
    assert all(field["data_type"] == "text" for field in payload["created"])
    assert all(field["width"] == 120 for field in payload["created"])
    assert all(field["hidden"] is False for field in payload["created"])
    assert all(field["validation_mode"] == "suggestion" for field in payload["created"])
    assert payload["created"][1]["sort_order"] == payload["created"][0]["sort_order"] + 1

    retained_only = client.post(
        f"/api/projects/{project_id}/fields/batch",
        json={"labels": ["病理号", "批量结果", "批量备注"]},
    )
    assert retained_only.status_code == 200, retained_only.text
    assert [field["label"] for field in retained_only.json()["retained"]] == [
        "病理号",
        "批量结果",
        "批量备注",
    ]
    assert retained_only.json()["created"] == []

    conflict = client.post(
        f"/api/projects/{project_id}/fields/batch",
        json={"labels": ["不应写入", "_record_id"]},
    )
    assert conflict.status_code == 409
    refreshed = client.get("/api/projects").json()
    refreshed_project = next(item for item in refreshed if item["id"] == project_id)
    assert "不应写入" not in {field["label"] for field in refreshed_project["fields"]}

    duplicate = client.post(
        f"/api/projects/{project_id}/fields/batch",
        json={"labels": ["重复", "重复"]},
    )
    assert duplicate.status_code == 422
    too_many = client.post(
        f"/api/projects/{project_id}/fields/batch",
        json={"labels": [f"字段-{index}" for index in range(101)]},
    )
    assert too_many.status_code == 422

    retired_views = client.get(f"/api/projects/{project_id}/views")
    assert retired_views.status_code == 404


def test_batch_create_fields_rolls_back_when_a_late_step_fails(
    client: TestClient,
    seeded_projects: dict[str, dict],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api import projects as projects_api

    project_id = seeded_projects["TB"]["id"]
    audit_calls = 0

    def fail_second_audit(*_args: object, **_kwargs: object) -> None:
        nonlocal audit_calls
        audit_calls += 1
        if audit_calls == 2:
            raise RuntimeError("forced batch audit failure")

    monkeypatch.setattr(projects_api, "audit", fail_second_audit)
    with pytest.raises(RuntimeError, match="forced batch audit failure"):
        client.post(
            f"/api/projects/{project_id}/fields/batch",
            json={"labels": ["事务字段一", "事务字段二"]},
        )

    refreshed = client.get("/api/projects").json()
    project = next(item for item in refreshed if item["id"] == project_id)
    labels = {field["label"] for field in project["fields"]}
    assert "事务字段一" not in labels
    assert "事务字段二" not in labels


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
    assert view_exists is None
    with sqlite3.connect(backups[0]) as connection:
        backup_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(field_definitions)")
        }
    assert backup_columns == {"id"}


def test_desktop_schema_upgrade_backfills_record_positions(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy-records.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "CREATE TABLE project_records ("
            "id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, created_at DATETIME NOT NULL"
            ")"
        )
        connection.executemany(
            "INSERT INTO project_records (id, project_id, created_at) VALUES (?, ?, ?)",
            [
                ("later", "project-1", "2026-08-02 00:00:00"),
                ("other", "project-2", "2026-08-01 00:00:00"),
                ("earlier", "project-1", "2026-08-01 00:00:00"),
            ],
        )
        connection.commit()

    database = Database(f"sqlite:///{database_path.as_posix()}")
    try:
        database.backup_sqlite_before_schema_upgrade()
        database._migrate_record_positions()
    finally:
        database.dispose()

    backups = list((tmp_path / "backups").glob("ledger-before-v0.10.1-*.db"))
    assert len(backups) == 1
    with sqlite3.connect(database_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(project_records)")}
        positions = connection.execute(
            "SELECT id, position FROM project_records ORDER BY project_id, position"
        ).fetchall()
        indexes = {row[1] for row in connection.execute("PRAGMA index_list(project_records)")}
    assert "position" in columns
    assert positions == [("earlier", 1), ("later", 2), ("other", 1)]
    assert "ix_record_project_position" in indexes


def test_desktop_schema_upgrade_adds_optional_block_number(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy-block-number.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "CREATE TABLE project_records ("
            "id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, position INTEGER NOT NULL"
            ")"
        )
        connection.execute(
            "INSERT INTO project_records (id, project_id, position) VALUES ('record-1', 'project-1', 1)"
        )
        connection.commit()

    database = Database(f"sqlite:///{database_path.as_posix()}")
    try:
        database.backup_sqlite_before_schema_upgrade()
        database._migrate_record_block_number()
    finally:
        database.dispose()

    backups = list((tmp_path / "backups").glob("ledger-before-v0.10.4-*.db"))
    assert len(backups) == 1
    with sqlite3.connect(database_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(project_records)")}
        indexes = {row[1] for row in connection.execute("PRAGMA index_list(project_records)")}
        block_number = connection.execute(
            "SELECT block_number FROM project_records WHERE id = 'record-1'"
        ).fetchone()
    assert "block_number" in columns
    assert "ix_project_records_block_number" in indexes
    assert block_number == (None,)


def test_desktop_schema_upgrade_backs_up_and_removes_retired_ledger_views(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "legacy-ledger-views.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE ledger_view_presets (id VARCHAR(36) PRIMARY KEY)")
        connection.execute("INSERT INTO ledger_view_presets (id) VALUES ('view-1')")
        connection.commit()

    database = Database(f"sqlite:///{database_path.as_posix()}")
    try:
        database.create_all()
    finally:
        database.dispose()

    backups = list((tmp_path / "backups").glob("ledger-before-view-removal-*.db"))
    assert len(backups) == 1
    with sqlite3.connect(database_path) as connection:
        view_exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_view_presets'"
        ).fetchone()
    assert view_exists is None
    with sqlite3.connect(backups[0]) as connection:
        preserved = connection.execute("SELECT id FROM ledger_view_presets").fetchall()
    assert preserved == [("view-1",)]

    second_start = Database(f"sqlite:///{database_path.as_posix()}")
    try:
        second_start.create_all()
    finally:
        second_start.dispose()
    assert len(list((tmp_path / "backups").glob("ledger-before-view-removal-*.db"))) == 1


@pytest.mark.parametrize(
    ("constraint_sql", "database_name"),
    [
        (
            "CONSTRAINT uq_record_experiment_number UNIQUE (experiment_number), ",
            "legacy-global-number.db",
        ),
        (
            "CONSTRAINT uq_record_project_experiment_number "
            "UNIQUE (project_id, experiment_number), ",
            "legacy-project-number.db",
        ),
    ],
)
def test_experiment_number_upgrade_removes_uniqueness_and_preserves_foreign_keys(
    tmp_path: Path,
    constraint_sql: str,
    database_name: str,
) -> None:
    database_path = tmp_path / database_name
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("CREATE TABLE projects (id VARCHAR(36) PRIMARY KEY)")
        connection.execute(
            "CREATE TABLE project_records ("
            "id VARCHAR(36) PRIMARY KEY, "
            "project_id VARCHAR(36) NOT NULL, "
            "status VARCHAR(40) NOT NULL, "
            "experiment_date DATE, "
            "locked BOOLEAN NOT NULL, "
            "created_at DATETIME NOT NULL, "
            "updated_at DATETIME NOT NULL, "
            "experiment_number VARCHAR(80), "
            "report_generated BOOLEAN NOT NULL DEFAULT 0, "
            "pathology_number VARCHAR(160) NOT NULL, "
            f"{constraint_sql}"
            "FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT"
            ")"
        )
        connection.execute(
            "CREATE TABLE record_values ("
            "id VARCHAR(36) PRIMARY KEY, "
            "record_id VARCHAR(36) NOT NULL, "
            "value_text TEXT NOT NULL, "
            "FOREIGN KEY(record_id) REFERENCES project_records(id) ON DELETE CASCADE"
            ")"
        )
        connection.executemany("INSERT INTO projects (id) VALUES (?)", [("p1",), ("p2",)])
        connection.execute(
            "INSERT INTO project_records ("
            "id, project_id, status, locked, created_at, updated_at, "
            "experiment_number, pathology_number"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "r1",
                "p1",
                "待实验",
                0,
                "2026-08-01 00:00:00",
                "2026-08-01 00:00:00",
                "EXP-1",
                "CASE-1",
            ),
        )
        connection.execute(
            "INSERT INTO record_values (id, record_id, value_text) VALUES (?, ?, ?)",
            ("v1", "r1", "保留值"),
        )
        connection.commit()

    database = Database(f"sqlite:///{database_path.as_posix()}")
    try:
        database._migrate_record_experiment_number_uniqueness()
    finally:
        database.dispose()

    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(project_records)")}
        assert {"position", "highlight_color", "cell_highlight_colors"}.issubset(columns)
        assert connection.execute(
            "SELECT id, project_id, experiment_number, pathology_number, position "
            "FROM project_records"
        ).fetchall() == [("r1", "p1", "EXP-1", "CASE-1", 1)]
        assert connection.execute(
            "SELECT id, record_id, value_text FROM record_values"
        ).fetchall() == [("v1", "r1", "保留值")]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        record_value_targets = {
            row[2] for row in connection.execute("PRAGMA foreign_key_list(record_values)")
        }
        assert record_value_targets == {"project_records"}
        connection.execute(
            "INSERT INTO project_records ("
            "id, project_id, position, status, pathology_number, experiment_number, "
            "report_generated, locked, cell_highlight_colors, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "r2",
                "p2",
                1,
                "待实验",
                "CASE-2",
                "EXP-1",
                0,
                0,
                "{}",
                "2026-08-02 00:00:00",
                "2026-08-02 00:00:00",
            ),
        )
        connection.execute(
            "INSERT INTO project_records ("
            "id, project_id, position, status, pathology_number, experiment_number, "
            "report_generated, locked, cell_highlight_colors, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "r3",
                "p1",
                2,
                "待实验",
                "CASE-3",
                "EXP-1",
                0,
                0,
                "{}",
                "2026-08-03 00:00:00",
                "2026-08-03 00:00:00",
            ),
        )
        connection.commit()
        assert connection.execute(
            "SELECT project_id, experiment_number FROM project_records "
            "WHERE experiment_number = 'EXP-1' ORDER BY id"
        ).fetchall() == [("p1", "EXP-1"), ("p2", "EXP-1"), ("p1", "EXP-1")]
