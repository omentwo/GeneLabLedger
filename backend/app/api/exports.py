from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter, Response

from app.schemas import WorkbookExportCreate
from app.services.workbooks import build_xlsx

router = APIRouter(prefix="/exports", tags=["Excel 导出"])


def safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" ._")
    return (cleaned[:120] or "台账导出") + ".xlsx"


@router.post("/workbook")
def export_workbook(payload: WorkbookExportCreate) -> Response:
    content = build_xlsx(
        [
            (
                sheet.name,
                sheet.headers,
                [list(row) for row in sheet.rows],
                sheet.hidden_columns,
            )
            for sheet in payload.sheets
        ]
    )
    filename = safe_filename(payload.filename)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "no-store",
        },
    )
