"""Integration tests for /api/auth/* via FastAPI TestClient."""
from __future__ import annotations

import pytest
from sqlmodel import Session

from backend.auth.db import get_engine
from backend.auth.models import ROLE_KEEPER, User
from backend.auth.service import GENERIC_LOGIN_ERROR, SESSION_COOKIE_NAME
from backend.config import settings


def test_signup_sets_cookie_and_me_matches(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkey_invite(monkeypatch)
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


def test_signup_reserved_handle_rejected(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkey_invite(monkeypatch)
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


def test_signup_invite_mode_missing_or_wrong_code_rejected(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkey_invite(monkeypatch)
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


def test_signup_invite_mode_correct_code_succeeds(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkey_invite(monkeypatch)
    resp = client.post(
        "/api/auth/signup",
        json={"handle": "someone3", "password": "longenough123", "invite_code": "letmein"},
    )
    assert resp.status_code == 201


def test_public_galaxies_are_real_active_voyagers_and_capped(client) -> None:
    with Session(get_engine()) as db:
        for index in range(14):
            db.add(
                User(
                    id=f"voyager-{index}",
                    handle=f"realvoyager{index:02d}",
                    display_name=f"Real Voyager {index}",
                    password_hash="unused",
                    disabled=index == 13,
                )
            )
        db.add(
            User(
                id="keeper",
                handle="realkeeper",
                display_name="Real Keeper",
                password_hash="unused",
                role=ROLE_KEEPER,
            )
        )
        db.commit()

    response = client.get("/api/auth/galaxies")

    assert response.status_code == 200
    assert len(response.json()) == 12
    assert response.json()[0] == {
        "handle": "realvoyager00",
        "display_name": "Real Voyager 0",
    }
    assert all(galaxy["handle"] != "realkeeper" for galaxy in response.json())
    assert all(galaxy["handle"] != "realvoyager13" for galaxy in response.json())


def test_login_wrong_password_and_nonexistent_user_identical_error(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkey_invite(monkeypatch)
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


def test_login_correct_password_succeeds_and_sets_cookie(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkey_invite(monkeypatch)
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


def test_logout_clears_cookie_and_invalidates_session(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkey_invite(monkeypatch)
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


def test_login_rate_limit_5_per_minute(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkey_invite(monkeypatch)
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


def test_signup_rate_limit_3_per_hour(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkey_invite(monkeypatch)
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


def monkey_invite(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "signup_mode", "invite")
    monkeypatch.setattr(settings, "invite_code", "letmein")
