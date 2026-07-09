from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

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

    @property
    def input_dir(self) -> Path:
        return self.dbs_dir / "input"

    @property
    def output_dir(self) -> Path:
        return self.dbs_dir / "output"

    @property
    def papers_json(self) -> Path:
        return self.dbs_dir / "papers.json"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]


settings = Settings()
