from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

ASIA_SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")


def utc_now() -> datetime:
    return datetime.now(UTC)
