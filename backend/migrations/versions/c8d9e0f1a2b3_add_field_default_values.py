"""add per-field defaults for new ledger records

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-08-23 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8d9e0f1a2b3"
down_revision: str | Sequence[str] | None = "b7c8d9e0f1a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    field_columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("field_definitions")
    }
    if "default_value" not in field_columns:
        with op.batch_alter_table("field_definitions") as batch_op:
            batch_op.add_column(sa.Column("default_value", sa.Text(), nullable=True))


def downgrade() -> None:
    field_columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("field_definitions")
    }
    if "default_value" in field_columns:
        with op.batch_alter_table("field_definitions") as batch_op:
            batch_op.drop_column("default_value")
