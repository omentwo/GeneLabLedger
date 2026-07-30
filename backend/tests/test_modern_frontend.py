from __future__ import annotations

from fastapi.testclient import TestClient


def test_root_serves_modern_frontend(client: TestClient) -> None:
    root = client.get("/")
    nested = client.get("/audit")
    retired = client.get("/app/ledger", follow_redirects=False)

    assert root.status_code == 200
    assert '<div id="app"></div>' in root.text
    assert nested.status_code == 200
    assert '<div id="app"></div>' in nested.text
    assert retired.status_code == 308
    assert retired.headers["location"] == "/ledger"
