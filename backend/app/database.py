from __future__ import annotations

import shutil
from collections.abc import Generator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Request
from sqlalchemy import DateTime, Engine, create_engine, event, text
from sqlalchemy.engine import Connection
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
        self._migrate_record_experiment_number_uniqueness()
        self._migrate_v010_field_validation()
        self._migrate_record_positions()
        Base.metadata.create_all(self.engine)

    @staticmethod
    def _sqlite_unique_columns(connection: Connection, table_name: str) -> set[tuple[str, ...]]:
        result: set[tuple[str, ...]] = set()
        escaped_table = table_name.replace('"', '""')
        for row in connection.exec_driver_sql(
            f'PRAGMA index_list("{escaped_table}")'
        ):
            if not bool(row[2]):
                continue
            index_name = str(row[1]).replace('"', '""')
            columns = tuple(
                str(item[2])
                for item in connection.exec_driver_sql(
                    f'PRAGMA index_info("{index_name}")'
                )
            )
            result.add(columns)
        return result

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
            record_columns = {
                str(row[1])
                for row in connection.exec_driver_sql("PRAGMA table_info(project_records)")
            }
            record_unique_columns = self._sqlite_unique_columns(connection, "project_records")
        needs_validation_upgrade = bool(field_columns) and not {
            "validation_mode",
            "validation_rules",
        }.issubset(field_columns)
        needs_default_upgrade = bool(field_columns) and "default_value" not in field_columns
        needs_v010_upgrade = needs_validation_upgrade or not view_exists
        needs_position_upgrade = bool(record_columns) and "position" not in record_columns
        needs_number_upgrade = any(
            "experiment_number" in columns for columns in record_unique_columns
        )
        needs_upgrade = (
            needs_v010_upgrade
            or needs_default_upgrade
            or needs_position_upgrade
            or needs_number_upgrade
        )
        if not needs_upgrade:
            return
        backup_dir = database_path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        if needs_position_upgrade:
            version = "v0.10.1"
        elif needs_v010_upgrade:
            version = "v0.10.0"
        else:
            version = "v0.11.0"
        backup_path = backup_dir / f"ledger-before-{version}-{timestamp}.db"
        suffix = 1
        while backup_path.exists():
            backup_path = backup_dir / f"ledger-before-{version}-{timestamp}-{suffix}.db"
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
            if "default_value" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE field_definitions ADD COLUMN default_value TEXT"
                )

    def _migrate_record_positions(self) -> None:
        """Add and backfill stable per-project row positions for packaged desktops."""
        if self.engine.dialect.name != "sqlite":
            return
        with self.engine.begin() as connection:
            table_exists = connection.exec_driver_sql(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_records'"
            ).scalar()
            if not table_exists:
                return
            columns = {
                str(row[1])
                for row in connection.exec_driver_sql("PRAGMA table_info(project_records)")
            }
            if "position" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE project_records ADD COLUMN position INTEGER NOT NULL DEFAULT 0"
                )
                rows = connection.execute(
                    text(
                        "SELECT id, project_id FROM project_records "
                        "ORDER BY project_id, created_at, id"
                    )
                ).all()
                counters: dict[str, int] = {}
                updates = []
                for record_id, project_id in rows:
                    position = counters.get(project_id, 0) + 1
                    counters[project_id] = position
                    updates.append({"record_id": record_id, "position": position})
                if updates:
                    connection.execute(
                        text(
                            "UPDATE project_records SET position = :position "
                            "WHERE id = :record_id"
                        ),
                        updates,
                    )
            connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_record_project_position "
                "ON project_records (project_id, position)"
            )

    def _migrate_record_experiment_number_uniqueness(self) -> None:
        """Remove legacy experiment-number uniqueness constraints in SQLite.

        ``create_all`` intentionally does not alter existing tables.  Ledger
        experiment numbers may repeat, so an existing local database is
        rebuilt once while preserving every row and foreign-key target.
        """
        if self.engine.dialect.name != "sqlite":
            return
        with self.engine.connect() as connection:
            table_exists = connection.exec_driver_sql(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_records'"
            ).scalar()
            if not table_exists:
                return
            unique_columns = self._sqlite_unique_columns(connection, "project_records")
            if not any("experiment_number" in columns for columns in unique_columns):
                return
            legacy_columns = {
                str(row[1])
                for row in connection.exec_driver_sql("PRAGMA table_info(project_records)")
            }
            connection.commit()
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            if bool(connection.exec_driver_sql("PRAGMA foreign_keys").scalar()):
                raise RuntimeError("无法暂停 SQLite 外键检查，数据库升级已取消")
            connection.commit()

            def source(column: str, fallback: str) -> str:
                return f'"{column}"' if column in legacy_columns else fallback

            try:
                with connection.begin():
                    connection.exec_driver_sql("DROP TABLE IF EXISTS project_records_number_new")
                    connection.exec_driver_sql(
                        """
                        CREATE TABLE project_records_number_new (
                            id VARCHAR(36) NOT NULL,
                            project_id VARCHAR(36) NOT NULL,
                            position INTEGER NOT NULL,
                            status VARCHAR(40) NOT NULL,
                            experiment_date DATE,
                            pathology_number VARCHAR(160) NOT NULL,
                            experiment_number VARCHAR(80),
                            report_generated BOOLEAN DEFAULT 0 NOT NULL,
                            locked BOOLEAN NOT NULL,
                            highlight_color VARCHAR(7),
                            cell_highlight_colors JSON NOT NULL,
                            created_at DATETIME NOT NULL,
                            updated_at DATETIME NOT NULL,
                            PRIMARY KEY (id),
                            FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE RESTRICT
                        )
                        """
                    )
                    target_columns = (
                        "id",
                        "project_id",
                        "position",
                        "status",
                        "experiment_date",
                        "pathology_number",
                        "experiment_number",
                        "report_generated",
                        "locked",
                        "highlight_color",
                        "cell_highlight_colors",
                        "created_at",
                        "updated_at",
                    )
                    source_expressions = (
                        source("id", "''"),
                        source("project_id", "''"),
                        source("position", "0"),
                        source("status", "'待实验'"),
                        source("experiment_date", "NULL"),
                        source("pathology_number", "''"),
                        source("experiment_number", "NULL"),
                        source("report_generated", "0"),
                        source("locked", "0"),
                        source("highlight_color", "NULL"),
                        source("cell_highlight_colors", "'{}'"),
                        source("created_at", "CURRENT_TIMESTAMP"),
                        source("updated_at", "CURRENT_TIMESTAMP"),
                    )
                    connection.exec_driver_sql(
                        "INSERT INTO project_records_number_new "
                        f"({', '.join(target_columns)}) "
                        f"SELECT {', '.join(source_expressions)} FROM project_records"
                    )
                    connection.exec_driver_sql("DROP TABLE project_records")
                    connection.exec_driver_sql(
                        "ALTER TABLE project_records_number_new RENAME TO project_records"
                    )
                    rows = connection.exec_driver_sql(
                        "SELECT id, project_id FROM project_records "
                        "ORDER BY project_id, created_at, id"
                    ).all()
                    counters: dict[str, int] = {}
                    for record_id, project_id in rows:
                        position = counters.get(project_id, 0) + 1
                        counters[project_id] = position
                        connection.execute(
                            text(
                                "UPDATE project_records SET position = :position "
                                "WHERE id = :record_id"
                            ),
                            {"record_id": record_id, "position": position},
                        )
                    connection.exec_driver_sql(
                        "CREATE INDEX ix_record_project_status "
                        "ON project_records (project_id, status)"
                    )
                    connection.exec_driver_sql(
                        "CREATE INDEX ix_record_project_position "
                        "ON project_records (project_id, position)"
                    )
                    connection.exec_driver_sql(
                        "CREATE INDEX ix_project_records_pathology_number "
                        "ON project_records (pathology_number)"
                    )
                    foreign_key_errors = connection.exec_driver_sql(
                        "PRAGMA foreign_key_check"
                    ).all()
                    if foreign_key_errors:
                        raise RuntimeError(
                            "SQLite 外键检查失败，数据库升级已回滚："
                            f"{foreign_key_errors[:3]}"
                        )
            finally:
                if connection.in_transaction():
                    connection.rollback()
                connection.exec_driver_sql("PRAGMA foreign_keys=ON")
                connection.commit()

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
