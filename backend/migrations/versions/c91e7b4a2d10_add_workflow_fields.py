"""add experiment number, visibility and report workflow fields

Revision ID: c91e7b4a2d10
Revises: a7d3e8c1f240
Create Date: 2026-07-30 11:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c91e7b4a2d10"
down_revision: str | Sequence[str] | None = "a7d3e8c1f240"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("projects") as batch_op:
        batch_op.add_column(
            sa.Column(
                "experiment_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
    with op.batch_alter_table("field_definitions") as batch_op:
        batch_op.add_column(
            sa.Column("hidden", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.add_column(sa.Column("experiment_number", sa.String(length=80), nullable=True))
        batch_op.add_column(
            sa.Column(
                "report_generated",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
    op.execute("UPDATE auto_export_tasks SET file_format = 'xlsx' WHERE file_format <> 'xlsx'")


def downgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.drop_column("report_generated")
        batch_op.drop_column("experiment_number")
    with op.batch_alter_table("field_definitions") as batch_op:
        batch_op.drop_column("hidden")
    with op.batch_alter_table("projects") as batch_op:
        batch_op.drop_column("experiment_enabled")
