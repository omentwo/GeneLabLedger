from __future__ import annotations

import argparse
import multiprocessing
import os
from collections.abc import Sequence
from pathlib import Path

import uvicorn

from app.config import Settings


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="基因检测台账本机后端")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    multiprocessing.freeze_support()
    arguments = parse_args(argv)
    os.environ["GENE_LEDGER_DESKTOP_MODE"] = "1"

    from app.main import create_app

    settings = Settings(
        host=arguments.host,
        port=arguments.port,
        data_dir=arguments.data_dir,
        database_url=None,
        auto_create_schema=True,
    )
    uvicorn.run(
        create_app(settings=settings),
        host=settings.host,
        port=settings.port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
