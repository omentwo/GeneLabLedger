from pathlib import Path

import pytest

from app.services.docx_template import InvalidDocxTemplate
from app.services.report_template_storage import resolve_template_path


@pytest.mark.parametrize(
    "storage_path",
    [
        "template-a/v1-version.docx",
        r"template-a\v1-version.docx",
        r"C:\old-data\templates\template-a\v1-version.docx",
        "/old-data/templates/template-a/v1-version.docx",
        r"\\server\old-data\templates\template-a\v1-version.docx",
    ],
)
def test_template_keys_and_legacy_paths_use_current_root(tmp_path: Path, storage_path: str) -> None:
    root = tmp_path / "templates"
    template_path = root / "template-a" / "v1-version.docx"
    template_path.parent.mkdir(parents=True)
    template_path.write_bytes(b"restored-template")

    assert resolve_template_path(root, "template-a", storage_path) == template_path.resolve()


@pytest.mark.parametrize(
    "storage_path",
    [
        "../v1-version.docx",
        "template-b/v1-version.docx",
        "template-a/../template-b/v1-version.docx",
        "template-a/v1-version.docx:other-stream",
    ],
)
def test_template_key_cannot_read_another_directory(tmp_path: Path, storage_path: str) -> None:
    with pytest.raises(InvalidDocxTemplate, match="存储路径"):
        resolve_template_path(tmp_path / "templates", "template-a", storage_path)


def test_missing_restored_template_does_not_fall_back_to_original_file(tmp_path: Path) -> None:
    original = tmp_path / "old-data" / "templates" / "template-a" / "v1-version.docx"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"original-template")

    with pytest.raises(InvalidDocxTemplate, match="文件不存在"):
        resolve_template_path(tmp_path / "new-data" / "templates", "template-a", str(original))
