from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def make_record(client: TestClient, project_id: str, pathology: str, date: str | None = None) -> dict:
    response = client.post("/api/records", json={
        "project_id": project_id, "pathology_number": pathology, "experiment_date": date,
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_tail_uses_ledger_positions_and_ids_ignore_transport_pagination(client, seeded_projects):
    project_id = seeded_projects["TB"]["id"]
    rows = [make_record(client, project_id, f"TAIL-{i}") for i in range(6)]
    inserted = client.post("/api/records", json={
        "project_id": project_id, "pathology_number": "NEW-BUT-ABOVE",
        "insert_before_record_id": rows[0]["id"],
    })
    assert inserted.status_code == 201, inserted.text
    query = {"project_id": project_id, "tail_count": 3, "limit": 2}
    first = client.post("/api/records/query", json=query).json()
    last = client.post("/api/records/query", json={**query, "offset": 2}).json()
    assert first["total"] == last["total"] == 3
    assert [r["id"] for r in first["items"] + last["items"]] == [r["id"] for r in rows[-3:]]
    ids = client.post("/api/records/query/ids", json={**query, "limit": 1, "offset": 50}).json()
    assert ids == {"record_ids": [r["id"] for r in rows[-3:]], "total": 3}


def test_month_range_boundaries_undated_and_locked_records(client, seeded_projects):
    project_id = seeded_projects["TB"]["id"]
    dates = ["2026-07-10", "2026-07-11", "2026-10-11", "2026-10-12", None]
    rows = [make_record(client, project_id, f"MONTH-{i}", day) for i, day in enumerate(dates)]
    query = {
        "project_id": project_id, "experiment_date_from": "2026-07-11",
        "experiment_date_to": "2026-10-11", "include_locked": False,
    }
    assert client.post("/api/records/query/ids", json=query).json()["record_ids"] == [
        r["id"] for r in rows[1:3]
    ]
    with_undated = {**query, "include_undated": True}
    assert client.post("/api/records/query", json=with_undated).json()["total"] == 3
    assert client.put(f"/api/records/{rows[2]['id']}/lock", json={"locked": True}).status_code == 200
    assert client.post("/api/records/query/ids", json=with_undated).json()["record_ids"] == [
        rows[1]["id"], rows[4]["id"]
    ]
    result = client.post("/api/records/query", json={**with_undated, "include_locked": True}).json()
    assert result["total"] == 3
    assert client.post("/api/records/query", json={"project_id": project_id}).json()["total"] == 5


@pytest.mark.parametrize("count", [0, -1, 10001])
def test_invalid_tail_count_is_rejected(client, seeded_projects, count):
    response = client.post("/api/records/query", json={
        "project_id": seeded_projects["TB"]["id"], "tail_count": count,
    })
    assert response.status_code == 422
