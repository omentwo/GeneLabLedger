from __future__ import annotations

import asyncio
import calendar
import logging
import re
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import Database
from app.models import (
    AutoExportRun,
    AutoExportTask,
    FieldDefinition,
    Project,
    ProjectRecord,
    RecordValue,
)
from app.services.workbooks import write_xlsx
from app.timezones import ASIA_SHANGHAI, utc_now

LOCAL_TIMEZONE = ASIA_SHANGHAI
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
CRON_FIELD_NAMES = ("分钟", "小时", "日期", "月份", "星期")
logger = logging.getLogger(__name__)


class TaskSchedule(Protocol):
    schedule_type: str
    preset: str
    run_time: str
    hourly_minute: int
    weekday: int
    month_day: int
    cron_expression: str | None


class AutoExportBusyError(RuntimeError):
    pass


def _parse_cron_field(
    expression: str,
    minimum: int,
    maximum: int,
    *,
    allow_sunday_seven: bool = False,
) -> tuple[set[int], bool]:
    expression = expression.strip()
    if not expression:
        raise ValueError("Cron 字段不能为空")
    wildcard = expression == "*"
    values: set[int] = set()
    for part in expression.split(","):
        part = part.strip()
        if not part:
            raise ValueError("Cron 列表中存在空值")
        base, separator, step_text = part.partition("/")
        try:
            step = int(step_text) if separator else 1
        except ValueError as error:
            raise ValueError(f"Cron 步长无效：{part}") from error
        if step < 1:
            raise ValueError(f"Cron 步长必须大于 0：{part}")
        if base == "*":
            start, end = minimum, maximum
        elif "-" in base:
            start_text, end_text = base.split("-", 1)
            try:
                start, end = int(start_text), int(end_text)
            except ValueError as error:
                raise ValueError(f"Cron 范围无效：{part}") from error
        else:
            try:
                start = end = int(base)
            except ValueError as error:
                raise ValueError(f"Cron 数值无效：{part}") from error
        allowed_maximum = 7 if allow_sunday_seven else maximum
        if start < minimum or end > allowed_maximum or start > end:
            raise ValueError(f"Cron 数值超出范围：{part}")
        for value in range(start, end + 1, step):
            values.add(0 if allow_sunday_seven and value == 7 else value)
    return values, wildcard


def parse_cron_expression(
    expression: str,
) -> tuple[set[int], set[int], set[int], set[int], set[int], bool, bool]:
    parts = expression.split()
    if len(parts) != 5:
        raise ValueError("Cron 表达式必须包含 5 段：分钟 小时 日期 月份 星期")
    try:
        minutes, _ = _parse_cron_field(parts[0], 0, 59)
        hours, _ = _parse_cron_field(parts[1], 0, 23)
        month_days, month_day_wildcard = _parse_cron_field(parts[2], 1, 31)
        months, _ = _parse_cron_field(parts[3], 1, 12)
        weekdays, weekday_wildcard = _parse_cron_field(parts[4], 0, 6, allow_sunday_seven=True)
    except ValueError as error:
        field_index = next(
            (index for index, part in enumerate(parts) if part and part in str(error)),
            None,
        )
        if field_index is not None:
            raise ValueError(f"{CRON_FIELD_NAMES[field_index]}字段错误：{error}") from error
        raise
    return (
        minutes,
        hours,
        month_days,
        months,
        weekdays,
        month_day_wildcard,
        weekday_wildcard,
    )


