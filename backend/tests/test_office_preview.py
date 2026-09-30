from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services import office_preview


@pytest.fixture
def window_system(monkeypatch):
    state = {"foreground": 99, "attempts": 0}

    def set_foreground(hwnd):
        state["attempts"] += 1
        if state["attempts"] == 1:
            raise OSError("foreground locked")
        state["foreground"] = hwnd

    gui = SimpleNamespace(
        GetAncestor=Mock(side_effect=lambda hwnd, _: hwnd),
        IsWindow=Mock(return_value=True),
        IsIconic=Mock(return_value=True),
        ShowWindow=Mock(),
        BringWindowToTop=Mock(),
        SetForegroundWindow=Mock(side_effect=set_foreground),
        GetForegroundWindow=Mock(side_effect=lambda: state["foreground"]),
    )
    process = SimpleNamespace(
        GetWindowThreadProcessId=Mock(side_effect=lambda hwnd: (200 if hwnd == 99 else 300, 42)),
        AttachThreadInput=Mock(return_value=None),
    )
    monkeypatch.setitem(sys.modules, "win32api", SimpleNamespace(GetCurrentThreadId=lambda: 100))
    monkeypatch.setitem(sys.modules, "win32con", SimpleNamespace(GA_ROOT=2, SW_RESTORE=9, SW_SHOW=5))
    monkeypatch.setitem(sys.modules, "win32gui", gui)
    monkeypatch.setitem(sys.modules, "win32process", process)
    return gui, process, state


def test_restores_and_activates_the_opened_document_window(window_system) -> None:
    gui, process, _ = window_system
    document = SimpleNamespace(Activate=Mock(), ActiveWindow=SimpleNamespace(Hwnd=101))
    application = SimpleNamespace(ActiveWindow=SimpleNamespace(Hwnd=202), Hwnd=303)

    assert office_preview._activate_native_window(application, document) is True
    document.Activate.assert_called_once()
    gui.ShowWindow.assert_called_once_with(101, 9)
    assert gui.SetForegroundWindow.call_args.args == (101,)
    assert [call.args for call in process.AttachThreadInput.call_args_list] == [
        (100, 200, True), (100, 300, True), (100, 300, False), (100, 200, False),
    ]


def test_uses_application_handle_when_wps_has_no_active_window(window_system) -> None:
    gui, _, state = window_system
    state["attempts"] = 1
    gui.IsIconic.return_value = False
    document = SimpleNamespace(Activate=Mock(side_effect=AttributeError("unsupported")))

    assert office_preview._activate_native_window(SimpleNamespace(Hwnd=101), document) is True
    gui.ShowWindow.assert_called_once_with(101, 5)


def test_does_not_attach_threads_when_direct_foreground_activation_succeeds(window_system) -> None:
    _, process, state = window_system
    state["attempts"] = 1
    application = SimpleNamespace(Hwnd=101)

    assert office_preview._activate_native_window(application, SimpleNamespace()) is True
    process.AttachThreadInput.assert_not_called()


def test_detaches_attached_threads_when_activation_is_denied(window_system) -> None:
    gui, process, _ = window_system
    gui.SetForegroundWindow.side_effect = OSError("foreground denied")

    assert office_preview._activate_native_window(SimpleNamespace(Hwnd=101), SimpleNamespace()) is False
    assert [call.args for call in process.AttachThreadInput.call_args_list][-2:] == [
        (100, 300, False), (100, 200, False),
    ]


def test_detaches_the_first_thread_when_the_second_attachment_fails(window_system) -> None:
    _, process, _ = window_system

    def attach(_, thread_id, enabled):
        if thread_id == 300 and enabled:
            raise OSError("attachment denied")

    process.AttachThreadInput.side_effect = attach
    assert office_preview._activate_native_window(SimpleNamespace(Hwnd=101), SimpleNamespace()) is False
    assert [call.args for call in process.AttachThreadInput.call_args_list] == [
        (100, 200, True), (100, 300, True), (100, 200, False),
    ]


def test_missing_window_handle_does_not_fail_opening(window_system) -> None:
    gui, _, _ = window_system
    assert office_preview._activate_native_window(SimpleNamespace(), SimpleNamespace()) is False
    gui.ShowWindow.assert_not_called()


@pytest.mark.parametrize("document_type", ["xlsx", "docx"])
@pytest.mark.parametrize("action", ["open", "preview"])
@pytest.mark.parametrize("engine", ["word", "wps"])
def test_worker_activates_window_before_reporting_it_open(
    monkeypatch, document_type: str, action: str, engine: str
) -> None:
    events = []
    opened = SimpleNamespace(Close=Mock())
    application = SimpleNamespace(
        Workbooks=SimpleNamespace(Open=Mock(return_value=opened)),
        Documents=SimpleNamespace(Open=Mock(return_value=opened)),
        Quit=Mock(),
    )
    client = SimpleNamespace(DispatchEx=Mock(return_value=application))
    pythoncom = SimpleNamespace(CoInitialize=Mock(), CoUninitialize=Mock())
    monkeypatch.setitem(sys.modules, "pythoncom", pythoncom)
    monkeypatch.setitem(sys.modules, "win32com", SimpleNamespace(client=client))
    monkeypatch.setitem(sys.modules, "win32com.client", client)
    monkeypatch.setattr(office_preview, "_resolve_progid", lambda *_: "fake.Office")
    monkeypatch.setattr(office_preview, "_application_process_id", lambda _: 42)

    def activate(app, document):
        assert app is application and document is opened
        events.append("activate")
        return False  # OS focus refusal must not fail the native opening job.

    monkeypatch.setattr(office_preview, "_activate_native_window", activate)
    monkeypatch.setattr(office_preview, "_wait_for_native_document_close", lambda *_: events.append("wait"))
    monkeypatch.setattr(office_preview, "_show_document_preview", lambda *_: events.append("preview"))
    monkeypatch.setattr(office_preview, "_show_workbook_preview", lambda *_: events.append("preview"))
    connection = SimpleNamespace(
        send=lambda message: events.append(message[0]), close=lambda: events.append("close")
    )

    office_preview._native_preview_worker(engine, "test-document", document_type, action, connection)

    assert events == [
        "activate", "started", "preview" if action == "preview" else "wait", "completed", "close"
    ]
    assert application.Visible is True
    pythoncom.CoUninitialize.assert_called_once()
    if action == "preview":
        opened.Close.assert_called_once_with(False)
        application.Quit.assert_called_once()
    else:
        opened.Close.assert_not_called()
        application.Quit.assert_not_called()
