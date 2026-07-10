from __future__ import annotations

import json


def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"
