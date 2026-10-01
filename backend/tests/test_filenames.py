from __future__ import annotations

from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.services.filenames import safe_filename


def test_replaces_path_separators_and_windows_invalid_characters() -> None:
    invalid = '<>:"/\\|?*' + "".join(chr(code) for code in range(32))
    assert safe_filename(f"病例{invalid}A") == "病例" + "_" * len(invalid) + "A"
    assert safe_filename(" ._病例报告_. ") == "病例报告"


@pytest.mark.parametrize("fallback", ["report", "台账导出", "ledger"])
def test_preserves_each_callers_empty_name_fallback(fallback: str) -> None:
    assert safe_filename(" ._<>?_. ", fallback=fallback) == fallback


@pytest.mark.parametrize("max_length", [100, 120])
def test_preserves_each_callers_length_limit(max_length: int) -> None:
    assert safe_filename("病" * 150, max_length=max_length) == "病" * max_length


@pytest.mark.parametrize(
    ("filename", "expected"),
    [(" ._病例:报告/2026_. ", "病例_报告_2026.xlsx"), (" ._?_. ", "台账导出.xlsx")],
)
def test_workbook_download_uses_cleaned_utf8_filename(
    client: TestClient, filename: str, expected: str
) -> None:
    response = client.post(
        "/api/exports/workbook",
        json={
            "filename": filename,
            "sheets": [{"name": "台账", "headers": ["病理号"], "rows": [["26-1"]]}],
        },
    )
    assert response.status_code == 200
    assert response.headers["Content-Disposition"] == f"attachment; filename*=UTF-8''{quote(expected)}"
