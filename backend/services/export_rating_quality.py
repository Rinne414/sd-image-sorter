"""Per-image rating / quality resolution for the caption template engine.

Split verbatim (2026-07) out of ``services/export_template_engine.py`` (see
that facade's docstring for the decomposition map). Owns the rating canon /
vocabularies, ``resolve_canonical_rating``, the aesthetic-score quality
buckets, and ``flatten_single_line``. Pure functions only.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


# ====================================================================
# Per-image rating / quality resolution
# ====================================================================

# Rating markers as they appear in stored tag rows: WD14-family taggers write
# the bare category-9 word (general/sensitive/questionable/explicit),
# OppaiOracle writes "rating:x" markers, and manual edits may use the
# single-letter danbooru shorthand. All map to the canonical danbooru word.
RATING_TAG_CANON: Dict[str, str] = {
    "general": "general", "g": "general", "safe": "general",
    "rating:general": "general", "rating:safe": "general",
    "sensitive": "sensitive", "s": "sensitive", "rating:sensitive": "sensitive",
    "questionable": "questionable", "q": "questionable",
    "rating:questionable": "questionable",
    "explicit": "explicit", "e": "explicit", "rating:explicit": "explicit",
}

# Vocabulary the generic ``{rating}`` slot renders (matches the pre-v3.5.0
# word choice: danbooru words with ``general`` shown as ``safe``). Presets
# with a stricter model-card vocabulary override via ``safety_vocab``.
DEFAULT_RATING_VOCAB: Dict[str, str] = {
    "general": "safe",
    "sensitive": "sensitive",
    "questionable": "questionable",
    "explicit": "explicit",
}

_RATING_SLOT_PATTERN = re.compile(r"\{(?:rating|safety)\}")


def canonical_rating_word(tag: str) -> Optional[str]:
    """Map a stored tag to its canonical danbooru rating word, or None."""
    return RATING_TAG_CANON.get(str(tag or "").strip().lower())


def resolve_canonical_rating(
    image: Dict[str, Any],
    tags: List[Dict[str, Any]],
    override: Optional[str] = None,
) -> str:
    """Resolve the image's rating: override > image field > tag rows > "".

    Ratings live only as tag rows today (the tagger pipelines store the
    winning rating category as a normal tag/confidence row); the ``rating``
    dict field is honored first so a future column keeps working unchanged.
    Returns the canonical danbooru word or "" when the image was never rated.
    """
    if override is not None and str(override).strip():
        text = str(override).strip().lower()
        return RATING_TAG_CANON.get(text, text)
    field_value = str(image.get("rating") or "").strip().lower()
    if field_value:
        return RATING_TAG_CANON.get(field_value, field_value)
    best, best_conf = "", -1.0
    for row in tags or []:
        canon = canonical_rating_word(str(row.get("tag") or ""))
        if canon is None:
            continue
        try:
            conf = float(row.get("confidence") or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        if conf > best_conf:
            best, best_conf = canon, conf
    return best


# Aesthetic-score buckets → danbooru-style quality ladder (the vocabulary the
# Anima card trains with). The LAION score is ~1-10; thresholds are a
# judgment call documented here rather than hidden: most anime renders land
# in the 4-7 band, so 7+ is genuinely rare-good and <3 is genuinely broken.
_QUALITY_BUCKETS: List[tuple] = [
    (7.0, "masterpiece, best quality"),
    (6.0, "best quality"),
    (5.0, "good quality"),
    (4.0, ""),  # normal band — no token beats a meaningless one
    (3.0, "low quality"),
]


# deepghs anime_aesthetic grade -> the same ladder. The grade is a percentile
# rank among the model's reference anime pictures (backend/anime_aesthetic.py:
# masterpiece >= 95th, best >= 85th, great >= 75th, good >= 50th, normal >= 25th,
# low >= 10th, worst below), which is how NoobAI-XL's model card assigns its
# quality tags (masterpiece > 95th, best quality > 85th, good quality > 60th,
# normal quality > 30th, worst quality <= 30th). The vocabulary has no word
# between "best" and "good", so great and good both render "good quality";
# normal renders nothing, like the LAION normal band.
ANIME_GRADE_QUALITY: Dict[str, str] = {
    "masterpiece": "masterpiece, best quality",
    "best": "best quality",
    "great": "good quality",
    "good": "good quality",
    "normal": "",
    "low": "low quality",
    "worst": "worst quality",
}


def quality_from_anime_grade(grade: Any) -> Optional[str]:
    """Map a deepghs anime grade to quality tags; None when unknown or unscored."""
    if grade is None:
        return None
    return ANIME_GRADE_QUALITY.get(str(grade).strip().lower())


def resolve_quality_tokens(image: Dict[str, Any]) -> Optional[str]:
    """Quality tags for one image: anime grade first, else the LAION score bucket.

    The anime grade is the danbooru quality ladder itself (trained on it), so
    it wins when the picture has one; the CLIP+LAION score is a general-photo
    predictor and only fills in for pictures the anime scorer never saw.
    Returns None when the image carries neither.
    """
    from_grade = quality_from_anime_grade(image.get("aesthetic_anime_grade"))
    if from_grade is not None:
        return from_grade
    return quality_from_aesthetic_score(image.get("aesthetic_score"))


def quality_from_aesthetic_score(score: Any) -> Optional[str]:
    """Map an aesthetic score (~1-10) to quality tags; None when unscored."""
    if score is None:
        return None
    try:
        value = float(score)
    except (TypeError, ValueError):
        return None
    for threshold, label in _QUALITY_BUCKETS:
        if value >= threshold:
            return label
    return "worst quality"


def flatten_single_line(text: str) -> str:
    """Collapse all whitespace (incl. newlines) to single spaces.

    kohya-style trainers read only the first line of a caption file (or one
    random line with ``enable_wildcard``); multi-paragraph NL captions must
    be flattened before they hit a single-caption ``.txt``.
    """
    return " ".join(str(text or "").split())
