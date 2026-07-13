import pytest
from pydantic import ValidationError

from backend.config import Settings


def test_legacy_openai_key_populates_openai_roles(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "legacy-key")

    configured = Settings(_env_file=None)

    assert configured.llm_summary.api_key == "legacy-key"
    assert configured.llm_namer.api_key == "legacy-key"
    assert configured.llm_oracle.api_key == "legacy-key"
    assert configured.llm_curator.api_key == "legacy-key"
    assert configured.llm_master.api_key == "legacy-key"
    assert configured.llm_embedder.api_key == ""


def test_role_specific_key_takes_precedence(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "legacy-key")
    monkeypatch.setenv("LLM_ORACLE__API_KEY", "oracle-key")

    configured = Settings(_env_file=None)

    assert configured.llm_oracle.api_key == "oracle-key"


def test_s3_settings_require_complete_configuration(monkeypatch) -> None:
    monkeypatch.setenv("ORRERY_OBJECT_STORE", "s3")

    with pytest.raises(ValidationError) as exc_info:
        Settings(_env_file=None)

    message = str(exc_info.value)
    assert "ORRERY_S3_BUCKET" in message
    assert "ORRERY_S3_REGION" in message
    assert "ORRERY_S3_ACCESS_KEY_ID" in message
    assert "ORRERY_S3_SECRET_ACCESS_KEY" in message


def test_s3_credentials_are_excluded_and_masked(monkeypatch) -> None:
    monkeypatch.setenv("ORRERY_OBJECT_STORE", "s3")
    monkeypatch.setenv("ORRERY_S3_BUCKET", "orrery")
    monkeypatch.setenv("ORRERY_S3_REGION", "us-east-1")
    monkeypatch.setenv("ORRERY_S3_ACCESS_KEY_ID", "access-secret")
    monkeypatch.setenv("ORRERY_S3_SECRET_ACCESS_KEY", "private-secret")

    configured = Settings(_env_file=None)

    assert "access-secret" not in repr(configured)
    assert "private-secret" not in repr(configured)
    assert "s3_access_key_id" not in configured.model_dump()
    assert "s3_secret_access_key" not in configured.model_dump()


def test_s3_validation_errors_do_not_disclose_credentials(monkeypatch) -> None:
    monkeypatch.setenv("ORRERY_OBJECT_STORE", "s3")
    monkeypatch.setenv("ORRERY_S3_REGION", "us-east-1")
    monkeypatch.setenv("ORRERY_S3_ACCESS_KEY_ID", "access-canary")
    monkeypatch.setenv("ORRERY_S3_SECRET_ACCESS_KEY", "secret-canary")

    with pytest.raises(ValidationError) as exc_info:
        Settings(_env_file=None)

    message = str(exc_info.value)
    assert "access-canary" not in message
    assert "secret-canary" not in message