def _next_cron_run(expression: str, after_local: datetime) -> datetime:
    (
        minutes,
        hours,
        month_days,
        months,
        weekdays,
        month_day_wildcard,
        weekday_wildcard,
    ) = parse_cron_expression(expression)
    first_candidate = after_local.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for day_offset in range(366 * 8):
        day = (first_candidate + timedelta(days=day_offset)).date()
        if day.month not in months:
            continue
        cron_weekday = (day.weekday() + 1) % 7
        month_day_matches = day.day in month_days
        weekday_matches = cron_weekday in weekdays
        if month_day_wildcard and weekday_wildcard:
            day_matches = True
        elif month_day_wildcard:
            day_matches = weekday_matches
        elif weekday_wildcard:
            day_matches = month_day_matches
        else:
            day_matches = month_day_matches or weekday_matches
        if not day_matches:
            continue
        for hour in sorted(hours):
            for minute in sorted(minutes):
                candidate = datetime(
                    day.year,
                    day.month,
                    day.day,
                    hour,
                    minute,
                    tzinfo=LOCAL_TIMEZONE,
                )
                if candidate >= first_candidate:
                    return candidate
    raise ValueError("Cron 表达式在未来 8 年内没有可执行时间")


def _next_preset_run(schedule: TaskSchedule, after_local: datetime) -> datetime:
    hour, minute = (int(value) for value in schedule.run_time.split(":", 1))
    if schedule.preset == "hourly":
        candidate = after_local.replace(
            minute=schedule.hourly_minute,
            second=0,
            microsecond=0,
        )
        if candidate <= after_local:
            candidate += timedelta(hours=1)
        return candidate
    if schedule.preset == "daily":
        candidate = after_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return candidate if candidate > after_local else candidate + timedelta(days=1)
    if schedule.preset == "weekly":
        days_ahead = (schedule.weekday - after_local.weekday()) % 7
        candidate_date = (after_local + timedelta(days=days_ahead)).date()
        candidate = datetime(
            candidate_date.year,
            candidate_date.month,
            candidate_date.day,
            hour,
            minute,
            tzinfo=LOCAL_TIMEZONE,
        )
        return candidate if candidate > after_local else candidate + timedelta(days=7)
    if schedule.preset == "monthly":
        year, month = after_local.year, after_local.month
        for _ in range(12 * 8):
            last_day = calendar.monthrange(year, month)[1]
            if schedule.month_day <= last_day:
                candidate = datetime(
                    year,
                    month,
                    schedule.month_day,
                    hour,
                    minute,
                    tzinfo=LOCAL_TIMEZONE,
                )
                if candidate > after_local:
                    return candidate
            month += 1
            if month == 13:
                year += 1
                month = 1
        raise ValueError("月度周期在未来 8 年内没有可执行时间")
    raise ValueError("不支持的预设周期")


def compute_next_run(schedule: TaskSchedule, after_utc: datetime | None = None) -> datetime:
    reference_utc = after_utc or utc_now()
    if reference_utc.tzinfo is None:
        reference_utc = reference_utc.replace(tzinfo=UTC)
    else:
        reference_utc = reference_utc.astimezone(UTC)
    after_local = reference_utc.astimezone(LOCAL_TIMEZONE)
    if schedule.schedule_type == "cron":
        if not schedule.cron_expression:
            raise ValueError("Cron 表达式不能为空")
        next_local = _next_cron_run(schedule.cron_expression, after_local)
    else:
        next_local = _next_preset_run(schedule, after_local)
    return next_local.astimezone(UTC)


