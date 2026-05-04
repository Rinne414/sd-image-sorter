from __future__ import annotations

import re
from typing import Optional


_MODEL_FILE_EXTENSIONS = (
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".onnx",
)
_CHECKPOINT_HASH_SUFFIX_RE = re.compile(r"\s+\[[0-9a-fA-F]{4,}\]\s*$")


def normalize_checkpoint_name(value: Optional[str]) -> Optional[str]:
    """Normalize checkpoint names for cross-generator filtering and grouping."""
    text = str(value or "").strip().strip('"').strip("'")
    if not text or text.lower() in {"none", "null"}:
        return None

    text = text.replace("\\", "/").split("/")[-1]
    text = _CHECKPOINT_HASH_SUFFIX_RE.sub("", text).strip()

    lower = text.lower()
    for extension in _MODEL_FILE_EXTENSIONS:
        if lower.endswith(extension):
            text = text[: -len(extension)]
            break

    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def checkpoint_identity_key(value: Optional[str]) -> str:
    """Return a case-insensitive comparison key for checkpoint names."""
    normalized = normalize_checkpoint_name(value)
    return normalized.lower() if normalized else ""
