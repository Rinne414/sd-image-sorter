from __future__ import annotations

import re
import sqlite3

from migrations._schema_common import table_exists


VERSION = 6
NAME = "prompt_token_index"


def _normalize_prompt_token_v1(token: str) -> str:
    """Migration-frozen prompt token normalization (v1)."""
    return token.lower().replace("_", " ").strip()


def _extract_prompt_tokens_v1(prompt: str) -> set[str]:
    """Migration-frozen prompt tokenizer used by v6 backfill."""
    if not prompt:
        return set()

    clean_prompt = re.sub(r"<[^>]+>[^<]*</[^>]+>", "", prompt)
    clean_prompt = re.sub(r"<lora:[^>]+>", "", clean_prompt)
    clean_prompt = re.sub(r"<[^>]+>", "", clean_prompt)

    tokens: set[str] = set()
    for token in clean_prompt.split(","):
        token = token.strip()
        if not token:
            continue
        clean_token = re.sub(r"^\(+|\)+$", "", token)
        clean_token = re.sub(r":\d+\.?\d*\)?$", "", clean_token)
        clean_token = clean_token.strip()
        if not clean_token or len(clean_token) <= 1:
            continue
        normalized = _normalize_prompt_token_v1(clean_token)
        if normalized and len(normalized) > 1:
            tokens.add(normalized)

    return tokens


def apply(conn: sqlite3.Connection) -> None:
    """Create and backfill normalized prompt-token rows for prompt-library facets."""
    if not table_exists(conn, "images"):
        return

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS image_prompt_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id INTEGER NOT NULL,
            token TEXT NOT NULL,
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
            UNIQUE(image_id, token)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_image_prompt_tokens_token ON image_prompt_tokens(token)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_image_prompt_tokens_image_id ON image_prompt_tokens(image_id)")

    conn.execute("DELETE FROM image_prompt_tokens")
    rows = conn.execute("SELECT id, prompt FROM images WHERE prompt IS NOT NULL AND prompt != ''").fetchall()
    for row in rows:
        for token in _extract_prompt_tokens_v1(row[1] or ""):
            conn.execute(
                "INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)",
                (row[0], token),
            )
