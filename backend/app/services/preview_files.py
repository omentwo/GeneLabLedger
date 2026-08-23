from __future__ import annotations

import logging
import re
import time
from pathlib import Path

logger = logging.getLogger(__name__)

PREVIEW_DIRECTORIES = ("ledger-previews", "report-previews")
PREVIEW_FILENAME = re.compile(r"[0-9a-f]{32}\.(?:pdf|xlsx)")


def cleanup_print_previews(
    report_work_dir: Path,
    *,
    max_age_seconds: int,
    now: float | None = None,
) -> int:
    """Remove expired generated preview files without touching unrelated files."""

    cutoff = (time.time() if now is None else now) - max_age_seconds
    removed = 0
    for directory_name in PREVIEW_DIRECTORIES:
        directory = report_work_dir / directory_name
        try:
            entries = list(directory.iterdir())
        except FileNotFoundError:
            continue
        except OSError:
            logger.warning("无法扫描过期预览目录：%s", directory, exc_info=True)
            continue
        for path in entries:
            if not PREVIEW_FILENAME.fullmatch(path.name):
                continue
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
            except OSError:
                logger.warning("无法清理过期预览文件：%s", path, exc_info=True)
    return removed
