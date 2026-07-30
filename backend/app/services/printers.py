from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


class PrinterInfo4(ctypes.Structure):
    _fields_ = [
        ("pPrinterName", wintypes.LPWSTR),
        ("pServerName", wintypes.LPWSTR),
        ("Attributes", wintypes.DWORD),
    ]


def _default_printer_name(winspool: object) -> str | None:
    needed = wintypes.DWORD()
    winspool.GetDefaultPrinterW(None, ctypes.byref(needed))
    if needed.value == 0:
        return None
    buffer = ctypes.create_unicode_buffer(needed.value)
    if not winspool.GetDefaultPrinterW(buffer, ctypes.byref(needed)):
        return None
    return buffer.value or None


def list_windows_printers() -> list[dict[str, object]]:
    if os.name != "nt":
        return []
    winspool = ctypes.WinDLL("winspool.drv", use_last_error=True)
    flags = 0x00000002 | 0x00000004
    needed = wintypes.DWORD()
    returned = wintypes.DWORD()
    winspool.EnumPrintersW(flags, None, 4, None, 0, ctypes.byref(needed), ctypes.byref(returned))
    if needed.value == 0:
        return []
    buffer = (ctypes.c_byte * needed.value)()
    if not winspool.EnumPrintersW(
        flags,
        None,
        4,
        ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)),
        needed,
        ctypes.byref(needed),
        ctypes.byref(returned),
    ):
        return []
    default_name = _default_printer_name(winspool)
    items = ctypes.cast(buffer, ctypes.POINTER(PrinterInfo4))
    names = {
        items[index].pPrinterName
        for index in range(returned.value)
        if items[index].pPrinterName
    }
    return [
        {"name": name, "is_default": name == default_name}
        for name in sorted(names, key=str.casefold)
    ]
