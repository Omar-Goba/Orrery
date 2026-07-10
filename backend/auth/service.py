"""Signup / login / logout / session-validation business logic.

Rules exactly per documentation/ORRERY_AUTH_PLAN.md §3.3:
- password >= 10 chars
- reserved handles rejected (hard-coded here; the migration script that
  creates the Keeper bypasses this check at the DB layer directly — that's a
  later phase's job, not this module's)
- ORRERY_SIGNUP_MODE gates signup (open | invite | closed)
- login/signup error text never reveals which check failed (no user
  enumeration): "no such user" and "wrong password" are identical
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from backend.auth.models import HANDLE_RE, ROLE_VOYAGER, AuthSession, User, utcnow
from backend.auth.security import generate_session_token, hash_password, hash_token, verify_password
from backend.config import settings

SESSION_COOKIE_NAME = "orrery_session"
SESSION_TTL = timedelta(days=30)

# Reserved handles: Tier 1 "core" words + Tier 1 fake-galaxy handles, so the
# landing-page fakes never collide with real people.
RESERVED_HANDLES: frozenset[str] = frozenset(
    {
        "admin",
        "keeper",
        "voyager",
        "tour",
        "api",
        "orrery",
        "omar",
        "m.chen",
        "vega-7",
    }
)

GENERIC_LOGIN_ERROR = "Incorrect handle or password."
MIN_PASSWORD_LEN = 10


class AuthError(Exception):
    """Raised with a user-facing message and an HTTP status code."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def validate_handle(handle: str) -> str:
    handle = handle.strip().lower()
    if not HANDLE_RE.match(handle):
        raise AuthError(
            "Handle must be 3-24 characters, lowercase letters/digits/._- , "
            "starting with a letter or digit."
        )
    if handle in RESERVED_HANDLES:
        raise AuthError("That handle is reserved.")
    return handle


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LEN:
        raise AuthError(f"Password must be at least {MIN_PASSWORD_LEN} characters.")


def check_signup_allowed(invite_code: str | None) -> None:
    mode = settings.signup_mode
    if mode == "closed":
        raise AuthError("Signups are closed right now.", status_code=403)
    if mode == "invite":
        if not invite_code or invite_code != settings.invite_code:
            raise AuthError("A valid invite code is required to sign up.", status_code=403)
    elif mode == "open":
        pass
    else:
        raise AuthError("Signups are misconfigured.", status_code=500)


def signup(
    session: Session,
    *,
    handle: str,
    password: str,
    display_name: str | None = None,
    invite_code: str | None = None,
) -> User:
    check_signup_allowed(invite_code)
    handle = validate_handle(handle)
    validate_password(password)

    existing = session.exec(select(User).where(User.handle == handle)).first()
    if existing is not None:
        raise AuthError("That handle is already taken.", status_code=409)

    import uuid

    user = User(
        id=uuid.uuid4().hex,
        handle=handle,
        display_name=(display_name or handle).strip() or handle,
        password_hash=hash_password(password),
        role=ROLE_VOYAGER,
        storage_quota_bytes=settings.default_quota_bytes,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def login(session: Session, *, handle: str, password: str) -> User:
    handle = handle.strip().lower()
    user = session.exec(select(User).where(User.handle == handle)).first()
    if user is None or user.disabled:
        # Burn a hash cycle anyway to keep timing roughly consistent between
        # "no such user" and "wrong password".
        verify_password(password, _DUMMY_HASH)
        raise AuthError(GENERIC_LOGIN_ERROR, status_code=401)
    if not verify_password(password, user.password_hash):
        raise AuthError(GENERIC_LOGIN_ERROR, status_code=401)
    return user


# Precomputed dummy hash so a nonexistent-user login still pays the argon2 cost.
_DUMMY_HASH = hash_password("dummy-password-for-timing")


def create_session(session: Session, user: User) -> str:
    token = generate_session_token()
    now = utcnow()
    auth_session = AuthSession(
        token_hash=hash_token(token),
        user_id=user.id,
        created_at=now,
        expires_at=now + SESSION_TTL,
        last_seen_at=now,
    )
    session.add(auth_session)
    session.commit()
    return token


def get_user_for_token(session: Session, token: str) -> User | None:
    token_hash = hash_token(token)
    auth_session = session.get(AuthSession, token_hash)
    if auth_session is None:
        return None
    now = utcnow()
    expires_at = auth_session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now:
        return None
    user = session.get(User, auth_session.user_id)
    if user is None or user.disabled:
        return None
    # sliding expiry: touch last_seen_at + expires_at on every valid use
    auth_session.last_seen_at = now
    auth_session.expires_at = now + SESSION_TTL
    session.add(auth_session)
    session.commit()
    return user


def revoke_session(session: Session, token: str) -> None:
    token_hash = hash_token(token)
    auth_session = session.get(AuthSession, token_hash)
    if auth_session is not None:
        session.delete(auth_session)
        session.commit()


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=settings.is_production,
        max_age=int(SESSION_TTL.total_seconds()),
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")
