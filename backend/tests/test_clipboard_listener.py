from __future__ import annotations

import os
import subprocess
import sys
from unittest.mock import Mock

import pytest

from app.services.clipboard_listener import MAX_CLIPBOARD_CHARACTERS, ClipboardProtocol, ClipboardSnapshot
from desktop import launcher


@pytest.fixture
def clipboard():
    state = {"sequence": 10, "text": "启用前旧内容", "internal": False}
    events = []
    read = Mock(side_effect=lambda: ClipboardSnapshot(**state))

    def write(text):
        state.update(sequence=state["sequence"] + 1, text=text, internal=True)

    protocol = ClipboardProtocol(lambda: state["sequence"], read, write, events.append)
    return protocol, state, read, events


def start(protocol, session="session-1", record="record-1"):
    return protocol.command({
        "action": "start", "sessionId": session, "projectId": "project-1", "recordId": record,
    })


def test_inactive_listener_never_reads_contents(clipboard):
    protocol, state, read, events = clipboard
    protocol.update()
    state.update(sequence=11, text="无关内容")
    protocol.update()
    read.assert_not_called()
    assert events == []


def test_start_ignores_old_contents_and_copies_are_bound_to_the_record(clipboard):
    protocol, state, read, events = clipboard
    assert start(protocol) == {"sequence": 10}
    protocol.update()
    read.assert_not_called()
    state.update(sequence=11, text="姓名")
    protocol.update()
    protocol.update()
    assert events == [{"type": "clipboard", "sessionId": "session-1", "projectId": "project-1",
                       "recordId": "record-1", "sequence": 11, "eventId": 1, "text": "姓名", "manual": False}]
    assert read.call_count == 1


def test_repeated_text_on_new_updates_is_not_discarded(clipboard):
    protocol, state, _, events = clipboard
    start(protocol)
    for sequence in (11, 12):
        state.update(sequence=sequence, text="相同文字")
        protocol.update()
    assert [event["eventId"] for event in events] == [1, 2]
    assert [event["text"] for event in events] == ["相同文字", "相同文字"]


@pytest.mark.parametrize("text", [None, "", " \n"])
def test_non_text_or_empty_updates_do_not_emit_fields(clipboard, text):
    protocol, state, _, events = clipboard
    start(protocol)
    state.update(sequence=11, text=text)
    protocol.update()
    assert events == []
    assert protocol.last_sequence == 11


def test_internal_pathology_writes_and_restored_markers_are_ignored(clipboard):
    protocol, state, _, events = clipboard
    start(protocol)
    protocol.command({"action": "write-internal", "text": "下一条病理号"})
    protocol.update()
    state.update(sequence=12)
    protocol.update()
    protocol.command({"action": "accept", "sessionId": "session-1"})
    assert events == []
    state.update(sequence=13, text="外部手动复制", internal=False)
    protocol.update()
    assert events[0]["text"] == "外部手动复制"


def test_manual_accept_can_consume_an_unchanged_clipboard_once_per_request(clipboard):
    protocol, _, _, events = clipboard
    start(protocol)
    for _ in range(2):
        protocol.command({"action": "accept", "sessionId": "session-1"})
    assert [event["eventId"] for event in events] == [1, 2]
    assert all(event["manual"] for event in events)


def test_stale_stop_or_accept_cannot_affect_a_new_record(clipboard):
    protocol, state, _, events = clipboard
    start(protocol)
    start(protocol, "session-2", "record-2")
    protocol.command({"action": "stop", "sessionId": "session-1"})
    with pytest.raises(ValueError, match="已结束"):
        protocol.command({"action": "accept", "sessionId": "session-1"})
    state.update(sequence=11, text="新记录信息")
    protocol.update()
    assert events[0]["recordId"] == "record-2"
    assert events[0]["sessionId"] == "session-2"


def test_a_busy_read_can_retry_without_losing_its_sequence(clipboard):
    protocol, state, read, events = clipboard
    start(protocol)
    state.update(sequence=11, text="稍后可读")
    original = read.side_effect
    read.side_effect = OSError("busy")
    with pytest.raises(OSError):
        protocol.update()
    assert protocol.last_sequence == 10
    read.side_effect = original
    protocol.update()
    assert events[0]["text"] == "稍后可读"


def test_oversized_text_pauses_without_forwarding_clipboard_content(clipboard):
    protocol, state, _, events = clipboard
    start(protocol)
    state.update(sequence=11, text="x" * (MAX_CLIPBOARD_CHARACTERS + 1))
    protocol.update()
    assert protocol.session is None
    assert events[0]["type"] == "error"
    assert "text" not in events[0]


def test_invalid_session_does_not_read_clipboard(clipboard):
    protocol, _, read, _ = clipboard
    with pytest.raises(ValueError, match="无效"):
        protocol.command({"action": "start", "sessionId": "", "projectId": "p", "recordId": "r"})
    read.assert_not_called()


def test_clipboard_launcher_does_not_initialize_business_data(monkeypatch):
    from app.services import clipboard_listener

    run = Mock()
    monkeypatch.setattr(clipboard_listener, "run_clipboard_listener", run)
    monkeypatch.setattr(launcher, "Settings", Mock(side_effect=AssertionError("must not initialize data")))
    launcher.main(["--clipboard-listener"])
    run.assert_called_once_with()


def test_server_mode_still_requires_explicit_port_and_directory():
    with pytest.raises(SystemExit):
        launcher.parse_args([])


@pytest.mark.parametrize(
    ("arguments", "expected_code", "expected_output"),
    [(["--help"], 0, "--clipboard-listener"), ([], 2, "requires --port and --data-dir")],
    ids=["help", "missing-server-arguments"],
)
def test_launcher_cli_supports_legacy_windows_encoding(
    tmp_path, arguments, expected_code, expected_output,
):
    result = subprocess.run(
        [sys.executable, launcher.__file__, *arguments], cwd=tmp_path,
        env={**os.environ, "PYTHONUTF8": "0", "PYTHONIOENCODING": "cp1252"},
        capture_output=True, text=True, encoding="cp1252", timeout=10,
    )
    assert result.returncode == expected_code, result.stderr
    assert expected_output in result.stdout + result.stderr
