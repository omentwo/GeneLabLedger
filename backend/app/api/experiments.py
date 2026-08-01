from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import ExperimentPlan, ExperimentPlanItem, ProjectRecord
from app.schemas import (
    ExperimentApplyRead,
    ExperimentPlanCreate,
    ExperimentPlanItemAdd,
    ExperimentPlanItemRead,
    ExperimentPlanRead,
    ExperimentPlanReorder,
    ExperimentPlanUpdate,
)
from app.services.records import require_record
from app.services.serializers import experiment_plan_dict, experiment_plan_item_dict

router = APIRouter(prefix="/experiments", tags=["实验编排"])


def plan_load_options() -> tuple:
    return (
        selectinload(ExperimentPlan.items)
        .selectinload(ExperimentPlanItem.record)
        .selectinload(ProjectRecord.project),
    )


def require_plan(session: Session, plan_id: str) -> ExperimentPlan:
    plan = session.scalar(
        select(ExperimentPlan)
        .where(ExperimentPlan.id == plan_id)
        .options(*plan_load_options())
        .execution_options(populate_existing=True)
    )
    if not plan:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="实验编排单不存在")
    return plan


def require_item(session: Session, plan_id: str, item_id: str) -> ExperimentPlanItem:
    item = session.scalar(
        select(ExperimentPlanItem).where(
            ExperimentPlanItem.id == item_id,
            ExperimentPlanItem.plan_id == plan_id,
        )
    )
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="实验编排条目不存在")
    return item


def rewrite_positions(session: Session, items: list[ExperimentPlanItem]) -> None:
    for index, item in enumerate(items, start=1):
        item.position = 100000 + index
    session.flush()
    for index, item in enumerate(items, start=1):
        item.position = index


@router.get("/plans", response_model=list[ExperimentPlanRead])
def list_plans(session: Session = Depends(get_session)) -> list[dict]:
    plans = list(
        session.scalars(
            select(ExperimentPlan)
            .options(*plan_load_options())
            .order_by(ExperimentPlan.updated_at.desc(), ExperimentPlan.created_at.desc())
        )
    )
    return [experiment_plan_dict(plan) for plan in plans]


@router.post("/plans", response_model=ExperimentPlanRead, status_code=status.HTTP_201_CREATED)
def create_plan(
    payload: ExperimentPlanCreate,
    session: Session = Depends(get_session),
) -> dict:
    plan = ExperimentPlan(prefix=payload.prefix)
    session.add(plan)
    session.flush()
    audit(session, "experiment.plan.create", "experiment_plan", plan.id, {"prefix": plan.prefix})
    session.commit()
    return experiment_plan_dict(require_plan(session, plan.id))


@router.get("/plans/{plan_id}", response_model=ExperimentPlanRead)
def get_plan(plan_id: str, session: Session = Depends(get_session)) -> dict:
    return experiment_plan_dict(require_plan(session, plan_id))


@router.patch("/plans/{plan_id}", response_model=ExperimentPlanRead)
def update_plan(
    plan_id: str,
    payload: ExperimentPlanUpdate,
    session: Session = Depends(get_session),
) -> dict:
    plan = require_plan(session, plan_id)
    before = plan.prefix
    plan.prefix = payload.prefix
    audit(
        session,
        "experiment.plan.update",
        "experiment_plan",
        plan.id,
        {"before_prefix": before, "after_prefix": plan.prefix},
    )
    session.commit()
    return experiment_plan_dict(require_plan(session, plan.id))


