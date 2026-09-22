from __future__ import annotations

import json
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import AppSetting
from app.services.database_backups import BackupError, prune_backups, validate_backup_archive
from app.timezones import ASIA_SHANGHAI
from tests.conftest import FakeOfficePrintService


def test_complete_backup_defaults_and_archive_contents(client: TestClient) -> None:
    settings_response = client.get("/api/database-backups/settings")
    assert settings_response.status_code == 200
    backup_settings = settings_response.json()
    assert backup_settings["enabled"] is True
    assert backup_settings["interval_hours"] == 1
    assert backup_settings["retention_backup_days"] == 7
    assert backup_settings["copies_per_day"] == 30
    assert backup_settings["backup_on_shutdown"] is True

    template_file = client.app.state.settings.template_dir / "project-a" / "report.docx"
    template_file.parent.mkdir(parents=True, exist_ok=True)
    template_file.write_bytes(b"template-content")

    response = client.post("/api/database-backups/run")
    assert response.status_code == 200, response.text
    result = response.json()
    backup_path = Path(result["path"])
    assert backup_path.is_file()
    assert backup_path.parent.name == datetime.now(ASIA_SHANGHAI).date().isoformat()
    assert result["reason"] == "manual"

    manifest = validate_backup_archive(backup_path)
    assert manifest["local_backup_date"] == backup_path.parent.name
    assert {entry["path"] for entry in manifest["files"]} == {
        "ledger.db",
        "templates/project-a/report.docx",
    }
    with zipfile.ZipFile(backup_path) as archive:
        assert archive.read("templates/project-a/report.docx") == b"template-content"

    history = client.get("/api/database-backups").json()
    assert history[0]["path"] == str(backup_path)
    status = client.get("/api/database-backups/status").json()
    assert status["last_path"] == str(backup_path)
    assert status["last_reason"] == "manual"
    assert status["last_error"] is None


def test_retention_keeps_latest_seven_populated_backup_dates(tmp_path: Path) -> None:
    backup_root = tmp_path / "backups"
    first_date = datetime(2025, 1, 1)
    populated_dates: list[str] = []
    for day_index in range(8):
        # Deliberately leave six calendar days between runs. Retention must count
        # populated backup dates, not elapsed calendar days.
        backup_date = (first_date + timedelta(days=day_index * 7)).date().isoformat()
        populated_dates.append(backup_date)
        day_directory = backup_root / backup_date
        day_directory.mkdir(parents=True)
        for copy_index in range(31):
            stamp = f"{backup_date.replace('-', '')}-120000-{copy_index:06d}"
            (day_directory / f"GeneLabLedger-{stamp}-scheduled.glbkp").write_bytes(b"backup")

    prune_backups(backup_root, retention_backup_days=7, copies_per_day=30)

    remaining_dates = sorted(path.name for path in backup_root.iterdir() if path.is_dir())
    assert remaining_dates == populated_dates[1:]
    assert all(len(list((backup_root / date).glob("*.glbkp"))) == 30 for date in remaining_dates)
    assert sum(len(list(path.glob("*.glbkp"))) for path in backup_root.iterdir()) == 210


def test_restore_archive_rejects_windows_path_traversal(tmp_path: Path) -> None:
    archive_path = tmp_path / "unsafe.glbkp"
    manifest = {
        "format": "gene-lab-ledger-complete-backup",
        "format_version": 1,
        "files": [],
    }
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("ledger.db", b"not-used")
        archive.writestr("templates/C:escaped.txt", b"escape")
        archive.writestr("manifest.json", json.dumps(manifest))

    with pytest.raises(BackupError, match="Windows"):
        validate_backup_archive(archive_path)


def test_restore_replaces_database_and_templates_after_restart(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    settings = Settings(
        data_dir=data_dir,
        database_url=f"sqlite:///{(data_dir / 'test.db').as_posix()}",
        auto_create_schema=True,
    )
    app = create_app(settings=settings, printer_service=FakeOfficePrintService())
    with TestClient(app) as client:
        database = client.app.state.database
        with database.session_factory() as session:
            session.add(AppSetting(key="restore_probe", value="before-backup"))
            session.commit()
        template_file = settings.template_dir / "restore-probe.txt"
        template_file.write_text("before-backup", encoding="utf-8")

        backup_response = client.post("/api/database-backups/run")
        assert backup_response.status_code == 200, backup_response.text
        backup_path = backup_response.json()["path"]

        with database.session_factory() as session:
            session.get(AppSetting, "restore_probe").value = "after-backup"
            session.commit()
        template_file.write_text("after-backup", encoding="utf-8")

        restore_response = client.post("/api/database-backups/restore", json={"path": backup_path})
        assert restore_response.status_code == 200, restore_response.text
        assert restore_response.json()["restart_required"] is True
        assert Path(restore_response.json()["safety_backup_path"]).is_file()

    restarted_app = create_app(settings=settings, printer_service=FakeOfficePrintService())
    with TestClient(restarted_app) as restarted_client:
        with restarted_client.app.state.database.session_factory() as session:
            assert session.get(AppSetting, "restore_probe").value == "before-backup"
        assert (settings.template_dir / "restore-probe.txt").read_text(encoding="utf-8") == (
            "before-backup"
        )
        assert not (settings.data_dir / ".pending-database-restore.json").exists()
