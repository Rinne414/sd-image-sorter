"""Noise-tag vocabulary + multi-tagger consensus fusion for Smart Tag.

Owns the QUALITY/SCORE/SAFETY/META/TIME noise vocabularies, is_noise_tag /
filter_noise_tags, and compute_consensus_tags (the v3.2.2 T-power-PR2 (D)
weighted vote). Pure functions only - no job state, no model loading.

Split verbatim out of services/smart_tag_service.py (see that facade's
docstring for the decomposition map).
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from services.export_template_engine import is_kaomoji_tag


# ---------------------------------------------------------------------------
# Noise-tag vocabularies
#
# The token sets below are danbooru / Pony-style training conventions: the
# QUALITY / SCORE / SAFETY / META / TIME family of tags that LoRA trainers
# anchor literally and do not want the VLM to paraphrase. The vocabulary is
# industry standard public-domain taxonomy from the WD14 / Pony / Illustrious
# recipes, not adapted from any single project's source.
# ---------------------------------------------------------------------------

QUALITY_NOISE_TAGS: frozenset = frozenset({
    "masterpiece", "best quality", "good quality", "normal quality",
    "low quality", "worst quality", "high quality", "high_quality",
    "best_quality", "lowres", "highres", "absurdres",
})

# Pony score_N family. Includes the bare and "_up" rollup forms.
SCORE_NOISE_TAGS: frozenset = frozenset(
    {f"score_{i}" for i in range(1, 10)}
    | {"score_9_up", "score_8_up", "score_7_up", "score_6_up"}
    # Also handle space-normalized variants.
    | {f"score {i}" for i in range(1, 10)}
)

SAFETY_NOISE_TAGS: frozenset = frozenset({
    "safe", "sensitive", "questionable", "nsfw", "explicit",
    # OppaiOracle-style "rating:explicit" markers
    "rating:general", "rating:sensitive", "rating:questionable", "rating:explicit",
})

META_NOISE_TAGS: frozenset = frozenset({
    "anime", "illustration", "anime screenshot", "anime_screenshot",
    "jpeg artifacts", "jpeg_artifacts", "official art", "official_art",
    "sketch", "monochrome", "greyscale", "grayscale",
})

TIME_NOISE_TAGS: frozenset = frozenset({
    "newest", "recent", "mid", "early", "old",
})

# Combined set used by auto-strip; callers can subset if they want
# finer-grained control.
DEFAULT_NOISE_TAGS: frozenset = (
    QUALITY_NOISE_TAGS
    | SCORE_NOISE_TAGS
    | SAFETY_NOISE_TAGS
    | META_NOISE_TAGS
    | TIME_NOISE_TAGS
)

_SCORE_RE: re.Pattern = re.compile(r"^score[\s_]\d+(_up)?$", re.IGNORECASE)
_YEAR_RE: re.Pattern = re.compile(r"^(?:year\s*)?\d{4}$", re.IGNORECASE)
# Prompt-syntax fragments (``::``, ``--``, ``//`` …) that leak in as "tags".
# Real danbooru emoticon vocabulary (``^_^``, ``:d``, ``^^^`` …) used to be
# listed here too — that deleted legitimate WD14 expression tags from every
# caption (audit P1-4), so emoticons are now exempted via ``is_kaomoji_tag``
# before this regex runs.
_SYMBOLIC_TAG_RE: re.Pattern = re.compile(r"^(?:[:;=][a-z0-9]?|[xX][dDpP3]|[<>^@!;:=_\\/-]{2,}|[<>^@!;:=_\\/-]+[a-z0-9])$")


def is_noise_tag(tag: str, noise_set: Iterable[str] = DEFAULT_NOISE_TAGS) -> bool:
    """Return True if ``tag`` should be stripped before VLM / final caption.

    Handles the score_N family via regex (so ``score_9_up`` is caught even
    though it is in the literal set) and the ``year 2024`` regex form.
    """
    lowered = (tag or "").strip().lower()
    if not lowered:
        return True
    if lowered in noise_set:
        return True
    if _SCORE_RE.match(lowered) or _YEAR_RE.match(lowered):
        return True
    # Emoticons are legitimate WD14 expression vocabulary, never noise.
    if is_kaomoji_tag(lowered):
        return False
    if _SYMBOLIC_TAG_RE.match(lowered):
        return True
    return False


def filter_noise_tags(
    tags: List[str], noise_set: Iterable[str] = DEFAULT_NOISE_TAGS
) -> Tuple[List[str], int]:
    """Return ``(kept_tags, stripped_count)`` with noise entries dropped, preserving order.

    Callers that only need the kept list can unpack the tuple; callers that
    want to surface how many tags were stripped (e.g. the Smart Tag job
    progress snapshot) read the second element.
    """
    noise_lower = {n.lower() for n in noise_set}
    kept: List[str] = []
    stripped = 0
    for t in tags:
        if is_noise_tag(t, noise_lower):
            stripped += 1
        else:
            kept.append(t)
    return kept, stripped


def compute_consensus_tags(
    per_tagger_outputs: List[Dict[str, Any]],
    *,
    consensus_min: int = 2,
    skip_categories: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """v3.2.2 T-power-PR2 (D): fuse the outputs of N taggers via weighted
    voting + per-category bypass.

    Each ``per_tagger_outputs`` entry is::

        {
            "model": str,
            "weight": float,            # 0.0-1.0, defaults to 1.0
            "general_tags":   [{tag, confidence, category}, ...],
            "character_tags": [...],
            "rating": {label, score} | str,
        }

    Voting rule per tag:

      - sum of weights from taggers that produced it (above their own
        threshold — that filtering already happened upstream) is >= ``consensus_min``
      - OR the tag's category is in ``skip_categories`` (default
        ``{'character', 'copyright'}``) — most taggers can't recognize
        characters reliably, so we use OR semantics there: any single
        tagger detecting it keeps it.

    Returns ``{"general_tags": [...], "copyright_tags": [...], "character_tags": [...], "rating": str}``
    where each output tag carries:

      - ``tag``: name (verbatim from the first tagger that produced it)
      - ``confidence``: max confidence across the taggers that voted yes
      - ``category``: 'general' | 'copyright' | 'character'
      - ``votes``: int — count of taggers that produced this tag (for diagnostics)
    """
    skip = set(
        s.lower() for s in (
            skip_categories
            if skip_categories is not None
            else {"character", "copyright"}
        )
    )
    consensus_min = max(1, int(consensus_min or 1))

    # Per-tag accumulator: {tag_lc: {tag, category, votes_count, weight_sum, max_conf}}
    accum: Dict[str, Dict[str, Any]] = {}

    for output in per_tagger_outputs or []:
        weight = float(output.get("weight") or 1.0)
        for category_key, category_label in (
            ("general_tags", "general"),
            ("copyright_tags", "copyright"),
            ("character_tags", "character"),
        ):
            for tag_row in (output.get(category_key) or []):
                if isinstance(tag_row, dict):
                    name = str(tag_row.get("tag") or "").strip()
                    conf = float(tag_row.get("confidence") or 0.0)
                    cat = str(tag_row.get("category") or category_label).lower()
                else:
                    name = str(tag_row or "").strip()
                    conf = 1.0
                    cat = category_label
                if not name:
                    continue
                key = name.lower()
                slot = accum.setdefault(key, {
                    "tag": name,
                    "category": cat,
                    "votes": 0,
                    "weight_sum": 0.0,
                    "max_conf": 0.0,
                    "first_category": category_label,
                })
                slot["votes"] += 1
                slot["weight_sum"] += weight
                if conf > slot["max_conf"]:
                    slot["max_conf"] = conf

    general: List[Dict[str, Any]] = []
    copyright: List[Dict[str, Any]] = []
    character: List[Dict[str, Any]] = []

    for slot in accum.values():
        category = slot["first_category"]
        bypass = category in skip
        if not bypass and slot["weight_sum"] < float(consensus_min):
            continue
        rendered = {
            "tag": slot["tag"],
            "confidence": round(slot["max_conf"], 4) if slot["max_conf"] else 1.0,
            "category": category,
            "votes": slot["votes"],
        }
        if category == "character":
            character.append(rendered)
        elif category == "copyright":
            copyright.append(rendered)
        else:
            general.append(rendered)

    # Rating: pick the rating from the tagger with the highest score across
    # all taggers that returned one. Plain-string ratings get score=1.0.
    best_rating = ""
    best_rating_score = -1.0
    for output in per_tagger_outputs or []:
        rating = output.get("rating")
        if not rating:
            continue
        if isinstance(rating, dict):
            label = str(rating.get("label") or "").strip()
            score = float(rating.get("score") or 0.0)
        else:
            label = str(rating).strip()
            score = 1.0
        if label and score > best_rating_score:
            best_rating = label
            best_rating_score = score

    return {
        "general_tags": general,
        "copyright_tags": copyright,
        "character_tags": character,
        "rating": best_rating,
    }
