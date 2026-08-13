"""add field validation and project ledger view presets"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: str | Sequence[str] | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    field_columns = {
        column["name"] for column in inspector.get_columns("field_definitions")
    }
    with op.batch_alter_table("field_definitions") as batch_op:
        if "validation_mode" not in field_columns:
            batch_op.add_column(
                sa.Column(
                    "validation_mode",
                    sa.String(length=24),
                    nullable=False,
                    server_default="suggestion",
                )
            )
        if "validation_rules" not in field_columns:
            batch_op.add_column(
                sa.Column(
                    "validation_rules",
                    sa.JSON(),
                    nullable=False,
                    server_default=sa.text("'{}'"),
                )
            )

    inspector = sa.inspect(bind)
    if not inspector.has_table("ledger_view_presets"):
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


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("ledger_view_presets"):
        op.drop_index(
            "uq_ledger_view_preset_project_default",
            table_name="ledger_view_presets",
        )
        op.drop_index(
            "ix_ledger_view_presets_project_id",
            table_name="ledger_view_presets",
        )
        op.drop_table("ledger_view_presets")

    field_columns = {
        column["name"] for column in sa.inspect(bind).get_columns("field_definitions")
    }
    with op.batch_alter_table("field_definitions") as batch_op:
        if "validation_rules" in field_columns:
            batch_op.drop_column("validation_rules")
        if "validation_mode" in field_columns:
            batch_op.drop_column("validation_mode")
