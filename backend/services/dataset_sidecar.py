"""Strict readers for Dataset Maker caption sidecars."""
from __future__ import annotations

from pathlib import Path
from typing import Optional


MAX_DATASET_SIDECAR_BYTES = 1024 * 1024


def read_dataset_sidecar(image_path: str, max_bytes: int) -> Optional[str]:
    """Read a same-stem UTF-8 caption, preserving absent versus empty."""
    sidecar_path = Path(image_path).with_suffix(".txt")
    try:
        if not sidecar_path.exists():
            return None
        if not sidecar_path.is_file():
            raise ValueError(
                f"Caption sidecar is not a file: path={sidecar_path}"
            )
        size = sidecar_path.stat().st_size
        if size > max_bytes:
            raise ValueError(
                "Caption sidecar is too large: "
                f"path={sidecar_path}, size={size}, max_bytes={max_bytes}"
            )
        with sidecar_path.open("rb") as handle:
            payload = handle.read(max_bytes + 1)
    except ValueError:
        raise
    except OSError as exc:
        raise ValueError(
            f"Caption sidecar could not be read: path={sidecar_path}, error={exc}"
        ) from exc

    if len(payload) > max_bytes:
        raise ValueError(
            "Caption sidecar is too large: "
            f"path={sidecar_path}, size={len(payload)}, max_bytes={max_bytes}"
        )
    try:
        return payload.decode("utf-8-sig").strip()
    except UnicodeDecodeError as exc:
        raise ValueError(
            f"Caption sidecar must be UTF-8: path={sidecar_path}, error={exc}"
        ) from exc


def dataset_sidecar_tag_rows(caption: str) -> list[dict[str, str]]:
    """Convert a Booru sidecar into tag rows for the export renderer."""
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_line in caption.splitlines():
        for raw_tag in raw_line.split(","):
            tag = raw_tag.strip()
            key = tag.lower()
            if not tag or key in seen:
                continue
            seen.add(key)
            rows.append({"tag": tag})
    return rows
