"""FastAPI dependencies: session resolution, role gate, CSRF belt-and-suspenders.

Per plan §3.4: every existing endpoint eventually gains
`user: User = Depends(current_user)` — that wiring is Phase 4's job. This
phase only defines the dependencies and uses them on the new `/api/auth/*`
routes.
"""
from __future__ import annotations

from typing import Iterator

from fastapi import Depends, HTTPException, Request
from sqlmodel import Session

from backend.auth.db import get_engine
from backend.auth.models import ROLE_KEEPER, User
from backend.auth.service import SESSION_COOKIE_NAME, get_user_for_token
from backend.config import settings


def get_db() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


async def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Not authenticated")
    user = get_user_for_token(db, token)
    if user is None:
        raise HTTPException(401, "Not authenticated")
    return user


async def require_keeper(user: User = Depends(current_user)) -> User:
    if user.role != ROLE_KEEPER:
        raise HTTPException(403, "Keeper only")
    return user


def verify_origin(request: Request) -> None:
    """Belt-and-suspenders CSRF check for mutating handlers.

    SameSite=Lax already blocks cross-site POSTs from browsers; this checks
    the Origin header against the configured CORS origins when present.
    Reusable by later phases' mutating routes too.
    """
    origin = request.headers.get("origin")
    if origin is None:
        return
    allowed = set(settings.cors_origins_list)
    if origin not in allowed:
        raise HTTPException(403, "Origin not allowed")
