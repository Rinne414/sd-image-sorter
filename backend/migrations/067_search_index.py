"""Migration 067: a trigram index for the text searches, and a LoRA lookup index.

Why: the gallery's free-text search, the "prompt contains" filter and the exact
prompt-term filter used to test every picture against LIKE patterns (and parse
every picture's metadata JSON for the NovelAI character text). At 100,000
pictures that was 0.6 to 1.2 seconds for the count alone. The LoRA filter probed
``image_loras`` once per picture through ``LOWER(lora_name)``, which no index
could serve.

What this adds (all derived data, rebuilt from the tables that already exist):

* ``image_text_fts``: an FTS5 trigram table, one row per picture (rowid = the
  picture id) whose single ``body`` column holds every text the searches look
  at: file name, checkpoint, prompt, sidecar caption and the NovelAI character
  text (underscores shown as spaces, the way the searches compare them).
  Triggers on ``images`` keep it in step with every writer.
* ``prompt_token_vocab`` and ``prompt_token_vocab_fts``: the distinct values of
  ``image_prompt_tokens.token`` and a trigram index over them, kept in step by a
  trigger on ``image_prompt_tokens``. A word found here leads to the pictures
  that carry it through the existing token index.
* ``idx_image_loras_lora_lower``: an index on ``LOWER(lora_name), image_id``.

The index only narrows which pictures are tested: the queries keep their
original LIKE conditions, so what they find does not change. A trigram index
cannot look up a word shorter than 3 characters, so shorter searches keep
scanning as before.

Additive and idempotent. A SQLite build without FTS5 or without the trigram
tokenizer (older than 3.34) gets only the LoRA index and keeps scanning.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists

VERSION = 67
NAME = "search_index"

TEXT_FTS = "image_text_fts"
VOCAB = "prompt_token_vocab"
VOCAB_FTS = "prompt_token_vocab_fts"

# The columns whose change must refresh a picture's text row.
_WATCHED_COLUMNS = (
    "filename",
    "checkpoint_normalized",
    "prompt",
    "sidecar_caption",
    "metadata_json",
)


def _has_note(conn: sqlite3.Connection) -> bool:
    """Whether ``images.note`` exists yet (migration 069 adds it)."""
    return any(row[1] == "note" for row in conn.execute("PRAGMA table_info(images)").fetchall())


def _doc_sql(row: str, with_note: bool = False) -> str:
    """The searchable text of one picture, as a SQL expression over ``row``.

    ``row`` is a table alias (backfill) or NEW (trigger). The five parts match
    what the LIKE conditions read: file name and checkpoint as stored, the other
    three with underscores shown as spaces. The character text comes from the
    same JSON path the search conditions use; a metadata_json that is not valid
    JSON contributes nothing (json_extract would raise inside a trigger and
    block the write).
    """
    return (
        f"COALESCE({row}.filename, '') || char(10) || "
        f"COALESCE({row}.checkpoint_normalized, '') || char(10) || "
        f"REPLACE(COALESCE({row}.prompt, ''), '_', ' ') || char(10) || "
        f"REPLACE(COALESCE({row}.sidecar_caption, ''), '_', ' ') || char(10) || "
        f"REPLACE(COALESCE(CASE WHEN json_valid({row}.metadata_json) "
        f"THEN json_extract({row}.metadata_json, '$._parsed.character_prompt_text') END, ''), "
        f"'_', ' ')"
        # The user's own note on the picture (migration 069), searched like a caption.
        + (f" || char(10) || REPLACE(COALESCE({row}.note, ''), '_', ' ')" if with_note else "")
    )


def trigram_supported(conn: sqlite3.Connection) -> bool:
    """True when this SQLite build can create an FTS5 trigram table."""
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE temp._trigram_probe USING fts5(x, tokenize='trigram')"
        )
    except sqlite3.Error:
        return False
    conn.execute("DROP TABLE temp._trigram_probe")
    return True


def _object_exists(conn: sqlite3.Connection, kind: str, name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?", (kind, name)
        ).fetchone()
        is not None
    )


def _create_text_index(conn: sqlite3.Connection) -> None:
    conn.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS {TEXT_FTS} USING fts5(body, tokenize='trigram')"
    )
    with_note = _has_note(conn)
    images = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
    indexed = conn.execute(f"SELECT COUNT(*) FROM {TEXT_FTS}").fetchone()[0]
    if images != indexed:
        conn.execute(f"DELETE FROM {TEXT_FTS}")
        conn.execute(
            f"INSERT INTO {TEXT_FTS}(rowid, body) SELECT i.id, {_doc_sql('i', with_note)} FROM images i"
        )

    columns = _WATCHED_COLUMNS + (("note",) if with_note else ())
    watched = ", ".join(columns)
    changed = " OR ".join(f"OLD.{c} IS NOT NEW.{c}" for c in columns)
    conn.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_{TEXT_FTS}_insert AFTER INSERT ON images
        BEGIN
            INSERT INTO {TEXT_FTS}(rowid, body) VALUES (NEW.id, {_doc_sql("NEW", with_note)});
        END
        """
    )
    conn.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_{TEXT_FTS}_update AFTER UPDATE OF {watched} ON images
        WHEN {changed}
        BEGIN
            DELETE FROM {TEXT_FTS} WHERE rowid = OLD.id;
            INSERT INTO {TEXT_FTS}(rowid, body) VALUES (NEW.id, {_doc_sql("NEW", with_note)});
        END
        """
    )
    conn.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_{TEXT_FTS}_delete AFTER DELETE ON images
        BEGIN
            DELETE FROM {TEXT_FTS} WHERE rowid = OLD.id;
        END
        """
    )


def _create_token_vocab(conn: sqlite3.Connection) -> None:
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS {VOCAB} "
        "(id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE)"
    )
    had_fts = _object_exists(conn, "table", VOCAB_FTS)
    conn.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS {VOCAB_FTS} USING fts5(token, tokenize='trigram')"
    )
    conn.execute(
        f"INSERT OR IGNORE INTO {VOCAB}(token) SELECT DISTINCT token FROM image_prompt_tokens"
    )
    words = conn.execute(f"SELECT COUNT(*) FROM {VOCAB}").fetchone()[0]
    indexed = conn.execute(f"SELECT COUNT(*) FROM {VOCAB_FTS}").fetchone()[0]
    if not had_fts or words != indexed:
        conn.execute(f"DELETE FROM {VOCAB_FTS}")
        conn.execute(
            f"INSERT INTO {VOCAB_FTS}(rowid, token) SELECT id, token FROM {VOCAB}"
        )

    conn.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_{VOCAB}_token_insert AFTER INSERT ON image_prompt_tokens
        BEGIN
            INSERT OR IGNORE INTO {VOCAB}(token) VALUES (NEW.token);
        END
        """
    )
    conn.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_{VOCAB}_fts_insert AFTER INSERT ON {VOCAB}
        BEGIN
            INSERT INTO {VOCAB_FTS}(rowid, token) VALUES (NEW.id, NEW.token);
        END
        """
    )


def apply(conn: sqlite3.Connection) -> None:
    if table_exists(conn, "image_loras"):
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_image_loras_lora_lower "
            "ON image_loras(LOWER(lora_name), image_id)"
        )

    needed = ("images", "image_prompt_tokens")
    if not all(table_exists(conn, name) for name in needed):
        return
    if not trigram_supported(conn):
        return
    _create_text_index(conn)
    _create_token_vocab(conn)
