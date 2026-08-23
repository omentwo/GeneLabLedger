from __future__ import annotations

import threading

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import system


def shutdown_test_app(callback) -> FastAPI:
    app = FastAPI()
    app.state.request_shutdown = callback
    app.include_router(system.router, prefix="/api")
    return app


def test_desktop_shutdown_requires_loopback_and_secret_token(monkeypatch) -> None:
    called = threading.Event()
    monkeypatch.setenv("GENE_LEDGER_DESKTOP_MODE", "1")
    monkeypatch.setenv("GENE_LEDGER_SHUTDOWN_TOKEN", "correct-token")
    app = shutdown_test_app(called.set)

    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        refused = client.post(
            "/api/desktop/shutdown",
            headers={"x-gene-ledger-shutdown-token": "wrong-token"},
        )
        assert refused.status_code == 403
        accepted = client.post(
            "/api/desktop/shutdown",
            headers={"x-gene-ledger-shutdown-token": "correct-token"},
        )
        assert accepted.status_code == 202
        assert called.wait(timeout=1)

    with TestClient(app, client=("192.0.2.10", 50000)) as client:
        refused = client.post(
            "/api/desktop/shutdown",
            headers={"x-gene-ledger-shutdown-token": "correct-token"},
        )
        assert refused.status_code == 403
