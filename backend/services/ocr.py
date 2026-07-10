from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader

from backend.config import settings


class OCRService:
    """Extracts text from a PDF, with a cache keyed by `cache_key` — usually
    the content-hash `paper_id` — rather than by filesystem path.

    Phase 2 moved PDF bytes into the `ObjectStore`; ingest now only ever has
    a throwaway tempfile copy of the object to hand pypdf (plan §10.1 rule
    #4: code that needs a real local path copies the stream out and cleans
    up, it doesn't ask the store for its path). A tempfile's path is not a
    stable cache key, so the sidecar cache moved to `dbs/ocr_cache/{key}.ocr.json`.
    """

    SIDECAR_SUFFIX = ".ocr.json"

    async def extract(
        self, pdf_path: Path, cache_key: str, cache_dir: Path | None = None
    ) -> str:
        """`cache_dir` defaults to the global `settings.ocr_cache_dir`.

        Per-user `UserSpace`s (plan §4.1) pass their own
        `settings.user_ocr_cache_dir(user_id)` so the cache sidecar physically
        lives under `users/{user_id}/ocr_cache/` — even though `OCRService`
        itself is a shared, user-agnostic singleton (§4.4), each call site
        picks where its own sidecar lands.
        """
        sidecar = self._sidecar_path(cache_key, cache_dir)
        if sidecar.exists():
            data = json.loads(sidecar.read_text())
            return data["text"]
        text = self._pypdf_extract(pdf_path)
        self._write_cache(sidecar, text)
        return text

    def _pypdf_extract(self, pdf_path: Path) -> str:
        try:
            reader = PdfReader(str(pdf_path))
            parts = []
            for page in reader.pages:
                t = page.extract_text()
                if t:
                    parts.append(t)
            return "\n\n".join(parts)
        except Exception:
            return ""

    def _sidecar_path(self, cache_key: str, cache_dir: Path | None = None) -> Path:
        cache_dir = cache_dir if cache_dir is not None else settings.ocr_cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir / f"{cache_key}{self.SIDECAR_SUFFIX}"

    def _write_cache(self, sidecar: Path, text: str) -> None:
        sidecar.write_text(
            json.dumps({"text": text, "cached_at": datetime.now(timezone.utc).isoformat()})
        )
