from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import AuditLog
from app.timezones import utc_now


def audit(
    session: Session,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    session.add(
        AuditLog(
            actor="admin",
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details or {},
        )
    )


def prune_audit_logs(
    session: Session,
    *,
    max_rows: int = 100_000,
    retention_days: int = 365,
    now: datetime | None = None,
) -> int:
    """Keep audit storage bounded and remove logs older than the retention window.

    Cleanup is intentionally not audited, otherwise deleting audit rows would create
    more audit rows and make the retention pass self-defeating.
    """

    current_time = now or utc_now()
    if current_time.tzinfo is None:
        # Older callers may provide a naive UTC value; normalize it at the
        # boundary so comparisons remain portable across database dialects.
        current_time = current_time.replace(tzinfo=UTC)
    else:
        current_time = current_time.astimezone(UTC)
    cutoff = current_time - timedelta(days=retention_days)
    deleted = (
        session.execute(delete(AuditLog).where(AuditLog.created_at < cutoff)).rowcount or 0
    )

    total = session.scalar(select(func.count()).select_from(AuditLog)) or 0
    overflow = total - max_rows
    if overflow > 0:
        oldest_ids = list(
            session.scalars(
                select(AuditLog.id)
                .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
                .limit(overflow)
            )
        )
        if oldest_ids:
            deleted += (
                session.execute(delete(AuditLog).where(AuditLog.id.in_(oldest_ids))).rowcount or 0
            )
    return deleted
