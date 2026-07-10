from __future__ import annotations

from contextvars import ContextVar
from uuid import uuid4

from loguru import logger
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
            logger.info(
                "Request complete method={} path={} status_code={}",
                request.method,
                request.url.path,
                response.status_code,
            )
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = request_id
        return response
