from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import zipfile
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from sqlalchemy.engine import make_url

from app.audit import audit
from app.config import Settings
from app.database import (
    STRICT_DECIMAL_COLLATION,
    Database,
    compare_strict_decimals,
    strict_decimal_text,
)
from app.models import AppSetting
from app.schemas import DatabaseBackupSettings
from app.timezones import ASIA_SHANGHAI, utc_now

BACKUP_CONFIG_KEY = "database_backup_config"
BACKUP_STATUS_KEY = "database_backup_status"
BACKUP_FORMAT = "gene-lab-ledger-complete-backup"
BACKUP_FORMAT_VERSION = 1
BACKUP_EXTENSION = ".glbkp"
BACKUP_FILENAME_PATTERN = re.compile(
    r"^GeneLabLedger-(?P<stamp>\d{8}-\d{6}-\d{6})-(?P<reason>[a-z-]+)\.glbkp$"
)
DAY_DIRECTORY_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_ARCHIVE_FILES = 20_000
MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024
logger = logging.getLogger(__name__)


class BackupError(RuntimeError):
    pass


class BackupBusyError(BackupError):
    pass


def _database_path(database: Database) -> Path:
    if database.engine.dialect.name != "sqlite":
        raise BackupError("自动备份目前仅支持 SQLite 数据库")
    database_name = database.engine.url.database
    if not database_name or database_name == ":memory:":
        raise BackupError("内存数据库不能创建持久备份")
    return Path(database_name).resolve()


def _settings_database_path(settings: Settings) -> Path:
    url = make_url(settings.database_url or "")
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise BackupError("待恢复的数据目录没有可用的 SQLite 数据库路径")
    return Path(url.database).resolve()


def _configure_sqlite_connection(connection: sqlite3.Connection) -> None:
    connection.create_function("strict_number", 1, strict_decimal_text, deterministic=True)
    connection.create_collation(STRICT_DECIMAL_COLLATION, compare_strict_decimals)
    connection.execute("PRAGMA foreign_keys=ON")


def _check_database(path: Path) -> None:
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(path, timeout=30)
        _configure_sqlite_connection(connection)
        rows = connection.execute("PRAGMA quick_check").fetchall()
        if rows != [("ok",)]:
            messages = "；".join(str(row[0]) for row in rows[:10])
            raise BackupError(f"数据库完整性检查失败：{messages}")
    except sqlite3.Error as error:
        raise BackupError(f"数据库文件无法读取：{error}") from error
    finally:
        if connection is not None:
            connection.close()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_zip_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    digest = hashlib.sha256()
    with archive.open(info, "r") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json_setting(database: Database, key: str) -> dict[str, Any]:
    with database.session_factory() as session:
        setting = session.get(AppSetting, key)
        if not setting:
            return {}
        try:
            value = json.loads(setting.value)
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}


def _write_json_setting(database: Database, key: str, value: dict[str, Any]) -> None:
    serialized = json.dumps(value, ensure_ascii=False)
    with database.session_factory() as session:
        setting = session.get(AppSetting, key)
        if setting:
            setting.value = serialized
        else:
            session.add(AppSetting(key=key, value=serialized))
        session.commit()


def default_backup_settings(settings: Settings) -> DatabaseBackupSettings:
    return DatabaseBackupSettings(directory=str(settings.backup_dir.resolve()))


def load_backup_settings(database: Database, settings: Settings) -> DatabaseBackupSettings:
    raw = _read_json_setting(database, BACKUP_CONFIG_KEY)
    if not raw:
        return default_backup_settings(settings)
    try:
        result = DatabaseBackupSettings.model_validate(raw)
    except ValueError:
        logger.warning("数据库备份设置无效，已回退到默认值")
        return default_backup_settings(settings)
    if not result.directory.strip():
        result.directory = str(settings.backup_dir.resolve())
    return result


