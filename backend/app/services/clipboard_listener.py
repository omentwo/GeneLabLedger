from __future__ import annotations

import ctypes
import io
import json
import os
import queue
import sys
import threading
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import TextIO

MAX_CLIPBOARD_CHARACTERS = 32_768
MAX_PROTOCOL_LINE = 262_144
INTERNAL_CLIPBOARD_FORMAT = "GeneLabLedger.InternalClipboard"


@dataclass(frozen=True)
class ClipboardSnapshot:
    sequence: int
    text: str | None = None
    internal: bool = False


class ClipboardProtocol:
    """A record-bound session; inactive sessions never read clipboard contents."""

    def __init__(
        self,
        sequence: Callable[[], int],
        read: Callable[[], ClipboardSnapshot],
        write: Callable[[str], None],
        emit: Callable[[dict], None],
    ) -> None:
        self.sequence = sequence
        self.read = read
        self.write = write
        self.emit = emit
        self.session: dict[str, str] | None = None
        self.last_sequence = 0
        self.event_id = 0

    def command(self, command: dict) -> dict:
        action = command.get("action")
        if action == "start":
            context = {key: command.get(key) for key in ("sessionId", "projectId", "recordId")}
            if any(not isinstance(value, str) or not value or len(value) > 160 for value in context.values()):
                raise ValueError("剪贴板接收会话无效")
            sequence = self.sequence()
            if not sequence:
                raise ValueError("当前 Windows 会话无法访问剪贴板")
            self.session = context
            self.last_sequence = sequence
            return {"sequence": sequence}
        if action == "stop":
            if self.session and command.get("sessionId") == self.session["sessionId"]:
                self.session = None
            return {}
        if action == "accept":
            if not self.session or command.get("sessionId") != self.session["sessionId"]:
                raise ValueError("剪贴板接收会话已结束")
            self.update(manual=True)
            return {}
        if action == "write-internal":
            text = command.get("text")
            if not isinstance(text, str) or len(text) > MAX_CLIPBOARD_CHARACTERS:
                raise ValueError("剪贴板写入内容无效")
            self.write(text)
            self.last_sequence = self.sequence()
            return {}
        raise ValueError("不支持的剪贴板命令")

    def update(self, *, manual: bool = False) -> None:
        context = self.session
        if not context or (not manual and self.sequence() == self.last_sequence):
            return
        snapshot = self.read()
        if self.session is not context:
            return
        if not manual and snapshot.sequence == self.last_sequence:
            return
        self.last_sequence = snapshot.sequence
        if snapshot.internal or not snapshot.text or not snapshot.text.strip():
            return
        if len(snapshot.text) > MAX_CLIPBOARD_CHARACTERS:
            self.fail("复制内容过长，请缩小复制范围后继续")
            return
        self.event_id += 1
        self.emit({
            "type": "clipboard",
            **context,
            "sequence": snapshot.sequence,
            "eventId": self.event_id,
            "text": snapshot.text,
            "manual": manual,
        })

    def fail(self, message: str) -> None:
        context, self.session = self.session, None
        if context:
            self.emit({"type": "error", **context, "message": message})


def pipe_stream(name: str) -> TextIO:
    """Recover inherited pipes when a windowed PyInstaller/pythonw sets stdio to None."""
    stream = getattr(sys, name)
    if stream is not None:
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8")
        return stream
    if os.name != "nt":
        raise RuntimeError("剪贴板通信管道不可用")
    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    handle = kernel.GetStdHandle(-10 if name == "stdin" else -11)
    if handle in (None, 0, ctypes.c_void_p(-1).value):
        raise RuntimeError("剪贴板通信管道不可用")
    reading = name == "stdin"
    descriptor = msvcrt.open_osfhandle(handle, (os.O_RDONLY if reading else os.O_WRONLY) | os.O_BINARY)
    return os.fdopen(descriptor, "r" if reading else "w", encoding="utf-8", buffering=1)


def run_clipboard_listener() -> None:
    """Listen on a message-only window. JSON pipes are private to the Electron parent."""
    incoming, outgoing = pipe_stream("stdin"), pipe_stream("stdout")

    def emit(payload: dict) -> None:
        # Clipboard text goes exclusively to the parent pipe, never to application logs.
        outgoing.write(json.dumps(payload, ensure_ascii=True) + "\n")
        outgoing.flush()

    if os.name != "nt":
        emit({"type": "fatal", "message": "剪贴板跟随仅支持 Windows 桌面版"})
        return
    try:
        _run_windows_listener(incoming, emit)
    except Exception:
        with suppress(Exception):
            emit({"type": "fatal", "message": "剪贴板监听已停止，请重新开启"})


