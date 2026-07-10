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