def validate_backup_directory(settings: Settings, value: str) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise BackupError("备份位置必须使用绝对路径")
    directory = candidate.resolve()
    template_root = settings.template_dir.resolve()
    if directory == template_root or template_root in directory.parents:
        raise BackupError("备份位置不能放在报告模板目录内")
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".backup-write-test-", dir=directory, delete=True):
            pass
    except OSError as error:
        raise BackupError(f"备份位置不可写：{error}") from error
    return directory


def save_backup_settings(
    database: Database,
    settings: Settings,
    payload: DatabaseBackupSettings,
) -> DatabaseBackupSettings:
    directory = validate_backup_directory(settings, payload.directory or str(settings.backup_dir))
    normalized = payload.model_copy(update={"directory": str(directory)})
    with database.session_factory() as session:
        serialized = json.dumps(normalized.model_dump(mode="json"), ensure_ascii=False)
        setting = session.get(AppSetting, BACKUP_CONFIG_KEY)
        if setting:
            setting.value = serialized
        else:
            session.add(AppSetting(key=BACKUP_CONFIG_KEY, value=serialized))
        audit(
            session,
            "database_backup.settings.update",
            "database_backup",
            BACKUP_CONFIG_KEY,
            normalized.model_dump(mode="json"),
        )
        session.commit()
    return normalized


def load_backup_status(database: Database) -> dict[str, Any]:
    return _read_json_setting(database, BACKUP_STATUS_KEY)


def _write_backup_status(
    database: Database,
    *,
    success: bool,
    reason: str,
    path: Path | None = None,
    error: str | None = None,
) -> None:
    now = utc_now()
    current = load_backup_status(database)
    if success:
        current.update(
            {
                "last_success_at": now.isoformat(),
                "last_error": None,
                "last_path": str(path) if path else None,
                "last_reason": reason,
            }
        )
    else:
        current.update(
            {
                "last_failure_at": now.isoformat(),
                "last_error": error or "未知错误",
                "last_reason": reason,
            }
        )
    _write_json_setting(database, BACKUP_STATUS_KEY, current)


def _snapshot_database(database: Database, destination: Path) -> None:
    source_proxy = database.engine.raw_connection()
    target: sqlite3.Connection | None = None
    try:
        source = source_proxy.driver_connection
        if not isinstance(source, sqlite3.Connection):
            raise BackupError("无法取得 SQLite 数据库连接")
        target = sqlite3.connect(destination, timeout=30)
        _configure_sqlite_connection(target)
        source.backup(target, pages=256, sleep=0.05)
    except sqlite3.Error as error:
        raise BackupError(f"SQLite 在线备份失败：{error}") from error
    finally:
        if target is not None:
            target.close()
        source_proxy.close()
    _check_database(destination)


def _template_files(template_root: Path) -> list[Path]:
    if not template_root.is_dir():
        return []
    files: list[Path] = []
    for path in template_root.rglob("*"):
        if path.is_symlink():
            continue
        if path.is_file():
            files.append(path)
    return sorted(files, key=lambda item: item.relative_to(template_root).as_posix())


