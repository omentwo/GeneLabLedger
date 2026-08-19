"""add stable project record positions

Revision ID: b7c8d9e0f1a2
Revises: e5f6a7b8c9d0
Create Date: 2026-08-19 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7c8d9e0f1a2"
down_revision: str | Sequence[str] | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.add_column(
            sa.Column("position", sa.Integer(), nullable=False, server_default="0")
        )

    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, project_id FROM project_records "
            "ORDER BY project_id, created_at, id"
        )
    ).all()
    counters: dict[str, int] = {}
    updates = []
    for record_id, project_id in rows:
        position = counters.get(project_id, 0) + 1
        counters[project_id] = position
        updates.append({"record_id": record_id, "position": position})
    if updates:
        bind.execute(
            sa.text(
                "UPDATE project_records SET position = :position "
                "WHERE id = :record_id"
            ),
            updates,
        )

    with op.batch_alter_table("project_records") as batch_op:
        batch_op.alter_column("position", server_default=None)
    op.create_index(
        "ix_record_project_position",
        "project_records",
        ["project_id", "position"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_record_project_position", table_name="project_records")
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.drop_column("position")
