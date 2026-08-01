from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit import audit
from app.database import get_session
from app.models import AutoExportRun, AutoExportTask, Project
from app.schemas import AutoExportRunRead, AutoExportTaskInput, AutoExportTaskRead
from app.services.auto_exports import (
    AutoExportBusyError,
    AutoExportScheduler,
    compute_next_run,
    parse_cron_expression,
    validate_output_directory,
)

router = APIRouter(prefix="/auto-export", tags=["自动导出"])


def _validate_projects(session: Session, project_ids: list[str]) -> None:
    existing_ids = set(
        session.scalars(select(Project.id).where(Project.id.in_(project_ids)))
    )
    if len(existing_ids) != len(project_ids):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="包含不存在的检测项目")


def _prepare_directory(value: str) -> str:
    try:
        directory = validate_output_directory(value)
        directory.mkdir(parents=True, exist_ok=True)
    except (OSError, ValueError) as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"导出目录不可用：{error}",
        ) from error
    return str(directory)


def _validate_schedule(payload: AutoExportTaskInput) -> None:
    try:
        if payload.schedule_type == "cron":
            parse_cron_expression(payload.cron_expression or "")
        compute_next_run(payload)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(error),
        ) from error


def _apply_payload(task: AutoExportTask, payload: AutoExportTaskInput) -> None:
    task.name = payload.name
    task.project_ids = payload.project_ids
    task.output_directory = payload.output_directory
    task.file_format = payload.file_format
    task.schedule_type = payload.schedule_type
    task.preset = payload.preset
    task.run_time = payload.run_time
    task.hourly_minute = payload.hourly_minute
    task.weekday = payload.weekday
    task.month_day = payload.month_day
    task.cron_expression = payload.cron_expression
    task.failure_retries = payload.failure_retries
    task.retention_count = payload.retention_count
    task.enabled = payload.enabled
    task.next_run_at = compute_next_run(task) if task.enabled else None


@router.get("/config")
def get_auto_export_config(request: Request) -> dict:
    return {
        "default_output_directory": str(request.app.state.settings.auto_export_dir),
        "timezone": "Asia/Shanghai",
        "cron_format": "分钟 小时 日期 月份 星期",
    }


@router.get("/tasks", response_model=list[AutoExportTaskRead])
def list_auto_export_tasks(session: Session = Depends(get_session)) -> list[AutoExportTask]:
    return list(
        session.scalars(
            select(AutoExportTask).order_by(AutoExportTask.created_at, AutoExportTask.id)
        )
    )


@router.post("/tasks", response_model=AutoExportTaskRead, status_code=status.HTTP_201_CREATED)
def create_auto_export_task(
    payload: AutoExportTaskInput,
    session: Session = Depends(get_session),
) -> AutoExportTask:
    _validate_projects(session, payload.project_ids)
    payload.output_directory = _prepare_directory(payload.output_directory)
    _validate_schedule(payload)
    task = AutoExportTask()
    _apply_payload(task, payload)
    session.add(task)
    try:
        session.flush()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务名称已存在") from error
    audit(
        session,
        "auto_export.task.create",
        "auto_export_task",
        task.id,
        {"name": task.name, "project_ids": task.project_ids},
    )
    session.commit()
    session.refresh(task)
    return task


@router.put("/tasks/{task_id}", response_model=AutoExportTaskRead)
def update_auto_export_task(
    task_id: str,
    payload: AutoExportTaskInput,
    session: Session = Depends(get_session),
) -> AutoExportTask:
    task = session.get(AutoExportTask, task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="自动导出任务不存在")
    _validate_projects(session, payload.project_ids)
    payload.output_directory = _prepare_directory(payload.output_directory)
    _validate_schedule(payload)
    before = {
        "name": task.name,
        "enabled": task.enabled,
        "schedule_type": task.schedule_type,
        "preset": task.preset,
        "cron_expression": task.cron_expression,
    }
    _apply_payload(task, payload)
    try:
        session.flush()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务名称已存在") from error
    audit(
        session,
        "auto_export.task.update",
        "auto_export_task",
        task.id,
        {
            "before": before,
            "after": {
                "name": task.name,
                "enabled": task.enabled,
                "schedule_type": task.schedule_type,
                "preset": task.preset,
                "cron_expression": task.cron_expression,
            },
        },
    )
    session.commit()
    session.refresh(task)
    return task


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_auto_export_task(
    task_id: str,
    session: Session = Depends(get_session),
) -> Response:
    task = session.get(AutoExportTask, task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="自动导出任务不存在")
    audit(
        session,
        "auto_export.task.delete",
        "auto_export_task",
        task.id,
        {"name": task.name},
    )
    session.delete(task)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/tasks/{task_id}/run", response_model=AutoExportRunRead)
async def run_auto_export_task(task_id: str, request: Request) -> AutoExportRun:
    scheduler: AutoExportScheduler = request.app.state.auto_export_scheduler
    try:
        run = await scheduler.run_task(task_id, "manual")
    except AutoExportBusyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    if run.status == "failed":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"自动导出失败（共尝试 {run.attempt_count} 次）：{run.error_message}",
        )
    return run


@router.get("/tasks/{task_id}/runs", response_model=list[AutoExportRunRead])
def list_auto_export_runs(
    task_id: str,
    limit: int = Query(default=20, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[AutoExportRun]:
    if not session.get(AutoExportTask, task_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="自动导出任务不存在")
    return list(
        session.scalars(
            select(AutoExportRun)
            .where(AutoExportRun.task_id == task_id)
            .order_by(AutoExportRun.started_at.desc())
            .limit(limit)
        )
    )


@router.post("/validate-cron")
def validate_cron(payload: dict) -> dict:
    expression = str(payload.get("expression", "")).strip()
    try:
        parse_cron_expression(expression)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(error),
        ) from error
    return {"valid": True, "expression": expression}