def _build_archive(
    database: Database,
    settings: Settings,
    destination: Path,
    *,
    reason: str,
    created_at: datetime,
) -> None:
    temp_root = settings.data_dir / "temp" / "database-backups"
    temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="backup-", dir=temp_root) as temporary_directory:
        work_dir = Path(temporary_directory)
        snapshot = work_dir / "ledger.db"
        _snapshot_database(database, snapshot)
        file_entries: list[dict[str, Any]] = [
            {
                "path": "ledger.db",
                "size": snapshot.stat().st_size,
                "sha256": _sha256_file(snapshot),
            }
        ]
        templates = _template_files(settings.template_dir)
        for template_file in templates:
            relative = template_file.relative_to(settings.template_dir).as_posix()
            file_entries.append(
                {
                    "path": f"templates/{relative}",
                    "size": template_file.stat().st_size,
                    "sha256": _sha256_file(template_file),
                }
            )
        manifest = {
            "format": BACKUP_FORMAT,
            "format_version": BACKUP_FORMAT_VERSION,
            "created_at": created_at.isoformat(),
            "local_backup_date": created_at.astimezone(ASIA_SHANGHAI).date().isoformat(),
            "reason": reason,
            "files": file_entries,
        }
        local_archive = work_dir / "complete-backup.glbkp"
        with zipfile.ZipFile(
            local_archive,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            strict_timestamps=False,
        ) as archive:
            archive.write(snapshot, "ledger.db")
            for template_file in templates:
                relative = template_file.relative_to(settings.template_dir).as_posix()
                archive.write(template_file, f"templates/{relative}")
            archive.writestr(
                "manifest.json",
                json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
            )
        validate_backup_archive(local_archive)
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_name(f"{destination.name}.{uuid4().hex}.partial")
        try:
            with local_archive.open("rb") as source, partial.open("xb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
                target.flush()
                os.fsync(target.fileno())
            os.replace(partial, destination)
        finally:
            with suppress(FileNotFoundError):
                partial.unlink()


def _backup_files(day_directory: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in day_directory.iterdir()
            if path.is_file() and BACKUP_FILENAME_PATTERN.fullmatch(path.name)
        ),
        key=lambda path: path.name,
        reverse=True,
    )


def prune_backups(root: Path, *, retention_backup_days: int, copies_per_day: int) -> None:
    if not root.is_dir():
        return
    populated_days: list[tuple[str, Path]] = []
    for day_directory in root.iterdir():
        if not day_directory.is_dir() or not DAY_DIRECTORY_PATTERN.fullmatch(day_directory.name):
            continue
        try:
            datetime.strptime(day_directory.name, "%Y-%m-%d")
        except ValueError:
            continue
        files = _backup_files(day_directory)
        for old_file in files[copies_per_day:]:
            with suppress(OSError):
                old_file.unlink()
        if _backup_files(day_directory):
            populated_days.append((day_directory.name, day_directory))
    populated_days.sort(key=lambda item: item[0], reverse=True)
    for _, old_day_directory in populated_days[retention_backup_days:]:
        for old_file in _backup_files(old_day_directory):
            with suppress(OSError):
                old_file.unlink()
        try:
            old_day_directory.rmdir()
        except OSError:
            pass


def create_complete_backup(
    database: Database,
    settings: Settings,
    config: DatabaseBackupSettings,
    *,
    reason: str,
) -> dict[str, Any]:
    backup_root = validate_backup_directory(settings, config.directory)
    created_at = utc_now()
    local_time = created_at.astimezone(ASIA_SHANGHAI)
    day_directory = backup_root / local_time.date().isoformat()
    filename = (
        f"GeneLabLedger-{local_time.strftime('%Y%m%d-%H%M%S-%f')}-{reason}{BACKUP_EXTENSION}"
    )
    destination = day_directory / filename
    try:
        _build_archive(database, settings, destination, reason=reason, created_at=created_at)
        size_bytes = destination.stat().st_size
        _write_backup_status(database, success=True, reason=reason, path=destination)
        with database.session_factory() as session:
            audit(
                session,
                "database_backup.run.success",
                "database_backup",
                filename,
                {"path": str(destination), "reason": reason, "size_bytes": size_bytes},
            )
            session.commit()
        prune_backups(
            backup_root,
            retention_backup_days=config.retention_backup_days,
            copies_per_day=config.copies_per_day,
        )
        return {
            "path": str(destination),
            "created_at": created_at,
            "size_bytes": size_bytes,
            "reason": reason,
        }
    except Exception as error:
        message = str(error) or error.__class__.__name__
        with suppress(Exception):
            _write_backup_status(database, success=False, reason=reason, error=message)
        with suppress(Exception):
            with database.session_factory() as session:
                audit(
                    session,
                    "database_backup.run.failed",
                    "database_backup",
                    None,
                    {"reason": reason, "error": message},
                )
                session.commit()
        if isinstance(error, BackupError):
            raise
        raise BackupError(f"完整业务备份失败：{message}") from error


