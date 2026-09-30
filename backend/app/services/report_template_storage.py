from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath

from app.services.docx_template import InvalidDocxTemplate


def resolve_template_path(template_root: Path, template_id: str, storage_path: str) -> Path:
    """Resolve portable keys and legacy absolute paths against the current template root."""
    stored_path = PurePosixPath(storage_path.replace("\\", "/"))
    if stored_path.is_absolute() or PureWindowsPath(storage_path).is_absolute():
        # Old backups retain another installation's root, but the template ID
        # and immutable version filename still identify the restored file.
        stored_path = PurePosixPath(template_id, stored_path.name)
    if (
        len(stored_path.parts) != 2
        or stored_path.parts[0] != template_id
        or stored_path.name in {".", ".."}
        or ":" in stored_path.name
    ):
        raise InvalidDocxTemplate("报告模板存储路径无效")
    root = template_root.resolve()
    candidate = root.joinpath(*stored_path.parts).resolve()
    if candidate.parent != root / template_id:
        raise InvalidDocxTemplate("报告模板存储路径超出模板目录")
    if not candidate.is_file():
        raise InvalidDocxTemplate("报告模板文件不存在，请检查恢复的备份是否完整")
    return candidate
