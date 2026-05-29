"""
Schema versioning and database initialization.

Owns the ``schema_version`` ledger helpers, stale-pending recovery, the
post-migration VACUUM, and :func:`init_db`, which runs the migration list from
:mod:`migrations`. Depends only on :mod:`db_core` for the shared connection
factory and schema constants; it must not import from ``database``.
"""
import sqlite3
import logging

from db_core import (
    get_connection,
    SCHEMA_VERSION_ROW_ID,
    STALE_PENDING_METADATA_READ_ERROR,
)


logger = logging.getLogger(__name__)


def _ensure_schema_version_table(conn: sqlite3.Connection) -> None:
    """Create the schema-version ledger when it does not exist yet."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (id, version) VALUES (?, 0)",
        (SCHEMA_VERSION_ROW_ID,),
    )


def _get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT version FROM schema_version WHERE id = ?",
        (SCHEMA_VERSION_ROW_ID,),
    ).fetchone()
    if not row:
        return 0
    return int(row[0] or 0)


def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute(
        "UPDATE schema_version SET version = ? WHERE id = ?",
        (int(version), SCHEMA_VERSION_ROW_ID),
    )


def _run_post_migration_vacuum(conn: sqlite3.Connection) -> None:
    try:
        conn.execute("VACUUM")
    except sqlite3.Error as exc:
        logger.warning(
            "Database metadata compaction succeeded, but VACUUM failed; "
            "images.db may not shrink until a later cleanup run: %s",
            exc,
        )


def _recover_stale_pending_metadata_rows(conn: sqlite3.Connection) -> int:
    """
    Quarantine placeholder scan rows that survived a previous process crash.

    Pending rows are safe while a scan is running, but once the app starts again
    there is no in-flight worker left that can finish them. Mark them as
    recoverable `error` rows so they stop bypassing invalidation logic and can
    be repaired truthfully by the next re-scan.
    """
    row = conn.execute(
        """
        SELECT COUNT(*)
        FROM images
        WHERE LOWER(COALESCE(metadata_status, '')) = 'pending'
        """
    ).fetchone()
    pending_count = int(row[0] or 0) if row else 0
    if pending_count <= 0:
        return 0

    conn.execute(
        """
        UPDATE images
        SET is_readable = 0,
            read_error = CASE
                WHEN TRIM(COALESCE(read_error, '')) = '' THEN ?
                ELSE read_error
            END,
            metadata_status = 'error',
            indexed_at = CURRENT_TIMESTAMP
        WHERE LOWER(COALESCE(metadata_status, '')) = 'pending'
        """,
        (STALE_PENDING_METADATA_READ_ERROR,),
    )
    return pending_count


def init_db() -> None:
    """Initialize or migrate the database schema to the latest known version."""
    from migrations import get_migrations

    conn = get_connection()
    vacuum_after_commit = False
    try:
        _ensure_schema_version_table(conn)
        current_version = _get_schema_version(conn)

        for migration in get_migrations():
            if migration.version <= current_version:
                continue
            savepoint_name = f"migration_{migration.version}"
            conn.execute(f"SAVEPOINT {savepoint_name}")
            try:
                result = migration.apply(conn)
                if bool(result):
                    vacuum_after_commit = True
                _set_schema_version(conn, migration.version)
                conn.execute(f"RELEASE SAVEPOINT {savepoint_name}")
            except Exception:
                conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint_name}")
                conn.execute(f"RELEASE SAVEPOINT {savepoint_name}")
                raise
            current_version = migration.version

        _recover_stale_pending_metadata_rows(conn)

        conn.commit()
        if vacuum_after_commit:
            _run_post_migration_vacuum(conn)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
