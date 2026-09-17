from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_session
from app.models import Project, ProjectRecord
from app.schemas import (
    DashboardMonthlyPoint,
    DashboardProjectPoint,
    DashboardStatusPoint,
    DashboardSummaryRead,
)
from app.timezones import ASIA_SHANGHAI

router = APIRouter(prefix="/dashboard", tags=["统计面板"])


def _shift_month(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 + months
    return date(month_index // 12, month_index % 12 + 1, 1)


@router.get("/summary", response_model=DashboardSummaryRead)
def dashboard_summary(
    project_id: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> DashboardSummaryRead:
    projects = list(session.scalars(select(Project).order_by(Project.sort_order, Project.name)))
    if project_id is not None and all(project.id != project_id for project in projects):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="检测项目不存在",
        )

    statement = select(
        ProjectRecord.project_id,
        ProjectRecord.status,
        ProjectRecord.experiment_date,
        ProjectRecord.report_generated,
    )
    if project_id is not None:
        statement = statement.where(ProjectRecord.project_id == project_id)
    rows = session.execute(statement).all()

    today = datetime.now(ASIA_SHANGHAI).date()
    current_month_start = today.replace(day=1)
    next_month_start = _shift_month(current_month_start, 1)
    previous_month_start = _shift_month(current_month_start, -1)
    recent_start = today - timedelta(days=29)
    monthly_starts = [_shift_month(current_month_start, offset) for offset in range(-11, 1)]
    monthly_counts = {month.strftime("%Y-%m"): 0 for month in monthly_starts}
    status_counts: Counter[str] = Counter()
    project_totals: Counter[str] = Counter()
    project_current: Counter[str] = Counter()
    project_previous: Counter[str] = Counter()
    project_monthly: dict[str, Counter[str]] = defaultdict(Counter)
    recent_30_days = 0
    current_month = 0
    previous_month = 0
    report_generated = 0

    for row_project_id, record_status, experiment_date, has_report in rows:
        status_counts[record_status] += 1
        project_totals[row_project_id] += 1
        if has_report:
            report_generated += 1
        if experiment_date is None:
            continue
        if recent_start <= experiment_date <= today:
            recent_30_days += 1
        if current_month_start <= experiment_date < next_month_start:
            current_month += 1
            project_current[row_project_id] += 1
        elif previous_month_start <= experiment_date < current_month_start:
            previous_month += 1
            project_previous[row_project_id] += 1
        month_key = experiment_date.strftime("%Y-%m")
        if month_key in monthly_counts:
            monthly_counts[month_key] += 1
            project_monthly[row_project_id][month_key] += 1

    visible_projects = [project for project in projects if project_id in (None, project.id)]
    project_points = [
        DashboardProjectPoint(
            id=project.id,
            name=project.name,
            total=project_totals[project.id],
            current_month=project_current[project.id],
            previous_month=project_previous[project.id],
            monthly=[
                DashboardMonthlyPoint(month=month, total=project_monthly[project.id][month])
                for month in monthly_counts
            ],
        )
        for project in visible_projects
    ]
    project_points.sort(key=lambda item: (-item.total, item.name))
    total_records = len(rows)
    ordered_statuses = ["待实验", "已完成"]
    ordered_statuses.extend(sorted(set(status_counts) - set(ordered_statuses)))

    return DashboardSummaryRead(
        project_id=project_id,
        as_of=today,
        total_records=total_records,
        recent_30_days=recent_30_days,
        current_month=current_month,
        previous_month=previous_month,
        report_generated=report_generated,
        report_generated_rate=round(report_generated / total_records * 100, 1) if total_records else 0,
        monthly=[
            DashboardMonthlyPoint(month=month, total=monthly_counts[month])
            for month in monthly_counts
        ],
        statuses=[
            DashboardStatusPoint(status=record_status, total=status_counts[record_status])
            for record_status in ordered_statuses
        ],
        projects=project_points,
    )
