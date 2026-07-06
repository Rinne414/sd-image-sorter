"""VLM tag vocabulary gate (audit P2-8).

VLM-generated danbooru tags are only shape-validated (``base._parse_tag_list``)
before they are persisted, so a hallucinated non-vocabulary tag — or a rating
word the model was instructed to emit — becomes a permanent library tag and
pollutes tag search, stats, and autocomplete.

This gate drops any candidate that is neither in the bundled danbooru
vocabulary nor already an existing library tag, and ALWAYS drops rating words
regardless of vocabulary membership (rating is a separate reader field, never a
tag). Normalization mirrors ``tag_suggest_service._normalize_tag`` exactly so
the accept-set membership test lines up with how the vocabulary is keyed — and
so kaomoji tags that exist verbatim in the CSV (``^_^``, ``>_<``) survive: we
lowercase and turn spaces into underscores but never strip punctuation.
"""
from __future__ import annotations

import logging
import re
from typing import Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# Rating words never belong in a tag list. Covers the danbooru rating
# vocabulary plus the common safe/nsfw synonyms models emit.
_RATING_WORDS = frozenset({
    "general",
    "safe",
    "sensitive",
    "questionable",
    "explicit",
    "nsfw",
    "sfw",
})
# Prefixed forms: ``rating:explicit``, ``rating_general``, ``rating-e``, etc.
_RATING_PREFIX_RE = re.compile(r"^rating[\s:_-]")

# Cached bundled-vocabulary accept-set (the CSV is static for the process
# lifetime; the library half is fetched per call because it changes).
_DANBOORU_ACCEPT: Optional[frozenset] = None


def normalize_tag(raw: str) -> str:
    """Normalize a candidate the same way the danbooru vocab is keyed.

    Mirrors ``tag_suggest_service._normalize_tag``: trim, lowercase, spaces to
    underscores. Deliberately does NOT strip punctuation so kaomoji tags that
    exist verbatim in the vocabulary (``^_^``, ``>_<``) are preserved.
    """
    return (raw or "").strip().lower().replace(" ", "_")


def _is_rating_word(tag: str) -> bool:
    return tag in _RATING_WORDS or bool(_RATING_PREFIX_RE.match(tag))


def reset_cache() -> None:
    """Testing hook: drop the cached danbooru accept-set."""
    global _DANBOORU_ACCEPT
    _DANBOORU_ACCEPT = None


def _danbooru_accept_set() -> frozenset:
    """Lazily build and cache the bundled danbooru vocabulary accept-set.

    Reuses ``tag_suggest_service``'s already-cached tag→index map instead of
    re-parsing the ~140k-row CSV. Returns an empty set when the vocabulary is
    unavailable (missing asset / load failure); the library-tag half of the
    gate still applies, and the gate never crashes the persist path.
    """
    global _DANBOORU_ACCEPT
    if _DANBOORU_ACCEPT is not None:
        return _DANBOORU_ACCEPT
    accept: Set[str] = set()
    try:
        from services.tag_suggest_service import get_vocab_tag_index

        index = get_vocab_tag_index()
        if index:
            accept = set(index.keys())
    except Exception as exc:  # pragma: no cover - defensive: gate must not crash persist
        logger.warning("VLM tag gate: danbooru vocabulary unavailable: %s", exc)
    _DANBOORU_ACCEPT = frozenset(accept)
    return _DANBOORU_ACCEPT


def _library_tag_set() -> Set[str]:
    """Normalized set of the user's existing library tag names.

    User-defined custom tags are legal even if absent from the bundled
    vocabulary, so they must stay in the accept-set.
    """
    try:
        import database as db

        return {
            normalize_tag(row.get("tag") or "")
            for row in (db.get_all_tags() or [])
            if row.get("tag")
        }
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("VLM tag gate: library tags unavailable: %s", exc)
        return set()


def filter_vlm_tags(candidates: Iterable[str]) -> Tuple[List[str], int]:
    """Drop out-of-vocabulary and rating-word tags from a VLM tag list.

    A candidate is accepted when — after normalization — it is either in the
    bundled danbooru vocabulary or already a library tag, and is not a rating
    word. Accepted tags are returned normalized (``lowercase_with_underscores``),
    de-duplicated, in first-seen order.

    Returns ``(accepted_tags, dropped_count)``.
    """
    accept = _danbooru_accept_set()
    library = _library_tag_set()
    accepted: List[str] = []
    seen: Set[str] = set()
    dropped = 0
    for raw in candidates or []:
        tag = normalize_tag(str(raw))
        if not tag:
            continue
        if _is_rating_word(tag):
            dropped += 1
            continue
        if tag in seen:
            continue
        if tag in accept or tag in library:
            seen.add(tag)
            accepted.append(tag)
        else:
            dropped += 1
    return accepted, dropped
