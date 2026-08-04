"""add per-cell ledger highlight colors

Revision ID: c3d4e5f6a7b8
Revises: a84d1e7c5b90
Create Date: 2026-08-04 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: str | Sequence[str] | None = "a84d1e7c5b90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.add_column(
            sa.Column(
                "cell_highlight_colors",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            )
        )

    with op.batch_alter_table("project_records") as batch_op:
        batch_op.alter_column("cell_highlight_colors", server_default=None)


def downgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.drop_column("cell_highlight_colors")
