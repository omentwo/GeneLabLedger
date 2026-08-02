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
