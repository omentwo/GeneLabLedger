from __future__ import annotations

import argparse
import multiprocessing
import os
import sys
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import uvicorn

from app.config import Settings


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="基因检测台账本机后端")
    parser.add_argument("--clipboard-listener", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int)
    parser.add_argument("--data-dir", type=Path)
    arguments = parser.parse_args(argv)
    if not arguments.clipboard_listener and (arguments.port is None or arguments.data_dir is None):
        parser.error("本机后端需要 --port 和 --data-dir")
    return arguments


def main(argv: Sequence[str] | None = None) -> None:
    multiprocessing.freeze_support()
    arguments = parse_args(argv)
    if arguments.clipboard_listener:
        from app.services.clipboard_listener import run_clipboard_listener

        run_clipboard_listener()
        return
    os.environ["GENE_LEDGER_DESKTOP_MODE"] = "1"

    from app.main import create_app

    settings = Settings(
        host=arguments.host,
        port=arguments.port,
        data_dir=arguments.data_dir,
        database_url=None,
        auto_create_schema=True,
    )
    desktop_app = create_app(settings=settings)
    server = uvicorn.Server(
        uvicorn.Config(
            desktop_app,
            host=settings.host,
            port=settings.port,
            log_level="warning",
            access_log=False,
        )
    )
    desktop_app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    server.run()


if __name__ == "__main__":
    main()
