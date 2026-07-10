from __future__ import annotations

from typing import BinaryIO

CHUNK_SIZE = 1024 * 1024


def stream_object(stream: BinaryIO, chunk_size: int = CHUNK_SIZE):
    """Read an ObjectStore stream in fixed-size chunks, closing it when done."""
    try:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        stream.close()
