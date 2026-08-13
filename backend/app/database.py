from __future__ import annotations

import shutil
from collections.abc import Generator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Request
from sqlalchemy import DateTime, Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator[datetime]):
    """Store UTC timestamps and always return timezone-aware UTC datetimes.

    SQLite does not preserve timezone information in its DATETIME type, so the
    offset is stripped only while binding to SQLite and restored when reading.
    Other dialects use a timezone-aware DateTime column directly.
    """

    impl = DateTime
    cache_ok = True

    def load_dialect_impl(self, dialect):  # type: ignore[no-untyped-def]
        return dialect.type_descriptor(DateTime(timezone=dialect.name != "sqlite"))

    def process_bind_param(self, value: datetime | None, dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        value = value.astimezone(UTC)
        return value.replace(tzinfo=None) if dialect.name == "sqlite" else value

    def process_result_value(self, value: datetime | None, _dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Base(DeclarativeBase):
    pass


class Database:
    def __init__(self, database_url: str) -> None:
        connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
        self.engine = create_engine(database_url, connect_args=connect_args)
        if database_url.startswith("sqlite"):
            event.listen(self.engine, "connect", self._enable_sqlite_foreign_keys)
        self.session_factory = sessionmaker(
            bind=self.engine,
            class_=Session,
            autoflush=False,
            expire_on_commit=False,
        )

    @staticmethod
    def _enable_sqlite_foreign_keys(dbapi_connection: object, _: object) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    def create_all(self) -> None:
        from app import models  # noqa: F401

        self.backup_sqlite_before_schema_upgrade()
        self._migrate_record_experiment_number_scope()
        self._migrate_v010_field_validation()
        Base.metadata.create_all(self.engine)

    def backup_sqlite_before_schema_upgrade(self) -> None:
        """Create one timestamped copy before an installed database is altered."""
        if self.engine.dialect.name != "sqlite":
            return
        database_name = self.engine.url.database
        if not database_name or database_name == ":memory:":
            return
        database_path = Path(database_name).resolve()
        if not database_path.is_file():
            return
        with self.engine.connect() as connection:
            field_columns = {
                str(row[1])
                for row in connection.exec_driver_sql("PRAGMA table_info(field_definitions)")
            }
            view_exists = bool(
                connection.exec_driver_sql(
                    "SELECT 1 FROM sqlite_master WHERE type='table' "
                    "AND name='ledger_view_presets'"
                ).scalar()
            )
        needs_upgrade = not {"validation_mode", "validation_rules"}.issubset(field_columns)
        needs_upgrade = needs_upgrade or not view_exists
        if not needs_upgrade:
            return
        backup_dir = database_path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        backup_path = backup_dir / f"ledger-before-v0.10.0-{timestamp}.db"
        suffix = 1
        while backup_path.exists():
            backup_path = backup_dir / f"ledger-before-v0.10.0-{timestamp}-{suffix}.db"
            suffix += 1
        shutil.copy2(database_path, backup_path)

    def _migrate_v010_field_validation(self) -> None:
        """Keep packaged desktop upgrades compatible with ``create_all``."""
        if self.engine.dialect.name != "sqlite":
            return
        with self.engine.begin() as connection:
            table_exists = connection.exec_driver_sql(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='field_definitions'"
            ).scalar()
            if not table_exists:
                return
            columns = {
                str(row[1])
                for row in connection.exec_driver_sql("PRAGMA table_info(field_definitions)")
            }
            if "validation_mode" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE field_definitions ADD COLUMN validation_mode "
                    "VARCHAR(24) NOT NULL DEFAULT 'suggestion'"
                )
            if "validation_rules" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE field_definitions ADD COLUMN validation_rules "
                    "JSON NOT NULL DEFAULT '{}'"
                )

    def _migrate_record_experiment_number_scope(self) -> None:
        """Replace the pre-0.9.3 global experiment-number index in SQLite.

        ``create_all`` intentionally does not alter existing tables.  Ledger
        duplication needs the number to be unique inside each ledger, so an
        existing local database is rebuilt once while preserving every row.
        """
        if self.engine.dialect.name != "sqlite":
            return
        with self.engine.begin() as connection:
            table_sql = connection.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='project_records'"
            ).scalar()
            if not table_sql or "uq_record_experiment_number" not in str(table_sql):
                return
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            connection.exec_driver_sql("ALTER TABLE project_records RENAME TO project_records_legacy")
            connection.exec_driver_sql("DROP INDEX IF EXISTS ix_record_project_status")
            connection.exec_driver_sql("DROP INDEX IF EXISTS ix_project_records_pathology_number")
            connection.exec_driver_sql(
                """
                CREATE TABLE project_records (
                    id VARCHAR(36) NOT NULL,
                    project_id VARCHAR(36) NOT NULL,
                    status VARCHAR(40) NOT NULL,
                    experiment_date DATE,
                    locked BOOLEAN NOT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    experiment_number VARCHAR(80),
                    report_generated BOOLEAN DEFAULT 0 NOT NULL,
                    pathology_number VARCHAR(160) NOT NULL,
                    highlight_color VARCHAR(7),
                    cell_highlight_colors JSON NOT NULL,
                    PRIMARY KEY (id),
                    CONSTRAINT uq_record_project_experiment_number
                        UNIQUE (project_id, experiment_number),
                    FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE RESTRICT
                )
                """
            )
            connection.exec_driver_sql(
                """
                INSERT INTO project_records (
                    id, project_id, status, experiment_date, locked, created_at,
                    updated_at, experiment_number, report_generated, pathology_number,
                    highlight_color, cell_highlight_colors
                )
                SELECT
                    id, project_id, status, experiment_date, locked, created_at,
                    updated_at, experiment_number, report_generated, pathology_number,
                    highlight_color, cell_highlight_colors
                FROM project_records_legacy
                """
            )
            connection.exec_driver_sql("DROP TABLE project_records_legacy")
            connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_record_project_status "
                "ON project_records (project_id, status)"
            )
            connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_project_records_pathology_number "
                "ON project_records (pathology_number)"
            )
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")

    def drop_all(self) -> None:
        from app import models  # noqa: F401

        Base.metadata.drop_all(self.engine)

    def dispose(self) -> None:
        self.engine.dispose()


def get_session(request: Request) -> Generator[Session]:
    database: Database = request.app.state.database
    with database.session_factory() as session:
        yield session


def get_engine(request: Request) -> Engine:
    database: Database = request.app.state.database
    return database.engine