def list_backups(config: DatabaseBackupSettings, *, limit: int = 210) -> list[dict[str, Any]]:
    root = Path(config.directory)
    if not root.is_dir():
        return []
    result: list[dict[str, Any]] = []
    day_directories = sorted(
        (
            path
            for path in root.iterdir()
            if path.is_dir() and DAY_DIRECTORY_PATTERN.fullmatch(path.name)
        ),
        key=lambda path: path.name,
        reverse=True,
    )
    for day_directory in day_directories:
        try:
            backup_date = datetime.strptime(day_directory.name, "%Y-%m-%d").date()
        except ValueError:
            continue
        for path in _backup_files(day_directory):
            match = BACKUP_FILENAME_PATTERN.fullmatch(path.name)
            if not match:
                continue
            try:
                created_at = datetime.strptime(match.group("stamp"), "%Y%m%d-%H%M%S-%f").replace(
                    tzinfo=ASIA_SHANGHAI
                )
                size_bytes = path.stat().st_size
            except OSError:
                continue
            result.append(
                {
                    "path": str(path.resolve()),
                    "filename": path.name,
                    "backup_date": backup_date,
                    "created_at": created_at,
                    "size_bytes": size_bytes,
                }
            )
            if len(result) >= limit:
                return result
    return result


def _validated_archive_members(
    archive: zipfile.ZipFile,
) -> tuple[dict[str, Any], dict[str, zipfile.ZipInfo]]:
    infos = [info for info in archive.infolist() if not info.is_dir()]
    if len(infos) > MAX_ARCHIVE_FILES:
        raise BackupError("备份包文件数量超过安全限制")
    if sum(info.file_size for info in infos) > MAX_UNCOMPRESSED_BYTES:
        raise BackupError("备份包解压后的大小超过安全限制")
    members: dict[str, zipfile.ZipInfo] = {}
    for info in infos:
        if "\\" in info.filename or ":" in info.filename:
            raise BackupError("备份包包含不安全的 Windows 文件路径")
        member = PurePosixPath(info.filename)
        if member.is_absolute() or ".." in member.parts or "" in member.parts:
            raise BackupError("备份包包含不安全的文件路径")
        if info.filename in members:
            raise BackupError("备份包包含重复文件")
        unix_mode = info.external_attr >> 16
        if unix_mode and stat.S_ISLNK(unix_mode):
            raise BackupError("备份包不能包含符号链接")
        if info.filename not in {"ledger.db", "manifest.json"} and not info.filename.startswith(
            "templates/"
        ):
            raise BackupError("备份包包含无法识别的文件")
        members[info.filename] = info
    if "ledger.db" not in members or "manifest.json" not in members:
        raise BackupError("备份包缺少数据库或清单文件")
    bad_member = archive.testzip()
    if bad_member:
        raise BackupError(f"备份包校验失败：{bad_member}")
    try:
        manifest = json.loads(archive.read("manifest.json"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise BackupError("备份清单格式无效") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != BACKUP_FORMAT
        or manifest.get("format_version") != BACKUP_FORMAT_VERSION
    ):
        raise BackupError("备份包格式或版本不受支持")
    declared = manifest.get("files")
    if not isinstance(declared, list):
        raise BackupError("备份清单缺少文件列表")
    expected_paths = set(members) - {"manifest.json"}
    declared_paths: set[str] = set()
    for item in declared:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise BackupError("备份清单文件记录无效")
        path = item["path"]
        if path in declared_paths or path not in expected_paths:
            raise BackupError("备份清单与压缩包内容不一致")
        info = members[path]
        if item.get("size") != info.file_size or item.get("sha256") != _sha256_zip_member(
            archive, info
        ):
            raise BackupError(f"备份文件校验失败：{path}")
        declared_paths.add(path)
    if declared_paths != expected_paths:
        raise BackupError("备份清单没有覆盖全部业务文件")
    return manifest, members


def validate_backup_archive(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise BackupError("备份文件不存在")
    try:
        with zipfile.ZipFile(path, "r") as archive:
            manifest, _ = _validated_archive_members(archive)
            return manifest
    except zipfile.BadZipFile as error:
        raise BackupError("备份文件不是有效的完整业务备份包") from error


def _extract_restore_archive(path: Path, destination: Path) -> None:
    destination = destination.resolve()
    try:
        with zipfile.ZipFile(path, "r") as archive:
            _, members = _validated_archive_members(archive)
            for member_name, info in members.items():
                if member_name == "manifest.json":
                    continue
                target = destination.joinpath(*PurePosixPath(member_name).parts).resolve()
                if destination not in target.parents:
                    raise BackupError("备份包包含越出恢复目录的文件路径")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info, "r") as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
    except zipfile.BadZipFile as error:
        raise BackupError("备份文件不是有效的完整业务备份包") from error
    (destination / "templates").mkdir(parents=True, exist_ok=True)
    _check_database(destination / "ledger.db")


def prepare_restore(settings: Settings, backup_path: Path) -> None:
    source = backup_path.expanduser()
    if not source.is_absolute():
        raise BackupError("恢复文件必须使用绝对路径")
    source = source.resolve()
    validate_backup_archive(source)
    marker = settings.data_dir / ".pending-database-restore.json"
    if marker.exists():
        raise BackupError("已经有一个等待重启执行的恢复任务")
    staging_parent = settings.data_dir / "temp" / "database-restores"
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging = staging_parent / f"restore-{uuid4().hex}"
    staging.mkdir(parents=False, exist_ok=False)
    try:
        _extract_restore_archive(source, staging)
        marker_partial = marker.with_suffix(".json.partial")
        marker_partial.write_text(
            json.dumps(
                {"staging_directory": str(staging.resolve()), "source_backup_path": str(source)},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        os.replace(marker_partial, marker)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def apply_pending_restore(settings: Settings) -> bool:
    marker = settings.data_dir / ".pending-database-restore.json"
    if not marker.is_file():
        return False
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
        staging = Path(str(payload["staging_directory"])).resolve()
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        raise BackupError("待恢复任务记录已损坏") from error
    staging_root = (settings.data_dir / "temp" / "database-restores").resolve()
    if staging == staging_root or staging_root not in staging.parents:
        raise BackupError("待恢复目录不在受控范围内")
    staged_database = staging / "ledger.db"
    staged_templates = staging / "templates"
    _check_database(staged_database)
    if not staged_templates.is_dir():
        raise BackupError("待恢复任务缺少报告模板目录")
    database_path = _settings_database_path(settings)
    current_templates = settings.template_dir.resolve()
    rollback = settings.data_dir / "temp" / f"restore-rollback-{uuid4().hex}"
    rollback.mkdir(parents=True, exist_ok=False)
    moved_database_files: list[tuple[Path, Path]] = []
    moved_templates = False
    try:
        for source_path in (
            database_path,
            Path(f"{database_path}-wal"),
            Path(f"{database_path}-shm"),
        ):
            if source_path.exists():
                rollback_path = rollback / source_path.name
                os.replace(source_path, rollback_path)
                moved_database_files.append((source_path, rollback_path))
        if current_templates.exists():
            os.replace(current_templates, rollback / "templates")
            moved_templates = True
        database_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged_database, database_path)
        os.replace(staged_templates, current_templates)
        _check_database(database_path)
    except Exception:
        with suppress(OSError):
            if database_path.exists():
                database_path.unlink()
        for original_path, rollback_path in moved_database_files:
            if rollback_path.exists():
                os.replace(rollback_path, original_path)
        with suppress(OSError):
            if current_templates.exists():
                shutil.rmtree(current_templates)
        if moved_templates and (rollback / "templates").exists():
            os.replace(rollback / "templates", current_templates)
        raise
    marker.unlink()
    shutil.rmtree(rollback, ignore_errors=True)
    shutil.rmtree(staging, ignore_errors=True)
    return True


class DatabaseBackupScheduler:
    def __init__(
        self,
        database: Database,
        settings: Settings,
        *,
        poll_seconds: int = 30,
    ) -> None:
        self.database = database
        self.settings = settings
        self.poll_seconds = poll_seconds
        self._loop_task: asyncio.Task[None] | None = None
        self._job: asyncio.Task[dict[str, Any]] | None = None
        self._lock = asyncio.Lock()
        self._stopping = False
        self._next_run_at: datetime | None = None

    @property
    def running(self) -> bool:
        return self._lock.locked()

    @property
    def next_run_at(self) -> datetime | None:
        return self._next_run_at

    async def start(self) -> None:
        self._stopping = False
        self.refresh_schedule()
        self._loop_task = asyncio.create_task(self._loop())

    async def stop(self, *, create_shutdown_backup: bool) -> None:
        self._stopping = True
        if self._loop_task:
            self._loop_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._loop_task
            self._loop_task = None
        if self._job:
            await asyncio.gather(self._job, return_exceptions=True)
            self._job = None
        config = load_backup_settings(self.database, self.settings)
        if create_shutdown_backup and config.backup_on_shutdown:
            try:
                await self.run_backup("shutdown", allow_stopping=True)
            except Exception:  # noqa: BLE001
                logger.exception("退出前数据库备份失败")

    def refresh_schedule(self) -> None:
        config = load_backup_settings(self.database, self.settings)
        if not config.enabled:
            self._next_run_at = None
            return
        status = load_backup_status(self.database)
        last_success_raw = status.get("last_success_at")
        last_success: datetime | None = None
        if isinstance(last_success_raw, str):
            with suppress(ValueError):
                last_success = datetime.fromisoformat(last_success_raw)
        now = utc_now()
        if last_success is None:
            self._next_run_at = now + timedelta(hours=config.interval_hours)
        else:
            due = last_success + timedelta(hours=config.interval_hours)
            self._next_run_at = now if due <= now else due

    async def _loop(self) -> None:
        while True:
            try:
                config = await asyncio.to_thread(load_backup_settings, self.database, self.settings)
                if config.enabled and self._next_run_at and self._next_run_at <= utc_now():
                    if not self.running and (self._job is None or self._job.done()):
                        self._job = asyncio.create_task(self._run_scheduled())
                elif not config.enabled:
                    self._next_run_at = None
            except Exception:  # noqa: BLE001
                logger.exception("数据库备份调度器轮询失败")
            await asyncio.sleep(self.poll_seconds)

    async def _run_scheduled(self) -> dict[str, Any]:
        try:
            return await self.run_backup("scheduled")
        except Exception:  # noqa: BLE001
            logger.exception("定时数据库备份失败")
            config = await asyncio.to_thread(load_backup_settings, self.database, self.settings)
            self._next_run_at = utc_now() + timedelta(hours=config.interval_hours)
            return {}

    async def run_backup(
        self,
        reason: str = "manual",
        *,
        allow_stopping: bool = False,
    ) -> dict[str, Any]:
        if self._stopping and not allow_stopping:
            raise BackupBusyError("应用正在退出")
        if self._lock.locked():
            raise BackupBusyError("数据库备份正在执行，请稍后再试")
        async with self._lock:
            config = await asyncio.to_thread(load_backup_settings, self.database, self.settings)
            result = await asyncio.to_thread(
                create_complete_backup,
                self.database,
                self.settings,
                config,
                reason=reason,
            )
            self._next_run_at = utc_now() + timedelta(hours=config.interval_hours)
            return result
