"""Which pictures came from one generation run.

Pictures share a run key when their prompt, negative prompt, checkpoint and
size match; the gallery puts pictures next to each other in time with the same
key, minutes apart, into one stack ("Group runs"). The key is a short hash so
the listing sends no prompt text for it. A picture without a prompt has no key
and is never grouped.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, Iterable, Optional

# Listing rows read the prompt under these names only to make the key.
RUN_PROMPT_FIELD = "_run_prompt"
RUN_NEGATIVE_FIELD = "_run_negative"
RUN_KEY_SELECT = (
    f"i.prompt AS {RUN_PROMPT_FIELD}, i.negative_prompt AS {RUN_NEGATIVE_FIELD}"
)
_KEY_LENGTH = 16


def run_key(
    prompt: Optional[str],
    negative: Optional[str],
    checkpoint: Optional[str],
    width: Any,
    height: Any,
) -> Optional[str]:
    text = (prompt or "").strip()
    if not text:
        return None
    parts = (
        text,
        (negative or "").strip(),
        (checkpoint or "").strip().lower(),
        str(width or ""),
        str(height or ""),
    )
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:_KEY_LENGTH]


def attach_run_keys(rows: Iterable[Dict[str, Any]]) -> None:
    """Add ``run_key`` to listing rows and drop the prompt fields read only for it."""
    for row in rows:
        prompt = row.pop(RUN_PROMPT_FIELD, None)
        negative = row.pop(RUN_NEGATIVE_FIELD, None)
        if prompt is None:
            prompt = row.get("prompt")
            negative = row.get("negative_prompt")
        row["run_key"] = run_key(
            prompt,
            negative,
            row.get("checkpoint_normalized") or row.get("checkpoint"),
            row.get("width"),
            row.get("height"),
        )
