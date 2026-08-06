"""add local ledger templates and per-ledger experiment number scope"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: str | Sequence[str] | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("ledger_templates"):
        op.create_table(
            "ledger_templates",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=120), nullable=False),
            sa.Column("description", sa.String(length=500), nullable=False),
            sa.Column("fields", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("name", name="uq_ledger_template_name"),
        )
    table_sql = ""
    if bind.dialect.name == "sqlite":
        table_sql = str(
            bind.execute(
                sa.text("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_records'")
            ).scalar()
            or ""
        )
    needs_scope_change = "uq_record_experiment_number" in table_sql
    if bind.dialect.name != "sqlite":
        constraints = inspector.get_unique_constraints("project_records")
        needs_scope_change = any(
            constraint.get("name") == "uq_record_experiment_number" for constraint in constraints
        )
    if needs_scope_change:
        with op.batch_alter_table("project_records") as batch_op:
            batch_op.drop_constraint("uq_record_experiment_number", type_="unique")
            batch_op.create_unique_constraint(
                "uq_record_project_experiment_number",
                ["project_id", "experiment_number"],
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("project_records"):
        table_sql = ""
        if bind.dialect.name == "sqlite":
            table_sql = str(
                bind.execute(
                    sa.text("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_records'")
                ).scalar()
                or ""
            )
        has_new_constraint = "uq_record_project_experiment_number" in table_sql
        if bind.dialect.name != "sqlite":
            has_new_constraint = any(
                constraint.get("name") == "uq_record_project_experiment_number"
                for constraint in inspector.get_unique_constraints("project_records")
            )
        if has_new_constraint:
            with op.batch_alter_table("project_records") as batch_op:
                batch_op.drop_constraint("uq_record_project_experiment_number", type_="unique")
                batch_op.create_unique_constraint("uq_record_experiment_number", ["experiment_number"])
    if inspector.has_table("ledger_templates"):
        op.drop_table("ledger_templates")
