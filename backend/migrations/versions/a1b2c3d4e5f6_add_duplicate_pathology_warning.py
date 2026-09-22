"""add duplicate pathology warning setting

Revision ID: a1b2c3d4e5f6
Revises: f1a2b3c4d5e6
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("projects") as batch_op:
        batch_op.add_column(
            sa.Column(
                "duplicate_pathology_warning_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
    op.create_index(
        "ix_record_project_pathology",
        "project_records",
        ["project_id", "pathology_number"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_record_project_pathology", table_name="project_records")
    with op.batch_alter_table("projects") as batch_op:
        batch_op.drop_column("duplicate_pathology_warning_enabled")
