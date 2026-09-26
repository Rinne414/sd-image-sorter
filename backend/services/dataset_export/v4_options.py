"""Two dataset export options V4 adds: the ``_nl.txt`` twin and implication dedup.

Both reuse the tag export implementation so the two exporters write the same
text: ``collapse_implications`` (the table behind ``/api/tags/export-batch``'s
``dedupe_implications``) and ``_build_nl_sidecar_content`` /
``_image_nl_source_text`` (its ``nl_sidecar``). Both default off, and off
leaves every caption and every file exactly as before.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional, Set, Tuple

from services.annotation_models import TrainingCaptionContentV1
from services.tag_export.captions import (
    _build_nl_sidecar_content,
    _image_nl_source_text,
)
from services.tag_training_filters import collapse_implications

NL_SIDECAR_SUFFIX = "_nl"
# The content modes whose sidecar holds tags only, so a sentence can go beside it.
NL_SIDECAR_CONTENT_MODES = frozenset({"template", "tags"})


def dedupe_caption_implications(caption: str) -> str:
    """Drop comma tokens implied by a more specific token of the same caption.

    Returns the caption untouched when nothing is implied, so the option can
    only ever remove parents (``cat ears`` drops ``animal ears``).
    """
    tokens = [part.strip() for part in str(caption).split(",") if part.strip()]
    kept = collapse_implications(tokens)
    if len(kept) == len(tokens):
        return caption
    return ", ".join(kept)


def dedupe_content_implications(
    content: TrainingCaptionContentV1,
) -> TrainingCaptionContentV1:
    """An edited caption with the same dedup applied to its tag part."""
    booru = dedupe_caption_implications(content.booru_caption)
    if booru == content.booru_caption:
        return content
    return content.model_copy(update={"booru_caption": booru})


def nl_twin_path(caption_path: Path) -> Path:
    return caption_path.with_name(
        f"{caption_path.stem}{NL_SIDECAR_SUFFIX}{caption_path.suffix}"
    )


def plan_nl_twin(
    caption_path: Path,
    overwrite_policy: str,
    used_caption_paths: Set[str],
) -> Tuple[Optional[Path], Optional[str]]:
    """Where this caption's ``_nl`` twin goes, before anything of the row is written.

    Returns ``(path, None)`` to write it, ``(None, None)`` to leave an existing
    twin in place (the "skip" rule), or ``(None, reason)`` when the row must
    fail so no image is exported without its twin.
    """
    twin = nl_twin_path(caption_path)
    keys = {str(twin), str(twin.resolve(strict=False))}
    if keys & used_caption_paths:
        if overwrite_policy == "skip":
            return None, None
        return None, (
            f"{twin.name} is also another image's caption in this export; "
            "rename one of the images"
        )
    exists = os.path.lexists(twin)
    if exists and overwrite_policy == "unique":
        return None, (
            f"{twin.name} already exists; choose overwrite or skip, "
            "or export into another folder"
        )
    used_caption_paths.update(keys)
    if exists and overwrite_policy == "skip":
        return None, None
    return twin, None


def nl_twin_text(
    record: Dict[str, Any],
    content: Optional[TrainingCaptionContentV1],
    nl_overrides_int: Dict[int, str],
    nl_overrides_path: Dict[str, str],
    trigger: str,
    prefix: str,
) -> str:
    """The twin's single line: the edited sentence, else the stored one; trigger first."""
    if content is not None:
        sentence = content.nl_caption
    else:
        image_id = int(record.get("id") or 0)
        src_path = str(record.get("path") or "")
        if not image_id and src_path in nl_overrides_path:
            sentence = nl_overrides_path[src_path]
        else:
            sentence = _image_nl_source_text(record, image_id, nl_overrides_int)
    lead = str(trigger or "").strip() or str(prefix or "").strip()
    return _build_nl_sidecar_content(sentence, lead)


__all__ = [
    "NL_SIDECAR_CONTENT_MODES",
    "NL_SIDECAR_SUFFIX",
    "dedupe_caption_implications",
    "dedupe_content_implications",
    "nl_twin_path",
    "nl_twin_text",
    "plan_nl_twin",
]
