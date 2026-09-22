"""remove configurable field validation

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch_op:
        batch_op.drop_column("validation_rules")
        batch_op.drop_column("validation_mode")


def downgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch_op:
        batch_op.add_column(
            sa.Column(
                "validation_mode",
                sa.String(length=24),
                nullable=False,
                server_default="suggestion",
            )
        )
        batch_op.add_column(
            sa.Column(
                "validation_rules",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'{}'"),
            )
        )
