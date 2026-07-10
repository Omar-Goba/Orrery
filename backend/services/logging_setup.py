from __future__ import annotations

import logging
import sys
from pathlib import Path

from loguru import logger

from backend.middleware import request_id_var

_CONFIGURED = False


class InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            level: str | int = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        frame, depth = logging.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())


def configure_logging(log_dir: Path, level: str) -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return

    log_dir.mkdir(parents=True, exist_ok=True)
    logger.remove()
    logger.configure(
        patcher=lambda record: record["extra"].setdefault("request_id", request_id_var.get())
    )
    fmt = (
        "{time:YYYY-MM-DD HH:mm:ss.SSS} | {level:<8} | "
        "request_id={extra[request_id]} | {name}:{function}:{line} | {message}"
    )
    logger.add(sys.stdout, level=level, format=fmt, enqueue=True)
    logger.add(
        log_dir / "orrery_{time:YYYY-MM-DD}.log",
        level=level,
        format=fmt,
        rotation="00:00",
        retention="14 days",
        compression="zip",
        enqueue=True,
    )
    intercept = InterceptHandler()
    root = logging.getLogger()
    root.handlers = [intercept]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        target = logging.getLogger(name)
        target.handlers = [intercept]
        target.propagate = False
        target.setLevel(level)

    _CONFIGURED = True
