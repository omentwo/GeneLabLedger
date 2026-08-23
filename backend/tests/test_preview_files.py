from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.preview_files import cleanup_print_previews


class NoopOfficeService:
    def shutdown(self) -> None:
        pass


def test_cleanup_print_previews_removes_only_expired_managed_files(tmp_path: Path) -> None:
    ledger_dir = tmp_path / "ledger-previews"
    report_dir = tmp_path / "report-previews"
    ledger_dir.mkdir()
    report_dir.mkdir()
    expired_pdf = ledger_dir / f"{'a' * 32}.pdf"
    expired_xlsx = ledger_dir / f"{'b' * 32}.xlsx"
    fresh_pdf = report_dir / f"{'c' * 32}.pdf"
    unrelated = report_dir / "keep-me.pdf"
    for path in (expired_pdf, expired_xlsx, fresh_pdf, unrelated):
        path.write_bytes(b"preview")
    os.utime(expired_pdf, (100.0, 100.0))
    os.utime(expired_xlsx, (100.0, 100.0))
    os.utime(fresh_pdf, (190.0, 190.0))
    os.utime(unrelated, (100.0, 100.0))

    removed = cleanup_print_previews(tmp_path, max_age_seconds=50, now=200.0)

    assert removed == 2
    assert not expired_pdf.exists()
    assert not expired_xlsx.exists()
    assert fresh_pdf.exists()
    assert unrelated.exists()


def test_app_startup_cleans_expired_print_previews(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    preview_dir = data_dir / "temp" / "reports" / "report-previews"
    preview_dir.mkdir(parents=True)
    expired = preview_dir / f"{'d' * 32}.pdf"
    expired.write_bytes(b"expired")
    old_time = time.time() - 120
    os.utime(expired, (old_time, old_time))
    settings = Settings(
        data_dir=data_dir,
        database_url=f"sqlite:///{(data_dir / 'test.db').as_posix()}",
        auto_create_schema=True,
        preview_ttl_seconds=60,
    )
    service = NoopOfficeService()
    app = create_app(settings=settings, printer_service=service, preview_service=service)

    with TestClient(app):
        assert not expired.exists()


def test_print_preview_endpoint_expires_old_file(client: TestClient) -> None:
    preview_id = "e" * 32
    preview_dir = client.app.state.settings.report_work_dir / "ledger-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    expired = preview_dir / f"{preview_id}.pdf"
    expired.write_bytes(b"%PDF expired")
    old_time = time.time() - client.app.state.settings.preview_ttl_seconds - 1
    os.utime(expired, (old_time, old_time))

    response = client.get(f"/api/print-preview/{preview_id}")

    assert response.status_code == 404
    assert not expired.exists()
