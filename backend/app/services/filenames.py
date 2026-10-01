from __future__ import annotations

import re

_INVALID_FILENAME_CHARACTERS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_filename(value: str, fallback: str = "report", *, max_length: int = 120) -> str:
    """Clean a filename stem; callers supply the appropriate extension."""
    cleaned = _INVALID_FILENAME_CHARACTERS.sub("_", value).strip(" ._")
    return cleaned[:max_length] or fallback