def _run_windows_listener(incoming: TextIO, emit: Callable[[dict], None]) -> None:
    from ctypes import wintypes

    import win32api
    import win32clipboard
    import win32con
    import win32gui

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    for name in ("AddClipboardFormatListener", "RemoveClipboardFormatListener"):
        function = getattr(user32, name)
        function.argtypes = [wintypes.HWND]
        function.restype = wintypes.BOOL
    user32.GetClipboardSequenceNumber.restype = wintypes.DWORD
    user32.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, ctypes.c_void_p]
    user32.SetTimer.restype = ctypes.c_size_t
    user32.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]

    clipboard_message, command_message = 0x031D, win32con.WM_APP + 17
    commands: queue.Queue[dict] = queue.Queue()
    internal_format = win32clipboard.RegisterClipboardFormat(INTERNAL_CLIPBOARD_FORMAT)
    window = 0
    retry_count = 0
    sequence = user32.GetClipboardSequenceNumber

    def read() -> ClipboardSnapshot:
        win32clipboard.OpenClipboard(window)
        try:
            internal = bool(win32clipboard.IsClipboardFormatAvailable(internal_format))
            text = None
            if not internal and win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                text = win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
            return ClipboardSnapshot(sequence(), text, internal)
        finally:
            win32clipboard.CloseClipboard()

    def write(text: str) -> None:
        win32clipboard.OpenClipboard(window)
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, text)
            win32clipboard.SetClipboardData(internal_format, b"GeneLabLedger\0")
        finally:
            win32clipboard.CloseClipboard()

    protocol = ClipboardProtocol(sequence, read, write, emit)

    def update() -> None:
        nonlocal retry_count
        try:
            protocol.update()
            retry_count = 0
            user32.KillTimer(window, 1)
        except Exception:
            retry_count += 1
            if retry_count <= 8 and user32.SetTimer(window, 1, 40, None):
                return
            user32.KillTimer(window, 1)
            retry_count = 0
            protocol.fail("剪贴板暂时无法读取，已暂停；请继续后重新复制")

    def window_proc(hwnd: int, message: int, wparam: int, lparam: int) -> int:
        if message in (clipboard_message, win32con.WM_TIMER):
            update()
            return 0
        if message == command_message:
            while not commands.empty():
                command = commands.get_nowait()
                if command.get("action") == "shutdown":
                    win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
                    continue
                request_id = command.get("requestId")
                try:
                    result = protocol.command(command)
                    emit({"type": "reply", "requestId": request_id, "result": result})
                except Exception:
                    emit({"type": "reply", "requestId": request_id, "error": "剪贴板操作失败，请重试"})
            return 0
        if message == win32con.WM_CLOSE:
            win32gui.DestroyWindow(hwnd)
            return 0
        if message == win32con.WM_DESTROY:
            win32gui.PostQuitMessage(0)
            return 0
        return win32gui.DefWindowProc(hwnd, message, wparam, lparam)

    instance = win32api.GetModuleHandle(None)
    class_name = f"GeneLabLedgerClipboard_{os.getpid()}"
    window_class = win32gui.WNDCLASS()
    window_class.hInstance = instance
    window_class.lpszClassName = class_name
    window_class.lpfnWndProc = window_proc
    atom = win32gui.RegisterClass(window_class)
    try:
        window = win32gui.CreateWindowEx(0, atom, class_name, 0, 0, 0, 0, 0, -3, 0, instance, None)
        if not user32.AddClipboardFormatListener(window):
            raise ctypes.WinError(ctypes.get_last_error())

        def read_commands() -> None:
            try:
                while line := incoming.readline(MAX_PROTOCOL_LINE + 1):
                    if len(line) > MAX_PROTOCOL_LINE:
                        break
                    try:
                        command = json.loads(line)
                        if not isinstance(command, dict):
                            continue
                    except ValueError:
                        continue
                    commands.put(command)
                    win32gui.PostMessage(window, command_message, 0, 0)
            finally:
                with suppress(Exception):
                    win32gui.PostMessage(window, win32con.WM_CLOSE, 0, 0)

        threading.Thread(target=read_commands, daemon=True).start()
        emit({"type": "ready"})
        win32gui.PumpMessages()
    finally:
        if window:
            user32.RemoveClipboardFormatListener(window)
            user32.KillTimer(window, 1)
            with suppress(Exception):
                win32gui.DestroyWindow(window)
        win32gui.UnregisterClass(class_name, instance)
