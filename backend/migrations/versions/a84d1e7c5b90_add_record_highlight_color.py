"""add optional ledger record highlight colors

Revision ID: a84d1e7c5b90
Revises: f3b7c9d2e410
Create Date: 2026-08-02 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a84d1e7c5b90"
down_revision: str | Sequence[str] | None = "f3b7c9d2e410"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.add_column(sa.Column("highlight_color", sa.String(length=7), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.drop_column("highlight_color")
