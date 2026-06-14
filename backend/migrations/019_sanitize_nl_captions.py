"""Migration 019: Sanitize raw-JSON NL captions persisted by older builds.

Background
==========
ToriiGate is fine-tuned heavily on JSON answers and often returned
``{"description": ..., "tags": ...}`` (frequently truncated mid-string by
the 160-token generation cap) even when asked for prose. Older builds
stored that raw model output directly as ``images.nl_caption`` and fused
it into ``images.ai_caption`` (``"tag1, tag2, {json...}"``), so every
export mode (tags_nl / nl_caption / template ``{nl_caption}``) leaked
half-a-JSON-blob into training captions.

The runtime now sanitizes at the write point
(``ToriiGateTagger._sanitize_nl_text`` and
``vlm_providers.base._extract_caption_from_jsonish``); this migration
heals the rows already persisted. The sanitize logic is an inline copy of
``ToriiGateTagger._sanitize_nl_text`` — migrations must stay
self-contained so they can replay on schema-only sandboxes — and is
pinned to the runtime implementation by a regression test.

Safety: only rows whose ``nl_caption`` is a whole JSON-shaped payload
(``{...}``, a string/object array, fenced JSON, or a top-level caption/tag
key) are touched; ordinary prose that merely contains ``"key": "value"``
or bracketed shot labels is ignored. The transformation is idempotent because
sanitized prose no longer matches that shape.
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3

from migrations._schema_common import table_exists

logger = logging.getLogger(__name__)

VERSION = 19
NAME = "sanitize_nl_captions"

_NL_CAPTION_JSON_KEYS = (
    "description",
    "caption",
    "nl",
    "nl_caption",
    "natural_language",
    "text",
    "summary",
)
_NL_NON_CAPTION_JSON_KEYS = {"tags", "tag", "rating", "score", "characters"}


def _strip_reasoning(text: str) -> str:
    cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL)
    if "</think>" in cleaned:
        cleaned = cleaned.split("</think>", 1)[-1]
    return cleaned.strip()


def _strip_json_fence(text: str) -> str:
    fence = re.match(r"^```[a-zA-Z0-9_-]*\s*\n?(.*?)\n?```\s*$", text.strip(), re.DOTALL)
    return fence.group(1).strip() if fence else text.strip()


def _is_jsonish(text: str) -> bool:
    stripped = _strip_json_fence(_strip_reasoning(text or ""))
    if not stripped:
        return False
    if re.match(r'^\{\s*"(?:[^"\\]|\\.)+"\s*:', stripped):
        return True
    if re.match(r'^\[\s*(?:\{|"|\])', stripped):
        return True
    return bool(
        re.match(
            r'^"(?:description|caption|nl|nl_caption|natural_language|text|summary|tags|tag)"\s*:',
            stripped,
            re.IGNORECASE,
        )
    )


def _sanitize_nl_text(text: str) -> str:
    """Inline copy of ToriiGateTagger._sanitize_nl_text.

    Kept verbatim and pinned via a regression test
    (test_migration_019_sanitize_matches_runtime) so the migration and the
    runtime always agree on the cleaned output.
    """
    cleaned = _strip_json_fence(_strip_reasoning(text))
    if not _is_jsonish(cleaned):
        return cleaned

    try:
        parsed = json.loads(cleaned)
    except Exception:
        parsed = None
    if isinstance(parsed, dict):
        for key in _NL_CAPTION_JSON_KEYS:
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        candidates = [
            value
            for key, value in parsed.items()
            if isinstance(value, str)
            and value.strip()
            and str(key).lower() not in _NL_NON_CAPTION_JSON_KEYS
        ]
        return max(candidates, key=len).strip() if candidates else ""
    if isinstance(parsed, list):
        strings = [item.strip() for item in parsed if isinstance(item, str) and item.strip()]
        return " ".join(strings)

    match = re.search(
        r'"(?:description|caption|nl|nl_caption|natural_language|text|summary)"\s*:\s*"((?:[^"\\]|\\.)*)',
        cleaned,
    )
    if match:
        value = match.group(1).rstrip("\\")
        try:
            value = json.loads(f'"{value}"')
        except Exception:
            value = value.replace('\\"', '"').replace("\\n", " ")
        return value.strip()

    pairs = re.findall(r'"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned)
    candidates = [
        value
        for key, value in pairs
        if value.strip() and key.lower() not in _NL_NON_CAPTION_JSON_KEYS
    ]
    if candidates:
        return max(candidates, key=len).strip()
    if pairs:
        return ""

    return cleaned.strip('{}[]"\n\t ,')


def _rewrite_ai_caption(ai_caption: str, old_nl: str, new_nl: str) -> str:
    """Replace the JSON blob inside the fused caption and tidy separators."""
    if not ai_caption or old_nl not in ai_caption:
        return ai_caption
    rewritten = ai_caption.replace(old_nl, new_nl)
    rewritten = re.sub(r"\s*,\s*,+", ", ", rewritten)
    return rewritten.strip().strip(",").strip()


def apply(conn: sqlite3.Connection) -> bool:
    """Rewrite JSON-shaped nl_caption rows (and their fused ai_caption)."""
    if not table_exists(conn, "images"):
        return False

    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT id, nl_caption, ai_caption FROM images
            WHERE nl_caption IS NOT NULL AND nl_caption != ''
              AND (
                    LTRIM(nl_caption) LIKE '{%'
                 OR LTRIM(nl_caption) LIKE '[%'
                 OR LTRIM(nl_caption) LIKE '```%'
                 OR LTRIM(nl_caption) LIKE '"description":%'
                 OR LTRIM(nl_caption) LIKE '"caption":%'
                 OR LTRIM(nl_caption) LIKE '"nl":%'
                 OR LTRIM(nl_caption) LIKE '"nl_caption":%'
                 OR LTRIM(nl_caption) LIKE '"natural_language":%'
                 OR LTRIM(nl_caption) LIKE '"text":%'
                 OR LTRIM(nl_caption) LIKE '"summary":%'
                 OR LTRIM(nl_caption) LIKE '"tags":%'
                 OR LTRIM(nl_caption) LIKE '"tag":%'
                 OR nl_caption LIKE '%</think>{%'
                 OR nl_caption LIKE '%</think>[%'
              )
            """
        )
    except sqlite3.OperationalError:
        # Pre-018 sandbox without the nl_caption column — nothing to heal.
        return False
    rows = cursor.fetchall()
    if not rows:
        return False

    updates = []
    for image_id, nl_caption, ai_caption in rows:
        old_nl = str(nl_caption or "")
        if not _is_jsonish(old_nl):
            continue
        new_nl = _sanitize_nl_text(old_nl)
        if new_nl == old_nl:
            continue
        new_ai = _rewrite_ai_caption(str(ai_caption or ""), old_nl, new_nl)
        updates.append((new_nl, new_ai, image_id))

    if not updates:
        return False

    logger.warning(
        "[migration 019] Sanitizing %d JSON-shaped nl_caption rows", len(updates)
    )
    cursor.executemany(
        "UPDATE images SET nl_caption = ?, ai_caption = ? WHERE id = ?",
        updates,
    )
    return True
