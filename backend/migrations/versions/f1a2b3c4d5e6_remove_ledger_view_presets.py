"""remove retired ledger view presets

Revision ID: f1a2b3c4d5e6
Revises: e0f1a2b3c4d5
Create Date: 2026-09-01 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | Sequence[str] | None = "e0f1a2b3c4d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("ledger_view_presets"):
        op.drop_table("ledger_view_presets")


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("ledger_view_presets"):
        return
    op.create_table(
        "ledger_view_presets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "name",
            name="uq_ledger_view_preset_project_name",
        ),
    )
    op.create_index(
        "ix_ledger_view_presets_project_id",
        "ledger_view_presets",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        "uq_ledger_view_preset_project_default",
        "ledger_view_presets",
        ["project_id"],
        unique=True,
        sqlite_where=sa.text("is_default = 1"),
    )
