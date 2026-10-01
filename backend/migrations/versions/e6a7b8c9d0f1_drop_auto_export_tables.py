"""drop retired auto export tables

Revision ID: e6a7b8c9d0f1
Revises: b2c3d4e5f6a7
Create Date: 2026-10-01 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e6a7b8c9d0f1"
down_revision: str | Sequence[str] | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("auto_export_runs"):
        op.drop_table("auto_export_runs")
    if sa.inspect(op.get_bind()).has_table("auto_export_tasks"):
        op.drop_table("auto_export_tasks")


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("auto_export_tasks"):
        return
    op.create_table(
        "auto_export_tasks",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("project_ids", sa.JSON(), nullable=False),
        sa.Column("output_directory", sa.String(length=600), nullable=False),
        sa.Column("file_format", sa.String(length=12), nullable=False),
        sa.Column("schedule_type", sa.String(length=20), nullable=False),
        sa.Column("preset", sa.String(length=20), nullable=False),
        sa.Column("run_time", sa.String(length=5), nullable=False),
        sa.Column("hourly_minute", sa.Integer(), nullable=False),
        sa.Column("weekday", sa.Integer(), nullable=False),
        sa.Column("month_day", sa.Integer(), nullable=False),
        sa.Column("cron_expression", sa.String(length=160), nullable=True),
        sa.Column("failure_retries", sa.Integer(), nullable=False),
        sa.Column("retention_count", sa.Integer(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_status", sa.String(length=24), nullable=True),
        sa.Column("last_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index(
        op.f("ix_auto_export_tasks_enabled"),
        "auto_export_tasks",
        ["enabled"],
        unique=False,
    )
    op.create_index(
        op.f("ix_auto_export_tasks_next_run_at"),
        "auto_export_tasks",
        ["next_run_at"],
        unique=False,
    )
    op.create_table(
        "auto_export_runs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("task_id", sa.String(length=36), nullable=False),
        sa.Column("trigger", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("file_path", sa.String(length=900), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["task_id"], ["auto_export_tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_auto_export_runs_status"),
        "auto_export_runs",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_auto_export_runs_task_id"),
        "auto_export_runs",
        ["task_id"],
        unique=False,
    )
    op.create_index(
        "ix_auto_export_run_task_started",
        "auto_export_runs",
        ["task_id", "started_at"],
        unique=False,
    )
