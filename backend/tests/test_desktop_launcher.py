from __future__ import annotations

from pathlib import Path

from desktop import launcher


def test_sidecar_requires_explicit_port_and_data_directory(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}
    data_directory = tmp_path / "desktop-data"

    def fake_run(app, **kwargs: object) -> None:
        captured["settings"] = app.state.settings
        captured["kwargs"] = kwargs

    monkeypatch.setenv("GENE_LEDGER_DESKTOP_MODE", "0")
    monkeypatch.setattr(launcher.uvicorn, "run", fake_run)
    launcher.main(
        [
            "--host",
            "127.0.0.1",
            "--port",
            "54321",
            "--data-dir",
            str(data_directory),
        ]
    )

    settings = captured["settings"]
    assert settings.data_dir == data_directory.resolve()
    assert settings.database_url == f"sqlite:///{(data_directory / 'ledger.db').as_posix()}"
    assert settings.auto_create_schema is True
    assert captured["kwargs"] == {
        "host": "127.0.0.1",
        "port": 54321,
        "log_level": "warning",
        "access_log": False,
    }
