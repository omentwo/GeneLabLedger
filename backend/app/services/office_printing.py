from __future__ import annotations

import ctypes
import gc
import multiprocessing
import os
import threading
import time
import winreg
from ctypes import wintypes
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Literal

from app.services.printers import list_windows_printers

PrintEngine = Literal["auto", "wps", "word"]

ENGINE_PROGIDS: dict[str, str] = {
    "word": "Word.Application",
    "wps": "kwps.application",
}


class OfficePrintError(RuntimeError):
    pass


class OfficeEngineUnavailable(OfficePrintError):
    pass


def _engine_registered(engine: str) -> bool:
    if os.name != "nt":
        return False
    progid = ENGINE_PROGIDS.get(engine)
    if not progid:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, rf"{progid}\CLSID"):
            return True
    except OSError:
        return False


def _application_process_id(application: object) -> int | None:
    try:
        hwnd = int(getattr(application, "Hwnd", 0) or 0)
    except (TypeError, ValueError):
        return None
    if not hwnd:
        return None
    process_id = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    return process_id.value or None


def _office_print_worker(
    engine: str,
    input_documents: list[str],
    printer_name: str,
    connection: Connection,
) -> None:
    pythoncom = None
    application = None
    document = None
    try:
        import pythoncom as pythoncom_module
        import win32com.client

        pythoncom = pythoncom_module
        pythoncom.CoInitialize()
        application = win32com.client.DispatchEx(ENGINE_PROGIDS[engine])
        application.Visible = False
        try:
            application.DisplayAlerts = 0
        except Exception:
            pass
        connection.send(("started", _application_process_id(application)))
        application.ActivePrinter = printer_name
        for input_document in input_documents:
            document = application.Documents.Open(input_document, False, True, False)
            document.PrintOut(False)
            document.Close(False)
            document = None
        connection.send(("success", None))
    except Exception as error:
        try:
            connection.send(("error", f"{type(error).__name__}: {error}"))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        if document is not None:
            try:
                document.Close(False)
            except Exception:
                pass
        if application is not None:
            try:
                application.Quit(False)
            except Exception:
                pass
        document = None
        application = None
        gc.collect()
        if pythoncom is not None:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass
        connection.close()


def _terminate_process(process_id: int | None) -> None:
    if os.name != "nt" or not process_id:
        return
    process_terminate = 0x0001
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(process_terminate, False, process_id)
    if not handle:
        return
    try:
        kernel32.TerminateProcess(handle, 1)
    finally:
        kernel32.CloseHandle(handle)


@dataclass
class ActivePrintJob:
    process: multiprocessing.Process
    office_process_id: int | None = None


class OfficePrintService:
    def __init__(
        self,
        timeout_seconds: int = 90,
        per_document_timeout_seconds: int = 30,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.per_document_timeout_seconds = per_document_timeout_seconds
        self._state_lock = threading.Lock()
        self._print_lock = threading.Lock()
        self._jobs: dict[int, ActivePrintJob] = {}
        self._closing = False

    def list_printers(self) -> list[dict[str, object]]:
        return list_windows_printers()

    def engine_statuses(self) -> list[dict[str, object]]:
        word_available = _engine_registered("word")
        wps_available = _engine_registered("wps")
        return [
            {
                "key": "auto",
                "label": "自动",
                "available": word_available or wps_available,
                "resolved_engine": (
                    "word" if word_available else "wps" if wps_available else None
                ),
            },
            {
                "key": "wps",
                "label": "WPS",
                "available": wps_available,
                "resolved_engine": "wps" if wps_available else None,
            },
            {
                "key": "word",
                "label": "Microsoft Word",
                "available": word_available,
                "resolved_engine": "word" if word_available else None,
            },
        ]

    def resolve_engine(self, requested: PrintEngine) -> str:
        if requested not in {"auto", "wps", "word"}:
            raise OfficeEngineUnavailable("不支持的打印引擎")
        if requested == "auto":
            if _engine_registered("word"):
                return "word"
            if _engine_registered("wps"):
                return "wps"
            raise OfficeEngineUnavailable("未检测到 Microsoft Word 或 WPS")
        if not _engine_registered(requested):
            label = "Microsoft Word" if requested == "word" else "WPS"
            raise OfficeEngineUnavailable(f"未检测到可自动打印的 {label}")
        return requested

    def print_documents(
        self,
        input_documents: list[Path],
        printer_name: str,
        engine: PrintEngine = "auto",
    ) -> str:
        if os.name != "nt":
            raise OfficePrintError("直接打印仅支持 Windows")
        if not input_documents:
            raise OfficePrintError("没有可打印的报告")
        known_printers = {str(printer["name"]) for printer in self.list_printers()}
        if printer_name not in known_printers:
            raise OfficePrintError("选择的打印机不存在或当前不可用")
        missing = [path.name for path in input_documents if not path.is_file()]
        if missing:
            raise OfficePrintError(f"临时报告文件不存在：{', '.join(missing)}")

        with self._print_lock:
            with self._state_lock:
                if self._closing:
                    raise OfficePrintError("软件正在关闭，不能开始新的打印任务")
            resolved_engine = self.resolve_engine(engine)
            context = multiprocessing.get_context("spawn")
            parent_connection, child_connection = context.Pipe(duplex=False)
            process = context.Process(
                target=_office_print_worker,
                args=(
                    resolved_engine,
                    [str(path.resolve()) for path in input_documents],
                    printer_name,
                    child_connection,
                ),
                name=f"report-print-{resolved_engine}",
                daemon=True,
            )
            process.start()
            child_connection.close()
            job_key = id(process)
            job = ActivePrintJob(process=process)
            with self._state_lock:
                self._jobs[job_key] = job

            timeout = max(
                self.timeout_seconds,
                self.per_document_timeout_seconds * len(input_documents),
            )
            deadline = time.monotonic() + timeout
            final_message: tuple[str, object] | None = None
            try:
                while time.monotonic() < deadline:
                    if parent_connection.poll(0.2):
                        message = parent_connection.recv()
                        if message[0] == "started":
                            job.office_process_id = (
                                int(message[1]) if message[1] is not None else None
                            )
                            continue
                        final_message = message
                        break
                    if not process.is_alive():
                        break
                if final_message is None:
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=2)
                        _terminate_process(job.office_process_id)
                        raise OfficePrintError(f"{resolved_engine} 打印超时")
                    raise OfficePrintError(
                        f"{resolved_engine} 打印进程异常退出（代码 {process.exitcode}）"
                    )
                if final_message[0] == "error":
                    raise OfficePrintError(f"{resolved_engine} 打印失败：{final_message[1]}")
                process.join(timeout=5)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=2)
                    _terminate_process(job.office_process_id)
                return resolved_engine
            finally:
                parent_connection.close()
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=2)
                    _terminate_process(job.office_process_id)
                with self._state_lock:
                    self._jobs.pop(job_key, None)

    def shutdown(self) -> None:
        with self._state_lock:
            self._closing = True
            jobs = list(self._jobs.values())
        for job in jobs:
            if job.process.is_alive():
                job.process.terminate()
                job.process.join(timeout=2)
            _terminate_process(job.office_process_id)
