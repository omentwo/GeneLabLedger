"""生成带一年数据的虚拟数据库，用于本地预览统计面板动效。

用法（在 backend 目录执行）:
    GENE_LEDGER_DATABASE_URL=sqlite:///virtual-year.db uv run python seed_virtual_year.py

之后以同样的 GENE_LEDGER_DATABASE_URL 启动后端即可。数据为两个项目、近 12 个月、
每月几十条带 experiment_date 的记录，每月总量呈爬坡趋势。
"""

from __future__ import annotations

import os
from datetime import date

from app.database import Database
from app.models import FieldDefinition, Project, ProjectRecord

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///virtual-year.db")

# 从当前月往前 12 个月，每月的记录总量（爬坡趋势，最高 72）
MONTHLY_TOTALS = [18, 26, 22, 34, 30, 41, 38, 52, 46, 61, 55, 72]
PROJECT_NAMES = ("TB", "BRAFV600E")
PROJECT_SPLIT = (0.55, 0.45)  # 两个项目的当月占比
PROJECT_LEAD_ALTERNATION = True  # 两个项目轮流占当月大头，堆叠色块更分明

CORE_FIELDS = (
    ("date", "日期", "date", "experiment_date", 0, 150),
    ("caseId", "病理号", "text", "pathology_number", 1, 120),
    ("blockNo", "蜡块号", "text", "block_number", 2, 110),
    ("experimentNo", "实验编号", "text", "experiment_number", 3, 145),
)


def shift_month(month: date, offset: int) -> date:
    total = month.year * 12 + month.month - 1 + offset
    return date(total // 12, total % 12 + 1, 1)


def main() -> None:
    database = Database(DATABASE_URL)
    database.create_all()
    with database.session_factory() as session:
        exists = session.query(Project).filter(Project.name.in_(PROJECT_NAMES)).count()
        if exists:
            print("virtual data already present, skip seeding")
            return

        projects: list[Project] = []
        for index, name in enumerate(PROJECT_NAMES):
            project = Project(name=name, sort_order=index)
            session.add(project)
            projects.append(project)
        session.flush()

        for project in projects:
            for key, label, data_type, system_key, sort_order, width in CORE_FIELDS:
                session.add(
                    FieldDefinition(
                        project_id=project.id,
                        key=key,
                        label=label,
                        data_type=data_type,
                        system_key=system_key,
                        is_core=system_key is not None,
                        sort_order=sort_order,
                        width=width,
                    )
                )
        session.flush()

        current_month = date.today().replace(day=1)
        position = 0
        serial = 0
        total_records = 0
        for span, total in enumerate(MONTHLY_TOTALS):
            month = shift_month(current_month, span - (len(MONTHLY_TOTALS) - 1))
            lead = 0 if span % 2 == 0 or not PROJECT_LEAD_ALTERNATION else 1
            counts = [
                round(total * PROJECT_SPLIT[0]) if index == lead
                else total - round(total * PROJECT_SPLIT[0])
                for index in range(len(projects))
            ]
            for project, count in zip(projects, counts, strict=True):
                for index in range(count):
                    serial += 1
                    day = 1 + (index * 3) % 27
                    session.add(
                        ProjectRecord(
                            project_id=project.id,
                            position=position,
                            status="待实验",
                            experiment_date=date(month.year, month.month, day),
                            pathology_number=f"V{month.year % 100:02d}{month.month:02d}{serial:04d}",
                        )
                    )
                    position += 1
                    total_records += 1

        session.commit()
        print(f"seeded {total_records} records across {len(MONTHLY_TOTALS)} months into {DATABASE_URL}")


if __name__ == "__main__":
    main()
