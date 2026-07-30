from __future__ import annotations

import threading
import urllib.request
from pathlib import Path

from desktop import launcher


def test_desktop_window_lifecycle_stops_backend_and_releases_database(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: dict[str, str] = {}

    def fake_create_window(_: str, url: str, **_kwargs: object) -> object:
        captured["url"] = url
        return object()

    def fake_start(**_kwargs: object) -> None:
        with urllib.request.urlopen(captured["url"], timeout=5) as response:
            assert response.status == 200

    data_directory = tmp_path / "desktop-data"
    monkeypatch.setattr(launcher, "application_data_directory", lambda: data_directory)
    monkeypatch.setattr(launcher.webview, "create_window", fake_create_window)
    monkeypatch.setattr(launcher.webview, "start", fake_start)

    launcher.main()

    assert not any(
        thread.name == "gene-ledger-backend" for thread in threading.enumerate()
    )
    database_path = data_directory / "ledger.db"
    moved_path = data_directory / "ledger-closed.db"
    database_path.rename(moved_path)
    assert moved_path.is_file()
