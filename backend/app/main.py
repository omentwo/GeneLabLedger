from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api import (
    auto_exports,
    exports,
    imports,
    ledger_templates,
    preview,
    projects,
    records,
    reports,
    system,
)
from app.audit import prune_audit_logs
from app.config import Settings
from app.database import Database
from app.seed import seed_initial_data
from app.services.auto_exports import AutoExportScheduler
from app.services.office_preview import OfficePreviewService
from app.services.office_printing import OfficePrintService


def create_app(
    settings: Settings | None = None,
    printer_service: OfficePrintService | None = None,
    preview_service: OfficePreviewService | None = None,
) -> FastAPI:
    app_settings = settings or Settings()
    app_settings.ensure_directories()
    database = Database(app_settings.database_url or "")
    office_printer = printer_service or OfficePrintService()
    office_preview = preview_service or OfficePreviewService()
    auto_export_scheduler = AutoExportScheduler(database)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if app_settings.auto_create_schema:
            database.create_all()
        cleanup_native_previews = getattr(office_preview, "cleanup_native_previews", None)
        if cleanup_native_previews is not None:
            cleanup_native_previews(app_settings.report_work_dir / "native-previews")
        with database.session_factory() as session:
            seed_initial_data(session)
            prune_audit_logs(
                session,
                max_rows=app_settings.audit_log_max_rows,
                retention_days=app_settings.audit_log_retention_days,
            )
            session.commit()
        await auto_export_scheduler.start()
        try:
            yield
        finally:
            await auto_export_scheduler.stop()
            await asyncio.to_thread(office_printer.shutdown)
            preview_shutdown = getattr(office_preview, "shutdown", None)
            if preview_shutdown is not None:
                await asyncio.to_thread(preview_shutdown)
            await asyncio.to_thread(database.dispose)

    app = FastAPI(
        title=app_settings.app_name,
        version="0.10.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["null", "http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.settings = app_settings
    app.state.database = database
    app.state.printer_service = office_printer
    app.state.preview_service = office_preview
    app.state.auto_export_scheduler = auto_export_scheduler

    app.include_router(system.router, prefix="/api")
    app.include_router(projects.router, prefix="/api")
    app.include_router(ledger_templates.router, prefix="/api")
    app.include_router(preview.router, prefix="/api")
    app.include_router(records.router, prefix="/api")
    app.include_router(reports.router, prefix="/api")
    app.include_router(auto_exports.router, prefix="/api")
    app.include_router(imports.router, prefix="/api")
    app.include_router(exports.router, prefix="/api")

    project_dir = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    modern_frontend_dir = project_dir / "frontend" / "dist"
    modern_frontend_page = modern_frontend_dir / "index.html"

    if modern_frontend_page.is_file():
        app.mount(
            "/assets",
            StaticFiles(directory=modern_frontend_dir / "assets"),
            name="modern-frontend-assets",
        )

        @app.get("/app", include_in_schema=False)
        @app.get("/app/", include_in_schema=False)
        def retired_app_root() -> RedirectResponse:
            return RedirectResponse(url="/", status_code=308)

        @app.get("/app/{full_path:path}", include_in_schema=False)
        def retired_app_path(full_path: str) -> RedirectResponse:
            return RedirectResponse(url=f"/{full_path}", status_code=308)

        @app.get("/", include_in_schema=False)
        @app.get("/{full_path:path}", include_in_schema=False)
        def modern_frontend(full_path: str = "") -> FileResponse:
            return FileResponse(
                modern_frontend_page,
                media_type="text/html",
                headers={"Cache-Control": "no-store"},
            )

    return app


app = None if os.environ.get("GENE_LEDGER_DESKTOP_MODE") == "1" else create_app()
