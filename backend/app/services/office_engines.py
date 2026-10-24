from __future__ import annotations

import os
import threading
import time
import winreg

# 注册表检测是进程级只读状态，且 Office/WPS 在应用运行期间几乎不会变化。
# 健康检查每 5 秒调用一次引擎状态，若不缓存会产生每天数万次注册表打开，
# 因此这里做一层带 TTL 的缓存；用户安装 Office 后最多等待一个 TTL 即可。
CACHE_TTL_SECONDS = 300.0

_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, bool]] = {}


def is_progid_registered(progid: str, *, ttl: float = CACHE_TTL_SECONDS) -> bool:
    """Return whether a COM ProgID is registered, cached for ``ttl`` seconds."""
    if os.name != "nt":
        return False
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(progid)
        if cached is not None and now - cached[0] < ttl:
            return cached[1]
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, rf"{progid}\CLSID"):
            registered = True
    except OSError:
        registered = False
    with _cache_lock:
        _cache[progid] = (now, registered)
    return registered
