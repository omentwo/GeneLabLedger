from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import String, cast, func, or_, select, text
from sqlalchemy.orm import Session

from app.audit import audit
from app.database import get_session
from app.models import AppSetting, AuditLog
from app.schemas import (
    AppSettingRead,
    AppSettingUpdate,
    AuditLogPageRead,
    HealthRead,
)
from app.services.office_printing import OfficePrintService

router = APIRouter(tags=["系统"])

AUDIT_ACTION_SEARCH_LABELS = {
    "project.create": "添加项目",
    "project.update": "修改项目",
    "project.delete": "删除项目",
    "field.create": "添加表头",
    "field.update": "修改表头",
    "field.delete": "删除表头",
    "field.reorder": "调整表头顺序",
    "field.options.replace": "修改备选项",
    "record.create": "新增台账记录",
    "record.update": "修改台账记录",
    "record.highlight.update": "标记台账底色",
    "record.cell_highlight.update": "标记单元格底色",
    "record.delete": "删除台账记录",
    "record.lock": "锁定台账记录",
    "record.unlock": "解锁台账记录",
    "record.assign_project": "分配到其他项目",
    "record.experiment_number.update": "回写实验编号",
    "record.bulk_delete": "按日期批量删除台账记录",
    "record.import.create": "导入新增台账记录",
    "record.import.update": "导入更新台账记录",
    "record.import.commit": "导入 Excel 台账",
    "record.report_generated": "标记已生成报告",
    "record.report_reset": "恢复为未生成报告",
    "report_template.create": "添加报告模板",
    "report_template.version.create": "添加模板版本",
    "report_template.mappings.replace": "保存模板映射",
    "report_template.delete": "删除报告模板",
    "report.print": "直接打印报告",
    "auto_export.task.create": "添加自动导出任务",
    "auto_export.task.update": "修改自动导出任务",
    "auto_export.task.delete": "删除自动导出任务",
    "auto_export.run.success": "自动导出成功",
    "auto_export.run.failed": "自动导出失败",
    "setting.update": "修改系统设置",
}

AUDIT_ENTITY_SEARCH_LABELS = {
    "project": "检测项目",
    "field": "台账表头",
    "project_record": "台账记录",
    "report_template": "报告模板",
    "report_template_version": "模板版本",
    "auto_export_task": "自动导出任务",
    "app_setting": "系统设置",
}


@router.get("/health", response_model=HealthRead)
def health(request: Request, session: Session = Depends(get_session)) -> dict:
    session.execute(text("SELECT 1"))
    printer_service: OfficePrintService = request.app.state.printer_service
    return {
        "status": "ok",
        "database": "ok",
        "print_engines": printer_service.engine_statuses(),
    }


@router.get("/audit-logs", response_model=AuditLogPageRead)
def list_audit_logs(
    search: str | None = Query(default=None, max_length=240),
    limit: int = Query(default=50, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
) -> dict:
    filters = []
    if search and search.strip():
        term = search.strip().casefold()
        pattern = f"%{term}%"
        filters.extend(
            [
                AuditLog.actor.ilike(pattern),
                AuditLog.action.ilike(pattern),
                AuditLog.entity_type.ilike(pattern),
                AuditLog.entity_id.ilike(pattern),
                cast(AuditLog.details, String).ilike(pattern),
            ]
        )
        matching_actions = [
            action
            for action, label in AUDIT_ACTION_SEARCH_LABELS.items()
            if term in label.casefold()
        ]
        matching_entities = [
            entity_type
            for entity_type, label in AUDIT_ENTITY_SEARCH_LABELS.items()
            if term in label.casefold()
        ]
        if matching_actions:
            filters.append(AuditLog.action.in_(matching_actions))
        if matching_entities:
            filters.append(AuditLog.entity_type.in_(matching_entities))

    where_clause = or_(*filters) if filters else None
    count_statement = select(func.count()).select_from(AuditLog)
    statement = select(AuditLog).order_by(
        AuditLog.created_at.desc(),
        AuditLog.id.desc(),
    )
    if where_clause is not None:
        count_statement = count_statement.where(where_clause)
        statement = statement.where(where_clause)

    total = session.scalar(count_statement) or 0
    items = list(session.scalars(statement.offset(offset).limit(limit)))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/settings/{key}", response_model=AppSettingRead)
def get_setting(key: str, session: Session = Depends(get_session)) -> dict:
    setting = session.get(AppSetting, key)
    if not setting:
        return {"key": key, "value": None}
    try:
        value = json.loads(setting.value)
    except json.JSONDecodeError:
        value = setting.value
    return {"key": key, "value": value}


@router.put("/settings/{key}", response_model=AppSettingRead)
def update_setting(
    key: str,
    payload: AppSettingUpdate,
    session: Session = Depends(get_session),
) -> dict:
    serialized = json.dumps(payload.value, ensure_ascii=False)
    setting = session.get(AppSetting, key)
    if setting:
        setting.value = serialized
    else:
        setting = AppSetting(key=key, value=serialized)
        session.add(setting)
    audit(session, "setting.update", "app_setting", key)
    session.commit()
    return {"key": key, "value": payload.value}
