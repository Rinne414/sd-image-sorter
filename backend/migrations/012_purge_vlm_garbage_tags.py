"""Migration 012: Purge VLM garbage tags from existing libraries.

Background
==========
Earlier versions of ``vlm_providers/base.py:_parse_tag_list`` only checked
length 2 ≤ len ≤ 100 when splitting a VLM response into danbooru-style
tags. Real Gemma / Qwen / GPT outputs leak markdown headings, prose
sentences, LaTeX equations and chain-of-thought into the tag list, so
phrases like ``### 1. Address the …``, ``$$x = …$$``,
``Are you looking for information on the character`` and
``feel free to ask!`` ended up persisted as tags.

The new ``_looks_like_garbage_tag`` filter rejects them at the parsing
layer, but existing libraries already contain hundreds of polluted rows
that distort ``/api/stats`` top-tags, prompt-lab seeds, and tag
autocomplete. This migration runs once to purge the existing pollution.

We import the same ``_looks_like_garbage_tag`` function used by the
parser so the migration and the runtime always agree on what counts as
garbage.
"""
from __future__ import annotations

import logging
import sqlite3
import sys
from pathlib import Path

from migrations._schema_common import table_exists

logger = logging.getLogger(__name__)

VERSION = 12
NAME = "purge_vlm_garbage_tags"


def _looks_like_garbage_tag(tag: str) -> bool:
    """Inline copy of vlm_providers.base._looks_like_garbage_tag.

    The migration runs during DB initialization before the rest of the
    backend is fully imported, and migrations should be self-contained
    so they can be replayed on schema-only sandboxes (CI fixtures). We
    keep the logic verbatim and pin it via a regression test
    (test_migration_012_purges_match_runtime_filter).
    """
    _MARKDOWN_PREFIXES = ("#", "*", "-", "+", ">", "•", "·", "—", "–")
    _PROSE_SUFFIX_CHARS = {".", "!", "?", "。", "！", "？"}
    _FORBIDDEN_SUBSTRINGS = ("$$", "```", "://", "|", "<sub>", "<sup>")

    if not tag:
        return True
    if not (2 <= len(tag) <= 100):
        return True
    stripped = tag.strip()
    if not stripped:
        return True
    if stripped[0] in _MARKDOWN_PREFIXES:
        return True
    if len(stripped) >= 2 and stripped[0].isdigit():
        idx = 0
        while idx < len(stripped) and stripped[idx].isdigit():
            idx += 1
        if idx < len(stripped) and stripped[idx] in (".", ")"):
            tail = stripped[idx + 1 :].lstrip()
            if tail and (" " in tail or any(c.isupper() for c in tail[:1])):
                return True
    lowered = stripped.lower()
    for forbidden in _FORBIDDEN_SUBSTRINGS:
        if forbidden in lowered:
            return True
    if stripped[-1] in _PROSE_SUFFIX_CHARS:
        return True
    if ": " in stripped or "; " in stripped:
        return True
    if stripped.count('"') >= 2 or stripped.count("'") >= 3:
        return True
    if stripped.count(" ") >= 6:
        return True
    if stripped.count(" ") >= 4 and stripped[:1].isupper() and stripped[1:2].islower():
        return True
    if stripped[0] in ('"', "'") and stripped.count(stripped[0]) == 1:
        return True
    return False


def apply(conn: sqlite3.Connection) -> bool:
    """Delete tag rows whose tag text matches the VLM garbage shape."""
    if not table_exists(conn, "tags"):
        return False

    cursor = conn.cursor()
    cursor.execute("SELECT id, tag FROM tags")
    rows = cursor.fetchall()
    if not rows:
        return False

    bad_ids = [row[0] for row in rows if _looks_like_garbage_tag(row[1] or "")]
    if not bad_ids:
        return False

    logger.warning(
        "[migration 012] Purging %d VLM garbage tag rows from %d total tag rows",
        len(bad_ids),
        len(rows),
    )

    # Delete in batches of 500 to avoid massive parameter lists on huge
    # libraries. SQLite's max bound parameters defaults to 999.
    batch_size = 500
    deleted = 0
    for start in range(0, len(bad_ids), batch_size):
        batch = bad_ids[start : start + batch_size]
        placeholders = ",".join("?" * len(batch))
        cursor.execute(f"DELETE FROM tags WHERE id IN ({placeholders})", batch)
        deleted += cursor.rowcount

    return deleted > 0
