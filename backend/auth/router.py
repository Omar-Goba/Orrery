"""`/api/auth/*` — signup, login, logout, me. Plan §3.3."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from loguru import logger
from pydantic import BaseModel
from sqlmodel import Session

from backend.auth import service
from backend.auth.deps import current_user, get_db, verify_origin
from backend.auth.models import User
from backend.auth.ratelimit import login_limiter, signup_limiter
from backend.auth.service import AuthError

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SignupRequest(BaseModel):
    handle: str
    display_name: str | None = None
    password: str
    invite_code: str | None = None


class LoginRequest(BaseModel):
    handle: str
    password: str


class MeResponse(BaseModel):
    handle: str
    display_name: str
    role: str
    storage_used_bytes: int
    storage_quota_bytes: int
    created_at: datetime


def _me_response(user: User) -> MeResponse:
    return MeResponse(
        handle=user.handle,
        display_name=user.display_name,
        role=user.role,
        storage_used_bytes=user.storage_used_bytes,
        storage_quota_bytes=user.storage_quota_bytes,
        created_at=user.created_at,
    )


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/signup", response_model=MeResponse, status_code=201)
async def signup(
    body: SignupRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    _origin: None = Depends(verify_origin),
) -> MeResponse:
    if not signup_limiter.allow(_client_ip(request)):
        logger.info("Signup rate limited client_ip={}", _client_ip(request))
        raise HTTPException(429, "Too many signup attempts. Try again later.")
    try:
        user = service.signup(
            db,
            handle=body.handle,
            password=body.password,
            display_name=body.display_name,
            invite_code=body.invite_code,
        )
    except AuthError as exc:
        logger.info("Signup failed handle={} status_code={}", body.handle, exc.status_code)
        raise HTTPException(exc.status_code, exc.message) from None
    token = service.create_session(db, user)
    service.set_session_cookie(response, token)
    logger.info("Signup succeeded user_id={} handle={}", user.id, user.handle)
    return _me_response(user)


@router.post("/login", response_model=MeResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    _origin: None = Depends(verify_origin),
) -> MeResponse:
    if not login_limiter.allow(_client_ip(request)):
        logger.info("Login rate limited client_ip={}", _client_ip(request))
        raise HTTPException(429, "Too many login attempts. Try again later.")
    try:
        user = service.login(db, handle=body.handle, password=body.password)
    except AuthError as exc:
        logger.info("Login failed handle={} status_code={}", body.handle, exc.status_code)
        raise HTTPException(exc.status_code, exc.message) from None
    token = service.create_session(db, user)
    service.set_session_cookie(response, token)
    logger.info("Login succeeded user_id={} handle={}", user.id, user.handle)
    return _me_response(user)


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    _origin: None = Depends(verify_origin),
) -> Response:
    token = request.cookies.get(service.SESSION_COOKIE_NAME)
    if token:
        service.revoke_session(db, token)
        logger.info("Logout session revoked")
    service.clear_session_cookie(response)
    response.status_code = 204
    return response


@router.get("/me", response_model=MeResponse)
async def me(user: User = Depends(current_user)) -> MeResponse:
    return _me_response(user)
