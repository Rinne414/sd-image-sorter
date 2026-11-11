"""Chinese and Japanese words typed into the Gallery search, read as tags.

The search box matches file names, prompts and captions, which are in English,
so "猫耳" found nothing although the program ships a table that knows 猫耳 is
``cat_ears`` (the one the tag type-ahead uses). This looks a typed word up in
that table as a whole name, never as a part of one: "猫" must not quietly
become ``cat_ears``.

Several tags can carry the same Chinese name. The one the user's library
actually has wins (most pictures first); when the library has none of them the
most common tag on Danbooru is returned with ``pictures`` 0, so the caller can
still search the prompt text for its English words.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, Iterable, List

from services import tag_suggest_service

MAX_WORDS = 20


def _candidates(word: str) -> List[str]:
    """Tags whose Chinese/Japanese names include exactly ``word``, most common first."""
    tag_suggest_service._ensure_loaded()
    wanted = word.strip().lower()
    found: List[str] = []
    for names, tag, _count, _code in tag_suggest_service._ZH_BLOBS or []:
        if wanted in names and wanted in (name.strip() for name in names.split(",")):
            found.append(tag)
    return found


def _library_counts(tags: Iterable[str]) -> Dict[str, int]:
    """How many pictures of the library carry each tag (written with underscores or spaces)."""
    import database

    wanted = list(dict.fromkeys(tags))
    if not wanted:
        return {}
    # Both spellings by exact value, so the tag index answers (no scan of the table).
    spellings = list(dict.fromkeys([*wanted, *(tag.replace("_", " ") for tag in wanted)]))
    marks = ",".join("?" for _ in spellings)
    sql = f"SELECT tag, COUNT(DISTINCT image_id) FROM tags WHERE tag IN ({marks}) GROUP BY tag"
    counts: Dict[str, int] = {}
    try:
        conn = database.get_connection()
        try:
            for tag, pictures in conn.execute(sql, spellings).fetchall():
                name = str(tag).replace(" ", "_")
                counts[name] = counts.get(name, 0) + int(pictures)
        finally:
            conn.close()
    except sqlite3.Error:
        return {}
    return counts


def lookup(words: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """``{word: {"tag", "pictures"}}`` for every word the table knows as a whole name."""
    result: Dict[str, Dict[str, Any]] = {}
    for word in list(dict.fromkeys(str(w).strip() for w in words if str(w).strip()))[
        :MAX_WORDS
    ]:
        candidates = _candidates(word)
        if not candidates:
            continue
        counts = _library_counts(candidates)
        # Most pictures in this library first; the table's own order (most common) breaks ties.
        best = max(candidates, key=lambda tag: counts.get(tag, 0))
        result[word] = {"tag": best, "pictures": counts.get(best, 0)}
    return result
