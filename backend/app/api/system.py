from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.audit import audit
from app.database import get_session
from app.models import AppSetting, AuditLog
from app.schemas import AppSettingRead, AppSettingUpdate, AuditLogRead, HealthRead
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
    "record.delete": "删除台账记录",
    "record.lock": "锁定台账记录",
    "record.unlock": "解锁台账记录",
    "record.assign_project": "分配到其他项目",
    "experiment.repeat": "创建重复实验",
    "experiment.run.add": "加入实验编排",
    "experiment.run.delete": "移出实验编排",
    "experiment.batch.reorder": "调整实验顺序",
    "experiment.batch.commit": "确认编排并回写台账",
    "record.report_generated": "标记已生成报告",
    "record.report_reset": "恢复为未生成报告",
    "report_template.create": "添加报告模板",
    "report_template.version.create": "添加模板版本",
    "report_template.mappings.replace": "保存模板映射",
    "report_template.delete": "删除报告模板",
    "report.documents.generate": "生成 Word 报告",
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
    "experiment_run": "实验条目",
    "experiment_batch": "实验批次",
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


@router.get("/audit-logs", response_model=list[AuditLogRead])
def list_audit_logs(
    search: str | None = Query(default=None, max_length=240),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
) -> list[AuditLog]:
    statement = select(AuditLog).order_by(AuditLog.created_at.desc())
    if not search or not search.strip():
        return list(session.scalars(statement.offset(offset).limit(limit)))

    term = search.strip().casefold()
    matched = []
    for log in session.scalars(statement):
        searchable = " ".join(
            [
                log.actor,
                log.action,
                AUDIT_ACTION_SEARCH_LABELS.get(log.action, ""),
                log.entity_type,
                AUDIT_ENTITY_SEARCH_LABELS.get(log.entity_type, ""),
                log.entity_id or "",
                json.dumps(log.details, ensure_ascii=False, sort_keys=True),
            ]
        ).casefold()
        if term in searchable:
            matched.append(log)
    return matched[offset : offset + limit]


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
