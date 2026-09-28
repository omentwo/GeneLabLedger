from __future__ import annotations

import ctypes
import gc
import multiprocessing
import os
import shutil
import threading
import time
import winreg
from ctypes import wintypes
from dataclasses import dataclass, field
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Literal
from uuid import uuid4

PreviewEngine = Literal["auto", "wps", "word"]
NativePreviewAction = Literal["preview", "open"]
NativePreviewStatus = Literal["starting", "open", "completed", "failed"]

_PROGID_CANDIDATES: dict[str, tuple[str, ...]] = {
    "word": ("Excel.Application",),
    "wps": ("ket.Application", "KET.Application"),
}
_DOC_PROGID_CANDIDATES: dict[str, tuple[str, ...]] = {
    "word": ("Word.Application",),
    "wps": ("kwps.application", "wps.Application"),
}


class OfficePreviewError(RuntimeError):
    pass


class PreviewEngineUnavailable(OfficePreviewError):
    pass


@dataclass
class NativePreviewJob:
    job_id: str
    action: NativePreviewAction
    engine: str
    document_type: str
    input_path: Path
    work_root: Path
    process: multiprocessing.Process
    connection: Connection
    status: NativePreviewStatus = "starting"
    error: str | None = None
    office_process_id: int | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    started_event: threading.Event = field(default_factory=threading.Event, repr=False)


def _registered(progid: str) -> bool:
    if os.name != "nt":
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, rf"{progid}\CLSID"):
            return True
    except OSError:
        return False


def _resolve_progid(engine: str, document_type: str = "xlsx") -> str | None:
    candidates = _DOC_PROGID_CANDIDATES if document_type == "docx" else _PROGID_CANDIDATES
    for candidate in candidates.get(engine, ()):
        if _registered(candidate):
            return candidate
    return None


def _application_process_id(application: object) -> int | None:
    try:
        hwnd = int(getattr(application, "Hwnd", 0) or 0)
    except (TypeError, ValueError):
        return None
    if not hwnd or os.name != "nt":
        return None
    process_id = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    return process_id.value or None


def _native_preview_worker(
    engine: str,
    input_path: str,
    document_type: str,
    action: NativePreviewAction,
    connection: Connection,
) -> None:
    """Keep a visible Office/WPS COM instance alive for a native user action."""

    pythoncom = None
    application = None
    document = None
    workbook = None
    try:
        import pythoncom as pythoncom_module
        import win32com.client

        progid = _resolve_progid(engine, document_type)
        if not progid:
            raise PreviewEngineUnavailable(f"No {engine} {document_type} engine is registered.")
        pythoncom = pythoncom_module
        pythoncom.CoInitialize()
        application = win32com.client.DispatchEx(progid)
        application.Visible = True
        try:
            application.DisplayAlerts = action == "open"
        except Exception:
            pass

        if document_type == "docx":
            document = application.Documents.Open(
                input_path,
                False,
                action == "preview",
                False,
            )
        else:
            workbook = application.Workbooks.Open(
                input_path,
                False,
                action == "preview",
            )
        connection.send(("started", _application_process_id(application)))

        if action == "preview":
            if document_type == "docx":
                _show_document_preview(application, document)
            else:
                _show_workbook_preview(application, workbook)
        else:
            _wait_for_native_document_close(application, document_type)
        connection.send(("completed", None))
    except Exception as error:
        try:
            connection.send(("error", f"{type(error).__name__}: {error}"))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        if action == "preview":
            if document is not None:
                try:
                    document.Close(False)
                except Exception:
                    pass
            if workbook is not None:
                try:
                    workbook.Close(False)
                except Exception:
                    pass
            if application is not None:
                try:
                    application.Quit()
                except Exception:
                    pass
        gc.collect()
        if pythoncom is not None:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass
        connection.close()


def _show_document_preview(application: object, document: object) -> None:
    try:
        document.PrintPreview()
        _wait_for_preview_view_exit(application)
        return
    except Exception:
        # WPS exposes PrintPreview on Application as a property as well.
        application.PrintPreview = True
        _wait_for_preview_view_exit(application)


