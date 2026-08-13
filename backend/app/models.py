from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, UTCDateTime
from app.timezones import utc_now


def new_uuid() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    experiment_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    fields: Mapped[list[FieldDefinition]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="FieldDefinition.sort_order",
    )
    records: Mapped[list[ProjectRecord]] = relationship(back_populates="project")
    report_templates: Mapped[list[ReportTemplate]] = relationship(back_populates="project")
    view_presets: Mapped[list[LedgerViewPreset]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="LedgerViewPreset.name",
    )


class LedgerTemplate(Base, TimestampMixin):
    """A local, user-maintained snapshot of a ledger header definition.

    The field payload intentionally lives as JSON.  Templates are copied into a
    project when it is created, so changing a template never mutates existing
    projects or requires a user/permission model.
    """

    __tablename__ = "ledger_templates"
    __table_args__ = (UniqueConstraint("name", name="uq_ledger_template_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    fields: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)


class LedgerViewPreset(Base, TimestampMixin):
    """A project-scoped, named presentation of the ledger table."""

    __tablename__ = "ledger_view_presets"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_ledger_view_preset_project_name"),
        Index(
            "uq_ledger_view_preset_project_default",
            "project_id",
            unique=True,
            sqlite_where=text("is_default = 1"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    project: Mapped[Project] = relationship(back_populates="view_presets")


class FieldDefinition(Base, TimestampMixin):
    __tablename__ = "field_definitions"
    __table_args__ = (
        UniqueConstraint("project_id", "key", name="uq_field_project_key"),
        UniqueConstraint("project_id", "system_key", name="uq_field_project_system_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    key: Mapped[str] = mapped_column(String(120), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    data_type: Mapped[str] = mapped_column(String(24), default="text", nullable=False)
    system_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_core: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    width: Mapped[int] = mapped_column(Integer, default=120, nullable=False)
    validation_mode: Mapped[str] = mapped_column(
        String(24), default="suggestion", nullable=False
    )
    validation_rules: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="fields")
    options: Mapped[list[FieldOption]] = relationship(
        back_populates="field",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="FieldOption.sort_order",
    )
    values: Mapped[list[RecordValue]] = relationship(
        back_populates="field",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    mappings: Mapped[list[ReportMapping]] = relationship(back_populates="field")


class FieldOption(Base):
    __tablename__ = "field_options"
    __table_args__ = (UniqueConstraint("field_id", "value", name="uq_field_option_value"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    field_id: Mapped[str] = mapped_column(
        ForeignKey("field_definitions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    value: Mapped[str] = mapped_column(String(240), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    field: Mapped[FieldDefinition] = relationship(back_populates="options")


class ProjectRecord(Base, TimestampMixin):
    __tablename__ = "project_records"
    __table_args__ = (
        UniqueConstraint("project_id", "experiment_number", name="uq_record_project_experiment_number"),
        Index("ix_record_project_status", "project_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(40), default="待实验", nullable=False)
    experiment_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    pathology_number: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    experiment_number: Mapped[str | None] = mapped_column(String(80), nullable=True)
    report_generated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    locked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    highlight_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    cell_highlight_colors: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)

    project: Mapped[Project] = relationship(back_populates="records")
    values: Mapped[list[RecordValue]] = relationship(
        back_populates="record",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class RecordValue(Base, TimestampMixin):
    __tablename__ = "record_values"
    __table_args__ = (UniqueConstraint("record_id", "field_id", name="uq_record_field_value"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    record_id: Mapped[str] = mapped_column(
        ForeignKey("project_records.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    field_id: Mapped[str] = mapped_column(
        ForeignKey("field_definitions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    value_text: Mapped[str] = mapped_column(Text, default="", nullable=False)

    record: Mapped[ProjectRecord] = relationship(back_populates="values")
    field: Mapped[FieldDefinition] = relationship(back_populates="values")


class ReportTemplate(Base, TimestampMixin):
    __tablename__ = "report_templates"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_template_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)

    project: Mapped[Project] = relationship(back_populates="report_templates")
    versions: Mapped[list[ReportTemplateVersion]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ReportTemplateVersion.version_number",
    )


class ReportTemplateVersion(Base, TimestampMixin):
    __tablename__ = "report_template_versions"
    __table_args__ = (UniqueConstraint("template_id", "version_number", name="uq_template_version_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    template_id: Mapped[str] = mapped_column(
        ForeignKey("report_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    original_filename: Mapped[str] = mapped_column(String(260), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(600), nullable=False)
    placeholders: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)

    template: Mapped[ReportTemplate] = relationship(back_populates="versions")
    mappings: Mapped[list[ReportMapping]] = relationship(
        back_populates="version",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ReportMapping(Base, TimestampMixin):
    __tablename__ = "report_mappings"
    __table_args__ = (
        UniqueConstraint("template_version_id", "placeholder", name="uq_mapping_version_placeholder"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    template_version_id: Mapped[str] = mapped_column(
        ForeignKey("report_template_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    placeholder: Mapped[str] = mapped_column(String(240), nullable=False)
    source_type: Mapped[str] = mapped_column(String(40), default="unmapped", nullable=False)
    field_id: Mapped[str | None] = mapped_column(
        ForeignKey("field_definitions.id", ondelete="SET NULL"),
        nullable=True,
    )
    fixed_value: Mapped[str | None] = mapped_column(Text, nullable=True)

    version: Mapped[ReportTemplateVersion] = relationship(back_populates="mappings")
    field: Mapped[FieldDefinition | None] = relationship(back_populates="mappings")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    actor: Mapped[str] = mapped_column(String(80), default="admin", nullable=False)
    action: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    entity_id: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=utc_now,
        nullable=False,
        index=True,
    )


class AppSetting(Base, TimestampMixin):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="", nullable=False)


class AutoExportTask(Base, TimestampMixin):
    __tablename__ = "auto_export_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(160), unique=True, nullable=False)
    project_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    output_directory: Mapped[str] = mapped_column(String(600), nullable=False)
    file_format: Mapped[str] = mapped_column(String(12), default="xlsx", nullable=False)
    schedule_type: Mapped[str] = mapped_column(String(20), default="preset", nullable=False)
    preset: Mapped[str] = mapped_column(String(20), default="daily", nullable=False)
    run_time: Mapped[str] = mapped_column(String(5), default="18:00", nullable=False)
    hourly_minute: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    weekday: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    month_day: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    cron_expression: Mapped[str | None] = mapped_column(String(160), nullable=True)
    failure_retries: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    retention_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    next_run_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True, index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(24), nullable=True)
    last_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    runs: Mapped[list[AutoExportRun]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="AutoExportRun.started_at.desc()",
    )


class AutoExportRun(Base):
    __tablename__ = "auto_export_runs"
    __table_args__ = (Index("ix_auto_export_run_task_started", "task_id", "started_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("auto_export_tasks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    trigger: Mapped[str] = mapped_column(String(20), default="scheduled", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="running", nullable=False, index=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    file_path: Mapped[str | None] = mapped_column(String(900), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utc_now, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    task: Mapped[AutoExportTask] = relationship(back_populates="runs")
