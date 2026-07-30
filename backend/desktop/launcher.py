from __future__ import annotations

import ctypes
import multiprocessing
import os
import socket
import threading
import time
from pathlib import Path

import uvicorn
import webview

from app.config import Settings

APP_NAME = "GeneLabLedger"
WINDOW_TITLE = "基因检测台账"
MUTEX_NAME = r"Local\GeneLabLedger.Desktop.SingleInstance"
ERROR_ALREADY_EXISTS = 183


def acquire_single_instance_mutex() -> int:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        raise RuntimeError("无法创建软件单实例锁")
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        raise RuntimeError("基因检测台账已经在运行")
    return int(handle)


def release_mutex(handle: int) -> None:
    if handle:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def application_data_directory() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        local_app_data = str(Path.home() / "AppData" / "Local")
    return Path(local_app_data) / APP_NAME


def available_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server_socket:
        server_socket.bind(("127.0.0.1", 0))
        return int(server_socket.getsockname()[1])


def wait_until_listening(port: int, timeout_seconds: float = 15) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("本机后端启动超时")


def main() -> None:
    multiprocessing.freeze_support()
    os.environ["GENE_LEDGER_DESKTOP_MODE"] = "1"
    from app.main import create_app

    mutex_handle = acquire_single_instance_mutex()
    port = available_loopback_port()
    data_directory = application_data_directory()
    settings = Settings(
        host="127.0.0.1",
        port=port,
        data_dir=data_directory,
        database_url=None,
        auto_create_schema=True,
    )
    application = create_app(settings=settings)
    server = uvicorn.Server(
        uvicorn.Config(
            application,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            access_log=False,
        )
    )
    server_thread = threading.Thread(
        target=server.run,
        name="gene-ledger-backend",
        daemon=True,
    )
    try:
        server_thread.start()
        wait_until_listening(port)
        webview.create_window(
            WINDOW_TITLE,
            f"http://127.0.0.1:{port}/",
            width=1440,
            height=900,
            min_size=(1100, 700),
            confirm_close=False,
        )
        webview.start(debug=False)
    finally:
        server.should_exit = True
        server_thread.join(timeout=10)
        if server_thread.is_alive():
            server.force_exit = True
            server_thread.join(timeout=5)
        release_mutex(mutex_handle)


if __name__ == "__main__":
    main()