@router.delete("/plans/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_plan(plan_id: str, session: Session = Depends(get_session)) -> Response:
    plan = require_plan(session, plan_id)
    audit(
        session,
        "experiment.plan.delete",
        "experiment_plan",
        plan.id,
        {"prefix": plan.prefix, "item_count": len(plan.items)},
    )
    session.delete(plan)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/plans/{plan_id}/items",
    response_model=ExperimentPlanItemRead,
    status_code=status.HTTP_201_CREATED,
)
def add_plan_item(
    plan_id: str,
    payload: ExperimentPlanItemAdd,
    session: Session = Depends(get_session),
) -> dict:
    plan = require_plan(session, plan_id)
    record = require_record(session, payload.record_id)
    if record.status != "待实验":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="只有待实验记录可以加入实验编排",
        )
    existing = session.scalar(
        select(ExperimentPlanItem).where(
            ExperimentPlanItem.plan_id == plan.id,
            ExperimentPlanItem.record_id == record.id,
        )
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该记录已在当前编排单中")
    position = (
        session.scalar(
            select(func.max(ExperimentPlanItem.position)).where(
                ExperimentPlanItem.plan_id == plan.id
            )
        )
        or 0
    ) + 1
    item = ExperimentPlanItem(plan_id=plan.id, record_id=record.id, position=position)
    session.add(item)
    session.flush()
    audit(
        session,
        "experiment.plan.item.add",
        "experiment_plan_item",
        item.id,
        {"plan_id": plan.id, "record_id": record.id},
    )
    session.commit()
    return experiment_plan_item_dict(require_plan(session, plan.id).items[-1])


@router.put("/plans/{plan_id}/order", response_model=ExperimentPlanRead)
def reorder_plan(
    plan_id: str,
    payload: ExperimentPlanReorder,
    session: Session = Depends(get_session),
) -> dict:
    plan = require_plan(session, plan_id)
    current_ids = [item.id for item in plan.items]
    if len(payload.item_ids) != len(current_ids) or set(payload.item_ids) != set(current_ids):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="排序必须包含当前编排单的全部条目，且不能重复",
        )
    by_id = {item.id: item for item in plan.items}
    rewrite_positions(session, [by_id[item_id] for item_id in payload.item_ids])
    audit(
        session,
        "experiment.plan.reorder",
        "experiment_plan",
        plan.id,
        {"item_ids": payload.item_ids},
    )
    session.commit()
    return experiment_plan_dict(require_plan(session, plan.id))


@router.delete("/plans/{plan_id}/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_plan_item(
    plan_id: str,
    item_id: str,
    session: Session = Depends(get_session),
) -> Response:
    plan = require_plan(session, plan_id)
    item = require_item(session, plan_id, item_id)
    audit(
        session,
        "experiment.plan.item.delete",
        "experiment_plan_item",
        item.id,
        {"plan_id": plan.id, "record_id": item.record_id},
    )
    session.delete(item)
    session.flush()
    remaining = list(
        session.scalars(
            select(ExperimentPlanItem)
            .where(ExperimentPlanItem.plan_id == plan.id)
            .order_by(ExperimentPlanItem.position, ExperimentPlanItem.created_at)
        )
    )
    rewrite_positions(session, remaining)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/plans/{plan_id}/apply", response_model=ExperimentApplyRead)
def apply_plan(
    plan_id: str,
    session: Session = Depends(get_session),
) -> dict:
    plan = require_plan(session, plan_id)
    if not plan.prefix:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请先填写实验编号前缀")
    if not plan.items:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="当前编排单没有可回写记录")

    invalid = [item.record.pathology_number for item in plan.items if item.record.status != "待实验"]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"以下记录已不是待实验状态：{', '.join(invalid)}",
        )
    locked = [item.record.pathology_number for item in plan.items if item.record.locked]
    if locked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"以下记录已锁定，不能回写实验编号：{', '.join(locked)}",
        )

    numbers = [f"{plan.prefix}-{item.position}" for item in plan.items]
    if any(len(number) > 80 for number in numbers):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="实验编号过长，请缩短编号前缀",
        )
    selected_ids = [item.record_id for item in plan.items]
    conflicts = list(
        session.scalars(
            select(ProjectRecord).where(
                ProjectRecord.experiment_number.in_(numbers),
                ProjectRecord.id.not_in(selected_ids),
            )
        )
    )
    if conflicts:
        details = ", ".join(
            f"{record.experiment_number}（{record.pathology_number}）" for record in conflicts
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"实验编号已被其他记录使用：{details}",
        )

    for item in plan.items:
        item.record.experiment_number = None
    session.flush()
    for item in plan.items:
        item.record.experiment_number = f"{plan.prefix}-{item.position}"

    applied_at = datetime.now(UTC)
    plan.last_applied_at = applied_at
    audit(
        session,
        "experiment.plan.apply",
        "experiment_plan",
        plan.id,
        {
            "prefix": plan.prefix,
            "updated_record_ids": selected_ids,
            "experiment_numbers": numbers,
        },
    )
    session.commit()
    return {
        "plan_id": plan.id,
        "updated_records": len(selected_ids),
        "applied_at": applied_at,
    }
