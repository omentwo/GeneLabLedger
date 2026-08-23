from __future__ import annotations

import zipfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from app.services.auto_exports import compute_next_run, parse_cron_expression


class CronSchedule:
    schedule_type = "cron"
    preset = "daily"
    run_time = "18:00"
    hourly_minute = 0
    weekday = 0
    month_day = 1
    cron_expression = "30 1 * * *"


def task_payload(project_id: str, output_directory: Path) -> dict:
    return {
        "name": "任务A",
        "project_ids": [project_id],
        "output_directory": str(output_directory),
        "file_format": "xlsx",
        "schedule_type": "preset",
        "preset": "daily",
        "run_time": "18:00",
        "hourly_minute": 0,
        "weekday": 0,
        "month_day": 1,
        "cron_expression": None,
        "failure_retries": 1,
        "retention_count": 1,
        "enabled": True,
    }


def test_cron_parser_and_next_run() -> None:
    parse_cron_expression("*/15 8-18 * * 1-5")
    next_run = compute_next_run(
        CronSchedule(),
        datetime(2026, 7, 29, 17, 0, tzinfo=UTC),
    )
    assert next_run == datetime(2026, 7, 29, 17, 30, tzinfo=UTC)


def test_create_run_and_retain_latest_export(
    client: TestClient,
    seeded_projects: dict[str, dict],
    tmp_path: Path,
) -> None:
    output_directory = tmp_path / "exports"
    payload = task_payload(seeded_projects["TB"]["id"], output_directory)
    created_response = client.post("/api/auto-export/tasks", json=payload)
    assert created_response.status_code == 201
    task = created_response.json()
    assert task["next_run_at"]

    first_run = client.post(f"/api/auto-export/tasks/{task['id']}/run")
    assert first_run.status_code == 200
    first_path = Path(first_run.json()["file_path"])
    assert first_path.exists()
    assert zipfile.is_zipfile(first_path)

    second_run = client.post(f"/api/auto-export/tasks/{task['id']}/run")
    assert second_run.status_code == 200
    second_path = Path(second_run.json()["file_path"])
    assert second_path.exists()
    assert second_path != first_path
    assert not first_path.exists()

    history = client.get(f"/api/auto-export/tasks/{task['id']}/runs").json()
    assert len(history) == 2
    assert history[0]["status"] == "success"
    assert history[0]["file_path"] == str(second_path)
    assert history[1]["file_path"] is None


def test_cron_task_rejects_invalid_expression(
    client: TestClient,
    seeded_projects: dict[str, dict],
    tmp_path: Path,
) -> None:
    payload = task_payload(seeded_projects["TB"]["id"], tmp_path / "exports")
    payload.update({"schedule_type": "cron", "cron_expression": "not a cron"})
    response = client.post("/api/auto-export/tasks", json=payload)
    assert response.status_code == 422


def test_sanitized_task_names_never_share_an_export_path(
    client: TestClient,
    seeded_projects: dict[str, dict],
    tmp_path: Path,
) -> None:
    output_directory = tmp_path / "shared-exports"
    first_payload = task_payload(seeded_projects["TB"]["id"], output_directory)
    first_payload.update({"name": "批次:A", "retention_count": 10})
    second_payload = task_payload(seeded_projects["TB"]["id"], output_directory)
    second_payload.update({"name": "批次?A", "retention_count": 10})
    first = client.post("/api/auto-export/tasks", json=first_payload).json()
    second = client.post("/api/auto-export/tasks", json=second_payload).json()

    first_run = client.post(f"/api/auto-export/tasks/{first['id']}/run")
    second_run = client.post(f"/api/auto-export/tasks/{second['id']}/run")
    assert first_run.status_code == 200, first_run.text
    assert second_run.status_code == 200, second_run.text
    first_path = Path(first_run.json()["file_path"])
    second_path = Path(second_run.json()["file_path"])
    assert first_path != second_path
    assert first["id"][:8] in first_path.name
    assert second["id"][:8] in second_path.name
    assert zipfile.is_zipfile(first_path)
    assert zipfile.is_zipfile(second_path)
    assert not list(output_directory.glob(".*.tmp"))


def test_normal_project_delete_disables_referencing_export_task(
    client: TestClient,
    seeded_projects: dict[str, dict],
    tmp_path: Path,
) -> None:
    project = seeded_projects["TB"]
    created = client.post(
        "/api/auto-export/tasks",
        json=task_payload(project["id"], tmp_path / "normal-delete"),
    )
    assert created.status_code == 201, created.text
    task_id = created.json()["id"]

    deleted = client.delete(f"/api/projects/{project['id']}")

    assert deleted.status_code == 204, deleted.text
    task = next(
        item for item in client.get("/api/auto-export/tasks").json() if item["id"] == task_id
    )
    assert task["project_ids"] == [project["id"]]
    assert task["enabled"] is False
    assert task["next_run_at"] is None
    assert "已自动停用" in task["last_message"]


def test_force_project_delete_disables_referencing_export_task(
    client: TestClient,
    seeded_projects: dict[str, dict],
    tmp_path: Path,
) -> None:
    project = seeded_projects["TB"]
    record = client.post(
        "/api/records",
        json={"project_id": project["id"], "pathology_number": "FORCE-TASK-DELETE"},
    )
    assert record.status_code == 201, record.text
    created = client.post(
        "/api/auto-export/tasks",
        json=task_payload(project["id"], tmp_path / "force-delete"),
    )
    assert created.status_code == 201, created.text
    task_id = created.json()["id"]

    deleted = client.post(
        f"/api/projects/{project['id']}/force-delete",
        json={"confirm_name": project["name"]},
    )

    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["updated_auto_export_tasks"] == 1
    task = next(
        item for item in client.get("/api/auto-export/tasks").json() if item["id"] == task_id
    )
    assert task["project_ids"] == [project["id"]]
    assert task["enabled"] is False
    assert task["next_run_at"] is None