def _show_workbook_preview(application: object, workbook: object) -> None:
    try:
        sheet = workbook.Worksheets(1)
        try:
            sheet.PrintPreview(False)
        except TypeError:
            sheet.PrintPreview()
        _wait_for_preview_view_exit(application)
        return
    except Exception:
        try:
            try:
                workbook.PrintPreview(False)
            except TypeError:
                workbook.PrintPreview()
            _wait_for_preview_view_exit(application)
        except Exception:
            application.PrintPreview = True
            _wait_for_preview_view_exit(application)


def _wait_for_preview_view_exit(application: object) -> None:
    while True:
        try:
            if not bool(application.PrintPreview):
                return
            _ = application.Hwnd
        except Exception:
            return
        time.sleep(0.5)


def _wait_for_native_document_close(application: object, document_type: str) -> None:
    collection_name = "Documents" if document_type == "docx" else "Workbooks"
    while True:
        try:
            collection = getattr(application, collection_name)
            if int(collection.Count or 0) <= 0:
                return
            _ = application.Hwnd
        except Exception:
            return
        time.sleep(0.5)


def _terminate_process(process_id: int | None) -> None:
    if os.name != "nt" or not process_id:
        return
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(0x0001, False, process_id)
    if not handle:
        return
    try:
        kernel32.TerminateProcess(handle, 1)
    finally:
        kernel32.CloseHandle(handle)


