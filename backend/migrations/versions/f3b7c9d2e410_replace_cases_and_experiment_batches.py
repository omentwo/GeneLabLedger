"""replace shared cases and dated experiment batches

Revision ID: f3b7c9d2e410
Revises: c91e7b4a2d10
Create Date: 2026-08-01 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3b7c9d2e410"
down_revision: str | Sequence[str] | None = "c91e7b4a2d10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("experiment_runs")
    op.drop_table("experiment_batches")

    with op.batch_alter_table("project_records") as batch_op:
        batch_op.add_column(sa.Column("pathology_number", sa.String(length=160), nullable=True))
    op.execute(
        """
        UPDATE project_records
        SET pathology_number = (
            SELECT cases.pathology_number
            FROM cases
            WHERE cases.id = project_records.case_id
        )
        """
    )
    with op.batch_alter_table("project_records") as batch_op:
        batch_op.drop_constraint("uq_record_case_project", type_="unique")
        batch_op.drop_column("case_id")
        batch_op.alter_column("pathology_number", existing_type=sa.String(length=160), nullable=False)
        batch_op.alter_column(
            "current_experiment_date",
            new_column_name="experiment_date",
            existing_type=sa.Date(),
            existing_nullable=True,
        )
        batch_op.create_unique_constraint("uq_record_experiment_number", ["experiment_number"])
    op.create_index(
        op.f("ix_project_records_pathology_number"),
        "project_records",
        ["pathology_number"],
        unique=False,
    )
    op.drop_table("cases")

    op.create_table(
        "experiment_plans",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("prefix", sa.String(length=80), nullable=False),
        sa.Column("last_applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "experiment_plan_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("plan_id", sa.String(length=36), nullable=False),
        sa.Column("record_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["plan_id"], ["experiment_plans.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["record_id"], ["project_records.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("plan_id", "position", name="uq_plan_position"),
        sa.UniqueConstraint("plan_id", "record_id", name="uq_plan_record"),
    )
    op.create_index(
        op.f("ix_experiment_plan_items_plan_id"),
        "experiment_plan_items",
        ["plan_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_experiment_plan_items_record_id"),
        "experiment_plan_items",
        ["record_id"],
        unique=False,
    )
    op.create_index(
        "ix_plan_item_record_created",
        "experiment_plan_items",
        ["record_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    raise RuntimeError("此测试期迁移不可降级，请从备份恢复数据库")
