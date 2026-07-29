"""Migration 035: persist strict provider/model identity for the WD14 writer."""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 35
NAME = "tag_writer_provenance"
_INDEX_NAME = "idx_tag_writer_provenance_provider_model"
_EXPECTED_COLUMN_CONTRACT = {
    "image_id": ("INTEGER", 1, None, 1),
    "writer_family": ("TEXT", 1, None, 2),
    "provider": ("TEXT", 1, None, 0),
    "model": ("TEXT", 1, None, 0),
    "revision": ("TEXT", 1, None, 0),
    "runtime_provider": ("TEXT", 1, None, 0),
    "content_fingerprint": ("TEXT", 1, None, 0),
    "created_at": ("DATETIME", 1, "CURRENT_TIMESTAMP", 0),
}


def _index_exists(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        (_INDEX_NAME,),
    ).fetchone()
    return row is not None


def _has_complete_table_contract(conn: sqlite3.Connection) -> bool:
    columns = {
        str(row[1]): (
            str(row[2]).upper(),
            int(row[3]),
            None if row[4] is None else str(row[4]),
            int(row[5]),
        )
        for row in conn.execute("PRAGMA table_info(tag_writer_provenance)")
    }
    foreign_keys = conn.execute(
        "PRAGMA foreign_key_list(tag_writer_provenance)"
    ).fetchall()
    index_columns = tuple(
        str(row[2])
        for row in conn.execute(
            f"PRAGMA index_info({_INDEX_NAME})"
        ).fetchall()
    )
    return (
        columns == _EXPECTED_COLUMN_CONTRACT
        and len(foreign_keys) == 1
        and str(foreign_keys[0][2]) == "images"
        and str(foreign_keys[0][3]) == "image_id"
        and str(foreign_keys[0][4]) == "id"
        and str(foreign_keys[0][6]).upper() == "CASCADE"
        and index_columns == ("writer_family", "provider", "model")
    )


def apply(conn: sqlite3.Connection) -> bool:
    table_present = table_exists(conn, "tag_writer_provenance")
    index_present = _index_exists(conn)
    if table_present and index_present and _has_complete_table_contract(conn):
        return False
    if table_present or index_present:
        raise RuntimeError(
            "Cannot migrate tag writer provenance: writer schema is partially present"
        )
    if not table_exists(conn, "images"):
        raise RuntimeError(
            "Cannot migrate tag writer provenance: images table is missing"
        )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tag_writer_provenance (
            image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
            writer_family TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            revision TEXT NOT NULL,
            runtime_provider TEXT NOT NULL,
            content_fingerprint TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (image_id, writer_family)
        )
        """
    )
    conn.execute(
        f"""
        CREATE INDEX {_INDEX_NAME}
        ON tag_writer_provenance(writer_family, provider, model)
        """
    )
    return True
