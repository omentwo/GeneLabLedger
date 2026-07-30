from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.audit import audit
from app.database import get_session
from app.models import ExperimentBatch, ExperimentRun, ProjectRecord
from app.schemas import (
    ExperimentBatchRead,
    ExperimentCommitRead,
    ExperimentRunAdd,
    ExperimentRunRead,
    ExperimentRunReorder,
)
from app.services.records import (
    create_experiment_run,
    renumber_batch,
    require_record,
)
from app.services.serializers import (
    experiment_batch_dict,
    experiment_run_dict,
)

router = APIRouter(prefix="/experiments", tags=["实验编排"])


def load_batch(session: Session, experiment_date: date) -> ExperimentBatch | None:
    return session.scalar(
        select(ExperimentBatch)
        .where(ExperimentBatch.experiment_date == experiment_date)
        .options(
            selectinload(ExperimentBatch.runs)
            .selectinload(ExperimentRun.record)
            .selectinload(ProjectRecord.case),
            selectinload(ExperimentBatch.runs)
            .selectinload(ExperimentRun.record)
            .selectinload(ProjectRecord.project),
        )
    )


def load_run(session: Session, run_id: str) -> ExperimentRun:
    run = session.scalar(
        select(ExperimentRun)
        .where(ExperimentRun.id == run_id)
        .options(
            selectinload(ExperimentRun.record).selectinload(ProjectRecord.case),
            selectinload(ExperimentRun.record).selectinload(ProjectRecord.project),
            selectinload(ExperimentRun.batch),
        )
    )
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="实验执行记录不存在")
    return run


@router.get("/batches/{experiment_date}", response_model=ExperimentBatchRead)
def get_batch(experiment_date: date, session: Session = Depends(get_session)) -> dict:
    return experiment_batch_dict(load_batch(session, experiment_date), experiment_date)


@router.post(
    "/batches/{experiment_date}/runs",
    response_model=ExperimentRunRead,
    status_code=status.HTTP_201_CREATED,
)
def add_run(
    experiment_date: date,
    payload: ExperimentRunAdd,
    session: Session = Depends(get_session),
) -> dict:
    record = require_record(session, payload.record_id)
    if record.status != "待实验" and not payload.allow_repeat:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="只有待实验记录可直接加入编排；已完成记录请使用重复实验操作",
        )
    run = create_experiment_run(
        session,
        record,
        experiment_date,
        allow_repeat=payload.allow_repeat,
    )
    if payload.allow_repeat:
        record.status = "待实验"
    audit(
        session,
        "experiment.run.add",
        "experiment_run",
        run.id,
        {
            "record_id": record.id,
            "experiment_date": experiment_date.isoformat(),
            "is_repeat": run.is_repeat,
        },
    )
    session.commit()
    return experiment_run_dict(load_run(session, run.id))


@router.put("/batches/{experiment_date}/order", response_model=ExperimentBatchRead)
def reorder_runs(
    experiment_date: date,
    payload: ExperimentRunReorder,
    session: Session = Depends(get_session),
) -> dict:
    batch = load_batch(session, experiment_date)
    if not batch:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="当天没有实验编排")
    current_ids = [run.id for run in batch.runs]
    if set(current_ids) != set(payload.run_ids) or len(current_ids) != len(payload.run_ids):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="排序必须包含当天全部实验条目，且不能重复",
        )
    by_id = {run.id: run for run in batch.runs}
    for index, run_id in enumerate(payload.run_ids, start=1):
        by_id[run_id].position = 100000 + index
        by_id[run_id].experiment_number = f"tmp-{run_id}"
    session.flush()
    for index, run_id in enumerate(payload.run_ids, start=1):
        run = by_id[run_id]
        run.position = index
        run.experiment_number = f"{experiment_date:%Y%m%d}-{index:02d}"
    audit(
        session,
        "experiment.batch.reorder",
        "experiment_batch",
        batch.id,
        {"run_ids": payload.run_ids},
    )
    session.commit()
    return experiment_batch_dict(load_batch(session, experiment_date), experiment_date)


@router.post(
    "/batches/{experiment_date}/commit",
    response_model=ExperimentCommitRead,
)
def commit_batch_to_ledger(
    experiment_date: date,
    session: Session = Depends(get_session),
) -> dict:
    batch = load_batch(session, experiment_date)
    if not batch or not batch.runs:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="当天没有可回写的实验编排")
    updated_record_ids: set[str] = set()
    for run in batch.runs:
        run.record.experiment_number = run.experiment_number
        updated_record_ids.add(run.record_id)
    audit(
        session,
        "experiment.batch.commit",
        "experiment_batch",
        batch.id,
        {
            "experiment_date": experiment_date.isoformat(),
            "updated_record_ids": sorted(updated_record_ids),
        },
    )
    session.commit()
    return {
        "experiment_date": experiment_date,
        "updated_records": len(updated_record_ids),
    }


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(run_id: str, session: Session = Depends(get_session)) -> Response:
    run = load_run(session, run_id)
    batch = run.batch
    record = run.record
    removed_experiment_number = run.experiment_number
    audit(
        session,
        "experiment.run.delete",
        "experiment_run",
        run.id,
        {
            "record_id": record.id,
            "experiment_date": batch.experiment_date.isoformat(),
            "experiment_number": run.experiment_number,
        },
    )
    session.delete(run)
    session.flush()
    renumber_batch(session, batch)
    latest_remaining = session.scalar(
        select(ExperimentRun)
        .where(ExperimentRun.record_id == record.id)
        .options(selectinload(ExperimentRun.batch))
        .order_by(ExperimentRun.created_at.desc(), ExperimentRun.id.desc())
        .limit(1)
    )
    record.current_experiment_date = latest_remaining.batch.experiment_date if latest_remaining else None
    if record.experiment_number == removed_experiment_number:
        record.experiment_number = None
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
