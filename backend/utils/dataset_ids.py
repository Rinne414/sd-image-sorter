"""Stable identifiers for Dataset Maker local file paths."""
from __future__ import annotations

import hashlib


def dataset_source_id(abs_path: str) -> str:
    """Return the stable browser-facing ID for one absolute source path."""
    digest = hashlib.sha1(
        str(abs_path).encode("utf-8", errors="replace")
    ).hexdigest()
    return f"ds:{digest[:16]}"
