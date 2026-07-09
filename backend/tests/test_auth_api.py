"""Integration tests for /api/auth/* via FastAPI TestClient."""
from __future__ import annotations

import pytest

from backend.auth.service import GENERIC_LOGIN_ERROR, SESSION_COOKIE_NAME
from backend.config import settings


def test_signup_sets_cookie_and_me_matches(client) -> None:
    monkey_invite(client)
    resp = client.post(
        "/api/auth/signup",
        json={"handle": "novoyager", "password": "longenough123", "invite_code": "letmein"},
    )
    assert resp.status_code == 201, resp.text
    assert SESSION_COOKIE_NAME in resp.cookies
    body = resp.json()
    assert body["handle"] == "novoyager"
    assert body["role"] == "voyager"
    assert body["storage_used_bytes"] == 0
    assert body["storage_quota_bytes"] == settings.default_quota_bytes

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json() == body


def test_signup_reserved_handle_rejected(client) -> None:
    monkey_invite(client)
    resp = client.post(
        "/api/auth/signup",
        json={"handle": "admin", "password": "longenough123", "invite_code": "letmein"},
    )
    assert resp.status_code == 400


def test_signup_closed_mode_rejected(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "signup_mode", "closed")
    resp = client.post(
        "/api/auth/signup",
        json={"handle": "someone1", "password": "longenough123"},
    )
    assert resp.status_code == 403


def test_signup_invite_mode_missing_or_wrong_code_rejected(client) -> None:
    monkey_invite(client)
    resp = client.post(
        "/api/auth/signup",
        json={"handle": "someone2", "password": "longenough123"},
    )
    assert resp.status_code == 403

    resp = client.post(
        "/api/auth/signup",
        json={"handle": "someone2", "password": "longenough123", "invite_code": "wrong"},
    )
    assert resp.status_code == 403


def test_signup_invite_mode_correct_code_succeeds(client) -> None:
    monkey_invite(client)
    resp = client.post(
        "/api/auth/signup",
        json={"handle": "someone3", "password": "longenough123", "invite_code": "letmein"},
    )
    assert resp.status_code == 201


def test_login_wrong_password_and_nonexistent_user_identical_error(client) -> None:
    monkey_invite(client)
    client.post(
        "/api/auth/signup",
        json={"handle": "loginuser", "password": "correctpassword1", "invite_code": "letmein"},
    )
    client.cookies.clear()

    wrong_pw = client.post(
        "/api/auth/login", json={"handle": "loginuser", "password": "wrongpassword1"}
    )
    no_user = client.post(
        "/api/auth/login", json={"handle": "nosuchuser", "password": "wrongpassword1"}
    )

    assert wrong_pw.status_code == 401
    assert no_user.status_code == 401
    assert wrong_pw.json()["detail"] == GENERIC_LOGIN_ERROR
    assert no_user.json()["detail"] == GENERIC_LOGIN_ERROR
    assert wrong_pw.json()["detail"] == no_user.json()["detail"]


def test_login_correct_password_succeeds_and_sets_cookie(client) -> None:
    monkey_invite(client)
    client.post(
        "/api/auth/signup",
        json={"handle": "loginuser2", "password": "correctpassword1", "invite_code": "letmein"},
    )
    client.cookies.clear()

    resp = client.post(
        "/api/auth/login", json={"handle": "loginuser2", "password": "correctpassword1"}
    )
    assert resp.status_code == 200
    assert SESSION_COOKIE_NAME in resp.cookies


def test_logout_clears_cookie_and_invalidates_session(client) -> None:
    monkey_invite(client)
    client.post(
        "/api/auth/signup",
        json={"handle": "logoutuser", "password": "correctpassword1", "invite_code": "letmein"},
    )

    me_before = client.get("/api/auth/me")
    assert me_before.status_code == 200

    logout_resp = client.post("/api/auth/logout")
    assert logout_resp.status_code == 204

    me_after = client.get("/api/auth/me")
    assert me_after.status_code == 401


def test_login_rate_limit_5_per_minute(client) -> None:
    monkey_invite(client)
    client.post(
        "/api/auth/signup",
        json={"handle": "ratelimituser", "password": "correctpassword1", "invite_code": "letmein"},
    )
    client.cookies.clear()

    statuses = []
    for _ in range(6):
        resp = client.post(
            "/api/auth/login",
            json={"handle": "ratelimituser", "password": "wrongpassword"},
        )
        statuses.append(resp.status_code)

    assert statuses[:5] == [401, 401, 401, 401, 401]
    assert statuses[5] == 429


def test_signup_rate_limit_3_per_hour(client) -> None:
    monkey_invite(client)
    statuses = []
    for i in range(4):
        resp = client.post(
            "/api/auth/signup",
            json={
                "handle": f"burstuser{i}",
                "password": "correctpassword1",
                "invite_code": "letmein",
            },
        )
        statuses.append(resp.status_code)
        client.cookies.clear()

    assert statuses[:3] == [201, 201, 201]
    assert statuses[3] == 429


def monkey_invite(client) -> None:
    settings.signup_mode = "invite"
    settings.invite_code = "letmein"
