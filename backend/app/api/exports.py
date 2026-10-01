from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Response

from app.schemas import WorkbookExportCreate
from app.services.filenames import safe_filename
from app.services.workbooks import build_xlsx

router = APIRouter(prefix="/exports", tags=["Excel 导出"])


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
    filename = safe_filename(payload.filename, fallback="台账导出") + ".xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "no-store",
        },
    )
