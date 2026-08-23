"""allow duplicate experiment numbers

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-08-23 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d9e0f1a2b3c4"
down_revision: str | Sequence[str] | None = "c8d9e0f1a2b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    constraints = inspector.get_unique_constraints("project_records")
    experiment_constraints = [
        constraint
        for constraint in constraints
        if "experiment_number" in (constraint.get("column_names") or [])
        and constraint.get("name")
    ]
    if experiment_constraints:
        with op.batch_alter_table("project_records") as batch_op:
            for constraint in experiment_constraints:
                batch_op.drop_constraint(str(constraint["name"]), type_="unique")


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    constraints = inspector.get_unique_constraints("project_records")
    has_experiment_constraint = any(
        set(constraint.get("column_names") or []) == {"project_id", "experiment_number"}
        for constraint in constraints
    )
    if not has_experiment_constraint:
        with op.batch_alter_table("project_records") as batch_op:
            batch_op.create_unique_constraint(
                "uq_record_project_experiment_number",
                ["project_id", "experiment_number"],
            )