def validate_output_directory(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("导出目录必须是绝对路径，例如 D:\\实验室导出")
    return path


def _safe_filename(value: str) -> str:
    cleaned = INVALID_FILENAME_CHARS.sub("_", value).strip(" ._")
    return cleaned[:100] or "自动导出"


def _field_value(record: ProjectRecord, field: FieldDefinition, values: dict[str, str]) -> str:
    if field.system_key == "experiment_date":
        return record.experiment_date.isoformat() if record.experiment_date else ""
    if field.system_key == "pathology_number":
        return record.pathology_number
    if field.system_key == "status":
        return record.status
    if field.system_key == "experiment_number":
        return record.experiment_number or ""
    return values.get(field.id, "")


def create_export_file(session: Session, task: AutoExportTask) -> Path:
    output_directory = validate_output_directory(task.output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    projects = list(
        session.scalars(
            select(Project)
            .where(Project.id.in_(task.project_ids))
            .options(selectinload(Project.fields))
            .order_by(Project.sort_order, Project.created_at)
        )
    )
    found_ids = {project.id for project in projects}
    missing_ids = [project_id for project_id in task.project_ids if project_id not in found_ids]
    if missing_ids:
        raise ValueError("任务中包含已删除的检测项目，请重新保存任务")
    sheets: list[tuple[str, list[str], list[list[str]]]] = []
    for project in projects:
        fields = sorted(
            (field for field in project.fields if not field.hidden),
            key=lambda field: (field.sort_order, field.created_at),
        )
        records = list(
            session.scalars(
                select(ProjectRecord)
                .where(ProjectRecord.project_id == project.id)
                .options(
                    selectinload(ProjectRecord.values).selectinload(RecordValue.field),
                )
                .order_by(ProjectRecord.created_at, ProjectRecord.id)
            )
        )
        rows = []
        for record in records:
            values = {value.field_id: value.value_text for value in record.values}
            rows.append([_field_value(record, field, values) for field in fields])
        sheets.append((project.name, [field.label for field in fields], rows))
    if not sheets:
        raise ValueError("任务没有可导出的检测项目")
    timestamp = datetime.now(LOCAL_TIMEZONE).strftime("%Y%m%d_%H%M%S")
    path = output_directory / f"{_safe_filename(task.name)}_{timestamp}.xlsx"
    if path.exists():
        path = output_directory / f"{_safe_filename(task.name)}_{timestamp}_{uuid4().hex[:6]}.xlsx"
    write_xlsx(path, sheets)
    return path


def _is_path_inside(path: Path, directory: Path) -> bool:
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def apply_retention_policy(session: Session, task: AutoExportTask) -> None:
    if task.retention_count is None:
        return
    successful_runs = list(
        session.scalars(
            select(AutoExportRun)
            .where(AutoExportRun.task_id == task.id, AutoExportRun.status == "success")
            .order_by(AutoExportRun.finished_at.desc(), AutoExportRun.started_at.desc())
        )
    )
    output_directory = validate_output_directory(task.output_directory)
    for old_run in successful_runs[task.retention_count :]:
        if not old_run.file_path:
            continue
        file_path = Path(old_run.file_path)
        if _is_path_inside(file_path, output_directory):
            with suppress(FileNotFoundError):
                file_path.unlink()
        old_run.file_path = None


def execute_auto_export_task(database: Database, task_id: str, trigger: str) -> AutoExportRun:
    with database.session_factory() as session:
        task = session.get(AutoExportTask, task_id)
        if not task:
            raise ValueError("自动导出任务不存在")
        run = AutoExportRun(task_id=task.id, trigger=trigger, status="running")
        session.add(run)
        session.commit()
        run_id = run.id

    attempts = 0
    last_error: Exception | None = None
    while True:
        attempts += 1
        try:
            with database.session_factory() as session:
                task = session.get(AutoExportTask, task_id)
                if not task:
                    raise ValueError("自动导出任务不存在")
                output_path = create_export_file(session, task)
                run = session.get(AutoExportRun, run_id)
                if not run:
                    raise ValueError("自动导出执行记录不存在")
                finished_at = utc_now()
                run.status = "success"
                run.attempt_count = attempts
                run.file_path = str(output_path)
                run.finished_at = finished_at
                task.last_run_at = finished_at
                task.last_status = "success"
                task.last_message = f"已导出到 {output_path}"
                task.next_run_at = compute_next_run(task, finished_at) if task.enabled else None
                session.flush()
                apply_retention_policy(session, task)
                audit(
                    session,
                    "auto_export.run.success",
                    "auto_export_task",
                    task.id,
                    {"name": task.name, "attempts": attempts, "file_path": str(output_path)},
                )
                session.commit()
                session.refresh(run)
                return run
        except Exception as error:  # noqa: BLE001
            last_error = error
            with database.session_factory() as session:
                task = session.get(AutoExportTask, task_id)
                retry_limit = task.failure_retries if task else 0
            if attempts > retry_limit:
                break

    with database.session_factory() as session:
        task = session.get(AutoExportTask, task_id)
        run = session.get(AutoExportRun, run_id)
        if not task or not run:
            raise last_error or RuntimeError("自动导出执行失败")
        finished_at = utc_now()
        message = str(last_error or "未知错误")
        run.status = "failed"
        run.attempt_count = attempts
        run.error_message = message
        run.finished_at = finished_at
        task.last_run_at = finished_at
        task.last_status = "failed"
        task.last_message = message
        task.next_run_at = compute_next_run(task, finished_at) if task.enabled else None
        audit(
            session,
            "auto_export.run.failed",
            "auto_export_task",
            task.id,
            {"name": task.name, "attempts": attempts, "error": message},
        )
        session.commit()
        session.refresh(run)
        return run


class AutoExportScheduler:
    def __init__(self, database: Database, poll_seconds: int = 20) -> None:
        self.database = database
        self.poll_seconds = poll_seconds
        self._loop_task: asyncio.Task[None] | None = None
        self._running_task_ids: set[str] = set()

    async def start(self) -> None:
        await asyncio.to_thread(self._recover_interrupted_runs)
        self._loop_task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if not self._loop_task:
            return
        self._loop_task.cancel()
        with suppress(asyncio.CancelledError):
            await self._loop_task

    def _recover_interrupted_runs(self) -> None:
        now = utc_now()
        with self.database.session_factory() as session:
            interrupted = list(
                session.scalars(select(AutoExportRun).where(AutoExportRun.status == "running"))
            )
            for run in interrupted:
                run.status = "failed"
                run.finished_at = now
                run.error_message = "应用上次运行期间退出，任务已中断"
            tasks = list(session.scalars(select(AutoExportTask).where(AutoExportTask.enabled.is_(True))))
            for task in tasks:
                if task.next_run_at is None:
                    task.next_run_at = compute_next_run(task, now)
            session.commit()

    def _due_task_ids(self) -> list[str]:
        now = utc_now()
        with self.database.session_factory() as session:
            return list(
                session.scalars(
                    select(AutoExportTask.id).where(
                        AutoExportTask.enabled.is_(True),
                        AutoExportTask.next_run_at.is_not(None),
                        AutoExportTask.next_run_at <= now,
                    )
                )
            )

    async def _loop(self) -> None:
        while True:
            try:
                due_task_ids = await asyncio.to_thread(self._due_task_ids)
                for task_id in due_task_ids:
                    if task_id not in self._running_task_ids:
                        asyncio.create_task(self.run_task(task_id, "scheduled"))
            except Exception:  # noqa: BLE001
                logger.exception("自动导出调度器轮询失败")
            await asyncio.sleep(self.poll_seconds)

    async def run_task(self, task_id: str, trigger: str = "manual") -> AutoExportRun:
        if task_id in self._running_task_ids:
            raise AutoExportBusyError("该任务正在执行，请稍后再试")
        self._running_task_ids.add(task_id)
        try:
            return await asyncio.to_thread(execute_auto_export_task, self.database, task_id, trigger)
        finally:
            self._running_task_ids.discard(task_id)


def disable_tasks_for_deleted_project(session: Session, project_id: str) -> None:
    tasks = list(session.scalars(select(AutoExportTask)))
    for task in tasks:
        if project_id in task.project_ids:
            task.enabled = False
            task.next_run_at = None
            task.last_message = "任务包含已删除的检测项目，已自动停用"


def clear_next_runs(session: Session) -> None:
    session.execute(update(AutoExportTask).values(next_run_at=None))