class OfficePreviewService:
    def __init__(self) -> None:
        self._native_lock = threading.RLock()
        self._native_jobs: dict[str, NativePreviewJob] = {}
        self.native_start_timeout_seconds = 15

    def capabilities(self) -> dict[str, object]:
        microsoft_writer = _resolve_progid("word", "docx") is not None
        microsoft_spreadsheet = _resolve_progid("word", "xlsx") is not None
        wps_writer = _resolve_progid("wps", "docx") is not None
        wps_spreadsheet = _resolve_progid("wps", "xlsx") is not None
        microsoft = microsoft_writer or microsoft_spreadsheet
        wps = wps_writer or wps_spreadsheet
        return {
            "microsoft_office": microsoft,
            "microsoft_writer": microsoft_writer,
            "microsoft_spreadsheet": microsoft_spreadsheet,
            "wps_writer": wps_writer,
            "wps_spreadsheet": wps_spreadsheet,
            "native_preview": os.name == "nt" and (microsoft or wps),
            "preferred_engine": "microsoft" if microsoft else "wps" if wps else None,
        }

    def resolve_engine(self, requested: PreviewEngine, document_type: str = "xlsx") -> str:
        if requested == "auto":
            if _resolve_progid("word", document_type):
                return "word"
            if _resolve_progid("wps", document_type):
                return "wps"
            raise PreviewEngineUnavailable("Microsoft Office or WPS was not detected.")
        if requested not in {"word", "wps"}:
            raise PreviewEngineUnavailable("Unsupported preview engine.")
        if not _resolve_progid(requested, document_type):
            label = "Microsoft Office" if requested == "word" else "WPS"
            raise PreviewEngineUnavailable(f"{label} {document_type} application was not detected.")
        return requested

    def start_native_preview(
        self,
        input_path: Path,
        work_root: Path,
        document_type: str,
        action: NativePreviewAction,
        engine: PreviewEngine = "auto",
    ) -> dict[str, object]:
        if os.name != "nt":
            raise OfficePreviewError("Microsoft Office/WPS native windows are supported on Windows only.")
        if not input_path.is_file():
            raise OfficePreviewError("The temporary native preview document does not exist.")
        if action not in {"preview", "open"}:
            raise OfficePreviewError("Unsupported native preview action.")
        resolved = self.resolve_engine(engine, document_type)
        self.cleanup_native_previews(work_root.parent)
        work_root.mkdir(parents=True, exist_ok=True)
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe(duplex=False)
        job_id = uuid4().hex
        process = context.Process(
            target=_native_preview_worker,
            args=(resolved, str(input_path.resolve()), document_type, action, child),
            name=f"ledger-native-{resolved}",
            daemon=True,
        )
        job = NativePreviewJob(
            job_id=job_id,
            action=action,
            engine=resolved,
            document_type=document_type,
            input_path=input_path,
            work_root=work_root,
            process=process,
            connection=parent,
        )
        with self._native_lock:
            self._native_jobs[job_id] = job
        try:
            process.start()
            child.close()
        except Exception:
            child.close()
            parent.close()
            with self._native_lock:
                self._native_jobs.pop(job_id, None)
            shutil.rmtree(work_root, ignore_errors=True)
            raise
        threading.Thread(
            target=self._monitor_native_job,
            args=(job,),
            name=f"ledger-native-monitor-{job_id[:8]}",
            daemon=True,
        ).start()
        job.started_event.wait(self.native_start_timeout_seconds)
        response = self.native_job(job_id)
        if response is None:
            raise OfficePreviewError("Native Office/WPS preview task disappeared.")
        if response["status"] == "failed":
            raise OfficePreviewError(str(response.get("error") or "Native Office/WPS preview failed."))
        return response

    def native_job(self, job_id: str) -> dict[str, object] | None:
        with self._native_lock:
            job = self._native_jobs.get(job_id)
            if job is None:
                return None
            if job.finished_at is not None and time.time() - job.finished_at > 3_600:
                self._native_jobs.pop(job_id, None)
                return None
            return {
                "job_id": job.job_id,
                "status": job.status,
                "action": job.action,
                "print_engine": job.engine,
                "document_type": job.document_type,
                "filename": job.input_path.name,
                "error": job.error,
            }

    def _monitor_native_job(self, job: NativePreviewJob) -> None:
        try:
            while True:
                if job.connection.poll(0.2):
                    message = job.connection.recv()
                    kind, payload = message[0], message[1]
                    with self._native_lock:
                        if kind == "started":
                            job.office_process_id = int(payload) if payload is not None else None
                            job.status = "open"
                            job.started_event.set()
                        elif kind == "completed":
                            job.status = "completed"
                            job.finished_at = time.time()
                            break
                        elif kind == "error":
                            job.status = "failed"
                            job.error = str(payload)
                            job.finished_at = time.time()
                            job.started_event.set()
                            break
                if not job.process.is_alive():
                    with self._native_lock:
                        if job.status not in {"completed", "failed"}:
                            job.status = "failed"
                            job.error = f"{job.engine} native preview exited unexpectedly."
                            job.finished_at = time.time()
                            job.started_event.set()
                    break
            job.process.join(timeout=5)
        except (BrokenPipeError, EOFError, OSError) as error:
            with self._native_lock:
                job.status = "failed"
                job.error = str(error)
                job.finished_at = time.time()
                job.started_event.set()
        finally:
            job.connection.close()
            if job.process.is_alive():
                job.process.terminate()
                job.process.join(timeout=2)
                _terminate_process(job.office_process_id)
            if job.action == "preview" or job.status == "failed":
                shutil.rmtree(job.work_root, ignore_errors=True)

    def cleanup_native_previews(self, preview_root: Path, max_age_seconds: int = 86_400) -> None:
        if not preview_root.exists():
            return
        active_roots = {job.work_root.resolve() for job in self._native_jobs.values()}
        cutoff = time.time() - max_age_seconds
        for candidate in preview_root.iterdir():
            try:
                if candidate.resolve() in active_roots:
                    continue
                if candidate.stat().st_mtime < cutoff:
                    if candidate.is_dir():
                        shutil.rmtree(candidate, ignore_errors=True)
                    else:
                        candidate.unlink(missing_ok=True)
            except OSError:
                continue

    def shutdown(self) -> None:
        with self._native_lock:
            jobs = list(self._native_jobs.values())
            self._native_jobs.clear()
        for job in jobs:
            if job.process.is_alive():
                job.process.terminate()
                job.process.join(timeout=2)
            _terminate_process(job.office_process_id)
            try:
                job.connection.close()
            except OSError:
                pass
            shutil.rmtree(job.work_root, ignore_errors=True)
