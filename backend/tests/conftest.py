from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class FakeOfficePrintService:
    def list_printers(self) -> list[dict[str, object]]:
        return [{"name": "测试打印机", "is_default": True}]

    def engine_statuses(self) -> list[dict[str, object]]:
        return [
            {
                "key": "auto",
                "label": "自动",
                "available": True,
                "resolved_engine": "word",
            },
            {
                "key": "wps",
                "label": "WPS",
                "available": True,
                "resolved_engine": "wps",
            },
            {
                "key": "word",
                "label": "Microsoft Word",
                "available": True,
                "resolved_engine": "word",
            },
        ]

    def print_documents(
        self,
        input_documents: list[Path],
        printer_name: str,
        engine: str = "auto",
    ) -> str:
        assert printer_name == "测试打印机"
        assert input_documents
        assert all(path.is_file() for path in input_documents)
        return "word" if engine == "auto" else engine

    def shutdown(self) -> None:
        pass


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    data_dir = tmp_path / "data"
    settings = Settings(
        data_dir=data_dir,
        database_url=f"sqlite:///{(data_dir / 'test.db').as_posix()}",
        auto_create_schema=True,
    )
    app = create_app(settings=settings, printer_service=FakeOfficePrintService())
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def seeded_projects(client: TestClient) -> dict[str, dict]:
    projects = client.get("/api/projects").json()
    return {project["name"]: project for project in projects}
