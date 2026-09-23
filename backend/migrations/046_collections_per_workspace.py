"""Pin collections to long-lived library workspaces."""

from __future__ import annotations

from migrations._schema_common import table_exists

VERSION = 46
NAME = "collections_per_workspace"
MAIN_LIBRARY_ID = "main"


def apply(conn) -> bool:
    if not table_exists(conn, "collections"):
        return False

    cols = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(collections)").fetchall()
    }
    if "library_id" in cols:
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_collections_library_slug
            ON collections(library_id, slug)
            """
        )
        return False

    # The runner applies each migration inside a SAVEPOINT on a connection
    # with foreign_keys=ON, where PRAGMA foreign_keys=OFF is a no-op. DROP TABLE
    # collections therefore runs an implicit DELETE that cascades into
    # collection_items. Park the items first and put them back afterwards.
    has_items = table_exists(conn, "collection_items")
    if has_items:
        conn.execute(
            "CREATE TEMP TABLE collection_items_v46_backup AS "
            "SELECT * FROM collection_items"
        )

    conn.execute(
        """
        CREATE TABLE collections_v46 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            library_id TEXT NOT NULL DEFAULT 'main',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(library_id, slug)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO collections_v46 (id, slug, name, folder_path, library_id, created_at)
        SELECT id, slug, name, folder_path, ?, created_at
        FROM collections
        """,
        (MAIN_LIBRARY_ID,),
    )
    conn.execute("DROP TABLE collections")
    conn.execute("ALTER TABLE collections_v46 RENAME TO collections")

    if has_items:
        # With foreign keys on, DROP TABLE already cascaded the items away; with
        # them off (a plain sqlite3 connection) the old rows are still there.
        # Clear either way so the restore below cannot collide on item ids.
        conn.execute("DELETE FROM collection_items")
        # Rows are restored verbatim (same ids). Only an item whose image row
        # is already gone is left out: it would fail the images foreign key.
        conn.execute(
            """
            INSERT INTO collection_items
            SELECT b.* FROM temp.collection_items_v46_backup b
            WHERE EXISTS (SELECT 1 FROM images i WHERE i.id = b.source_image_id)
            """
        )
        conn.execute("DROP TABLE temp.collection_items_v46_backup")

    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_collections_library_slug
        ON collections(library_id, slug)
        """
    )
    # A small table rebuild: no need to VACUUM the whole library database.
    return False
