from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request, status

from app.schemas import (
    DatabaseBackupItemRead,
    DatabaseBackupRestoreCreate,
    DatabaseBackupRestoreRead,
    DatabaseBackupRunRead,
    DatabaseBackupSettings,
    DatabaseBackupStatusRead,
)
from app.services.database_backups import (
    BackupBusyError,
    BackupError,
    DatabaseBackupScheduler,
    list_backups,
    load_backup_settings,
    load_backup_status,
    prepare_restore,
    save_backup_settings,
)

router = APIRouter(prefix="/database-backups", tags=["数据库备份"])


def _scheduler(request: Request) -> DatabaseBackupScheduler:
    return request.app.state.database_backup_scheduler


@router.get("/settings", response_model=DatabaseBackupSettings)
def get_database_backup_settings(request: Request) -> DatabaseBackupSettings:
    return load_backup_settings(request.app.state.database, request.app.state.settings)


@router.put("/settings", response_model=DatabaseBackupSettings)
def update_database_backup_settings(
    payload: DatabaseBackupSettings,
    request: Request,
) -> DatabaseBackupSettings:
    try:
        saved = save_backup_settings(request.app.state.database, request.app.state.settings, payload)
    except BackupError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    _scheduler(request).refresh_schedule()
    return saved


@router.get("/status", response_model=DatabaseBackupStatusRead)
def get_database_backup_status(request: Request) -> dict:
    scheduler = _scheduler(request)
    return {
        **load_backup_status(request.app.state.database),
        "running": scheduler.running,
        "next_run_at": scheduler.next_run_at,
    }


@router.get("", response_model=list[DatabaseBackupItemRead])
def get_database_backups(
    request: Request,
    limit: int = Query(default=210, ge=1, le=1000),
) -> list[dict]:
    config = load_backup_settings(request.app.state.database, request.app.state.settings)
    return list_backups(config, limit=limit)


@router.post("/run", response_model=DatabaseBackupRunRead)
async def run_database_backup(request: Request) -> dict:
    try:
        return await _scheduler(request).run_backup("manual")
    except BackupBusyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except BackupError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error


@router.post("/restore", response_model=DatabaseBackupRestoreRead)
async def restore_database_backup(
    payload: DatabaseBackupRestoreCreate,
    request: Request,
) -> dict:
    source = Path(payload.path).expanduser()
    if not source.is_absolute():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="恢复文件必须使用绝对路径",
        )
    scheduler = _scheduler(request)
    try:
        safety_backup = await scheduler.run_backup("pre-restore")
        await asyncio.to_thread(prepare_restore, request.app.state.settings, source)
    except BackupBusyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except BackupError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    return {
        "restart_required": True,
        "safety_backup_path": safety_backup["path"],
        "source_backup_path": str(source.resolve()),
    }
