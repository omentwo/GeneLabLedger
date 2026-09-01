"""add optional record block number

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-09-01 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e0f1a2b3c4d5"
down_revision: str | Sequence[str] | None = "d9e0f1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.add_column(sa.Column("block_number", sa.String(length=80), nullable=True))
        batch_op.create_index(
            "ix_project_records_block_number",
            ["block_number"],
            unique=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.drop_index("ix_project_records_block_number")
        batch_op.drop_column("block_number")
