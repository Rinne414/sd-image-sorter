"""Migration 036: require complete evidence in existing writer rows."""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 36
NAME = "strict_tag_writer_provenance"

_TABLE_NAME = "tag_writer_provenance"
_STAGING_TABLE_NAME = "tag_writer_provenance_v36"
_INDEX_NAME = "idx_tag_writer_provenance_provider_model"
_LEGACY_COLUMN_CONTRACT = {
    "image_id": ("INTEGER", 1, None, 1),
    "writer_family": ("TEXT", 1, None, 2),
    "provider": ("TEXT", 1, None, 0),
    "model": ("TEXT", 1, None, 0),
    "revision": ("TEXT", 0, None, 0),
    "runtime_provider": ("TEXT", 1, None, 0),
    "content_fingerprint": ("TEXT", 0, None, 0),
    "created_at": ("DATETIME", 1, "CURRENT_TIMESTAMP", 0),
}
_STRICT_COLUMN_CONTRACT = {
    **_LEGACY_COLUMN_CONTRACT,
    "revision": ("TEXT", 1, None, 0),
    "content_fingerprint": ("TEXT", 1, None, 0),
}


def _index_exists(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        (_INDEX_NAME,),
    ).fetchone()
    return row is not None


def _column_contract(
    conn: sqlite3.Connection,
) -> dict[str, tuple[str, int, str | None, int]]:
    return {
        str(row[1]): (
            str(row[2]).upper(),
            int(row[3]),
            None if row[4] is None else str(row[4]),
            int(row[5]),
        )
        for row in conn.execute(f"PRAGMA table_info({_TABLE_NAME})")
    }


def _has_strict_contract(conn: sqlite3.Connection) -> bool:
    return _column_contract(conn) == _STRICT_COLUMN_CONTRACT


def _has_expected_relations(conn: sqlite3.Connection) -> bool:
    foreign_keys = conn.execute(
        f"PRAGMA foreign_key_list({_TABLE_NAME})"
    ).fetchall()
    index_columns = tuple(
        str(row[2])
        for row in conn.execute(
            f"PRAGMA index_info({_INDEX_NAME})"
        ).fetchall()
    )
    return (
        len(foreign_keys) == 1
        and str(foreign_keys[0][2]) == "images"
        and str(foreign_keys[0][3]) == "image_id"
        and str(foreign_keys[0][4]) == "id"
        and str(foreign_keys[0][6]).upper() == "CASCADE"
        and index_columns == ("writer_family", "provider", "model")
    )


def apply(conn: sqlite3.Connection) -> bool:
    """Upgrade the development-era nullable writer table without dropping rows."""

    if not table_exists(conn, _TABLE_NAME):
        raise RuntimeError(
            "Cannot tighten tag writer provenance: source table is missing"
        )
    if table_exists(conn, _STAGING_TABLE_NAME):
        raise RuntimeError(
            "Cannot tighten tag writer provenance: staging table is already present"
        )
    if not _index_exists(conn):
        raise RuntimeError(
            "Cannot tighten tag writer provenance: provider/model index is missing"
        )
    columns = _column_contract(conn)
    if (
        columns != _LEGACY_COLUMN_CONTRACT
        and columns != _STRICT_COLUMN_CONTRACT
    ):
        raise RuntimeError(
            "Cannot tighten tag writer provenance: source schema is malformed"
        )
    if not _has_expected_relations(conn):
        raise RuntimeError(
            "Cannot tighten tag writer provenance: source relations are malformed"
        )
    if _has_strict_contract(conn):
        return False

    invalid_count = int(
        conn.execute(
            """
            SELECT COUNT(*)
            FROM tag_writer_provenance
            WHERE revision IS NULL OR content_fingerprint IS NULL
            """
        ).fetchone()[0]
    )
    if invalid_count:
        raise RuntimeError(
            "Cannot tighten tag writer provenance: "
            f"{invalid_count} existing row(s) have incomplete evidence"
        )

    conn.execute(
        f"""
        CREATE TABLE {_STAGING_TABLE_NAME} (
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
        INSERT INTO {_STAGING_TABLE_NAME} (
            image_id, writer_family, provider, model, revision,
            runtime_provider, content_fingerprint, created_at
        )
        SELECT image_id, writer_family, provider, model, revision,
               runtime_provider, content_fingerprint, created_at
        FROM {_TABLE_NAME}
        """
    )
    conn.execute(f"DROP INDEX {_INDEX_NAME}")
    conn.execute(f"DROP TABLE {_TABLE_NAME}")
    conn.execute(
        f"ALTER TABLE {_STAGING_TABLE_NAME} RENAME TO {_TABLE_NAME}"
    )
    conn.execute(
        f"""
        CREATE INDEX {_INDEX_NAME}
        ON {_TABLE_NAME}(writer_family, provider, model)
        """
    )
    return True
