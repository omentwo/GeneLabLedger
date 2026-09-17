from __future__ import annotations

from datetime import date, datetime

from fastapi.testclient import TestClient

from app.timezones import ASIA_SHANGHAI


def _shift_month(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 + months
    return date(month_index // 12, month_index % 12 + 1, 1)


def test_dashboard_summary_aggregates_records(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    project_id = seeded_projects["TB"]["id"]
    today = datetime.now(ASIA_SHANGHAI).date()
    current_date = today.isoformat()
    previous_date = _shift_month(today.replace(day=1), -1).isoformat()

    records = [
        {
            "project_id": project_id,
            "pathology_number": "DASH-CURRENT",
            "experiment_date": current_date,
        },
        {
            "project_id": project_id,
            "pathology_number": "DASH-PREVIOUS",
            "experiment_date": previous_date,
            "status": "已完成",
        },
        {
            "project_id": project_id,
            "pathology_number": "DASH-UNDATED",
        },
    ]
    for record in records:
        response = client.post("/api/records", json=record)
        assert response.status_code == 201

    response = client.get("/api/dashboard/summary")
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_records"] == 3
    assert payload["current_month"] == 1
    assert payload["previous_month"] == 1
    assert payload["report_generated_rate"] == 0
    assert payload["monthly"][-1] == {
        "month": today.strftime("%Y-%m"),
        "total": 1,
    }
    assert {item["status"]: item["total"] for item in payload["statuses"]} == {
        "待实验": 2,
        "已完成": 1,
    }
    assert payload["projects"][0] == {
        "id": project_id,
        "name": "TB",
        "total": 3,
        "current_month": 1,
        "previous_month": 1,
        "monthly": [
            {
                "month": item["month"],
                "total": 1 if item["month"] in {today.strftime("%Y-%m"), previous_date[:7]} else 0,
            }
            for item in payload["monthly"]
        ],
    }

    other_project_id = seeded_projects["BRAFV600E"]["id"]
    filtered = client.get(
        "/api/dashboard/summary",
        params={"project_id": other_project_id},
    )
    assert filtered.status_code == 200
    assert filtered.json()["total_records"] == 0
    assert filtered.json()["projects"][0]["id"] == other_project_id


def test_dashboard_summary_rejects_unknown_project(client: TestClient) -> None:
    response = client.get("/api/dashboard/summary", params={"project_id": "missing"})
    assert response.status_code == 404
