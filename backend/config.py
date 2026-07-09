from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    openai_api_key: str = ""
    mistral_api_key: str = ""
    summary_model: str = "gpt-4o-mini"
    namer_model: str = "gpt-4o-mini"

    ollama_base_url: str = "http://localhost:11434"
    ollama_embed_model: str = "mxbai-embed-large"
    ollama_namer_model: str = "gemma3:4b"

    dbs_dir: Path = Path("./dbs")
    chroma_persist_dir: Path = Path("./dbs/chroma")

    backend_port: int = 8000
    cors_origins: str = "http://localhost:5173"

    # ── auth (Tier 2, phase 1) ──────────────────────────────────────────────
    # signup_mode: "open" | "invite" | "closed"
    signup_mode: str = Field(default="invite", validation_alias="ORRERY_SIGNUP_MODE")
    invite_code: str = Field(default="", validation_alias="ORRERY_INVITE_CODE")
    default_quota_bytes: int = Field(
        default=500 * 1024 * 1024, validation_alias="ORRERY_DEFAULT_QUOTA"
    )  # 500 MiB
    is_production: bool = Field(default=False, validation_alias="ORRERY_IS_PRODUCTION")

    # ── object storage (Tier 2, phase 2) ────────────────────────────────────
    # Per-file cap; the full quota system lands in phase 6, this just gives
    # it somewhere to plug in and keeps a single upload from being unbounded.
    max_pdf_bytes: int = Field(
        default=100 * 1024 * 1024, validation_alias="ORRERY_MAX_PDF_BYTES"
    )  # 100 MiB

    # ── per-user galaxies (Tier 2, phase 3) ─────────────────────────────────
    # Generous default quota for the Keeper's own galaxy, set by the
    # migration script (§11) — separate from `default_quota_bytes`, which is
    # what new Voyager signups get.
    keeper_quota_bytes: int = Field(
        default=10 * 1024 * 1024 * 1024, validation_alias="ORRERY_KEEPER_QUOTA"
    )  # 10 GiB

    @property
    def objects_dir(self) -> Path:
        """Root of the ObjectStore. The only PDF-bytes root in the app —
        nothing outside `backend/services/objectstore.py` should read or
        write here directly."""
        return self.dbs_dir / "objects"

    @property
    def ocr_cache_dir(self) -> Path:
        return self.dbs_dir / "ocr_cache"

    @property
    def papers_json(self) -> Path:
        return self.dbs_dir / "papers.json"

    @property
    def auth_db_path(self) -> Path:
        return self.dbs_dir / "orrery.db"

    @property
    def users_dir(self) -> Path:
        """Root of every per-user galaxy (plan §4.1)."""
        return self.dbs_dir / "users"

    def user_dir(self, user_id: str) -> Path:
        return self.users_dir / user_id

    def user_papers_json(self, user_id: str) -> Path:
        return self.user_dir(user_id) / "papers.json"

    def user_ocr_cache_dir(self, user_id: str) -> Path:
        return self.user_dir(user_id) / "ocr_cache"

    def user_object_prefix(self, user_id: str) -> str:
        """`ScopedObjectStore` prefix for a user's objects, e.g.
        `users/{user_id}` (POSIX, relative — matches `ObjectStore` key
        shape, not a filesystem path)."""
        return f"users/{user_id}"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]


settings = Settings()
