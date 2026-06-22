from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader


class OCRService:
    SIDECAR_SUFFIX = ".ocr.json"

    async def extract(self, pdf_path: Path) -> str:
        sidecar = self._sidecar_path(pdf_path)
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

    def _sidecar_path(self, pdf_path: Path) -> Path:
        return pdf_path.with_suffix(self.SIDECAR_SUFFIX)

    def _write_cache(self, sidecar: Path, text: str) -> None:
        sidecar.write_text(
            json.dumps({"text": text, "cached_at": datetime.now(timezone.utc).isoformat()})
        )
