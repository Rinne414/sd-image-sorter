"""Dataset Maker tag-vocabulary aggregation service.

Extracted from ``routers/dataset.py`` in v3.4.5 — the vocab endpoint
previously did DB lookup + tag parsing + sorting inline in the router.
Moved here so the router is a thin adapter and the aggregation logic
is independently testable.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from pydantic import BaseModel, ConfigDict, Field


logger = logging.getLogger(__name__)


class DatasetVocabRequest(BaseModel):
    """Request body for ``POST /api/dataset/vocab``.

    Returns the union of tags across ``image_ids`` (DB-source) and
    ``path_caption_overrides`` (local-source captions split by comma)
    sorted by descending frequency, optionally truncated to ``top_n``.

    Each entry includes a ``sample_image_id`` from the DB-source rows
    so the frontend can preview-link the tag to a representative
    image; for path-only items the sample_image_id is 0.
    """

    model_config = ConfigDict(extra="ignore")

    # Bounded at 50k to mirror the audit ``item_limit`` cap. A 50k-id
    # request still builds a 50k-row tags map in memory, but that is
    # already the upper bound the rest of the dataset endpoints accept.
    image_ids: List[int] = Field(default_factory=list, max_length=50_000)
    path_caption_overrides: Dict[str, str] = Field(default_factory=dict)
    top_n: int = Field(default=300, ge=1, le=2000)


def build_dataset_vocab(payload: DatasetVocabRequest) -> Dict[str, Any]:
    """Aggregate tag frequencies across DB-source ids + path caption overrides.

    Returns ``{vocab: [{tag, count, sample_image_id}], total_unique_tags}``.
    Tags are sorted by descending count, alphabetical for ties, and
    truncated to ``payload.top_n``. DB lookup failures are logged and
    degrade to an empty DB-source contribution rather than 500ing the
    whole request — the path-caption contribution is independent.
    """
    counts: Dict[str, int] = {}
    samples: Dict[str, int] = {}

    image_ids_clean = list({int(i) for i in payload.image_ids if int(i) > 0})
    if image_ids_clean:
        try:
            import database as db
            tags_map = db.get_image_tags_map(image_ids_clean) or {}
        except Exception as exc:  # noqa: BLE001
            logger.warning("vocab: DB tag lookup failed: %s", exc)
            tags_map = {}
        for image_id, tag_rows in tags_map.items():
            for tag_row in tag_rows or []:
                if isinstance(tag_row, dict):
                    tag = str(tag_row.get("tag") or "").strip()
                else:
                    tag = str(tag_row or "").strip()
                if not tag:
                    continue
                counts[tag] = counts.get(tag, 0) + 1
                samples.setdefault(tag, int(image_id))

    # Local-source: split caption overrides by comma to produce an
    # approximate tag list. Captions are NL+booru-mixed so this is
    # rough, but it's good enough to surface "trigger word X appears
    # in 18 of 20 captions" — the most common Dataset Maker question.
    for _path, caption in (payload.path_caption_overrides or {}).items():
        if not caption:
            continue
        for token in str(caption).split(","):
            tag = token.strip()
            if not tag:
                continue
            counts[tag] = counts.get(tag, 0) + 1
            samples.setdefault(tag, 0)

    # Sort: highest count first, alphabetical for ties.
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))
    if payload.top_n and len(ordered) > payload.top_n:
        ordered = ordered[: payload.top_n]

    return {
        "vocab": [
            {"tag": tag, "count": count, "sample_image_id": samples.get(tag, 0)}
            for tag, count in ordered
        ],
        "total_unique_tags": len(counts),
    }
