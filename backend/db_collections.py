"""Collection and favorites read/snapshot operations.

Extracted from ``database.py`` as part of the database module split. This module
holds collection lookups, snapshot item upsert/remove, and favorites helpers.

Imports only from db_core / db_helpers / db_images_write / config / stdlib to
avoid an import cycle with the ``database`` facade.
"""
from datetime import datetime
from typing import Optional, List, Dict, Any

from config import FAVORITES_COLLECTION_SLUG
from db_core import get_db
from db_helpers import _row_to_dict
from db_images_write import _compact_persisted_metadata_json


def get_collection_by_slug(slug: str) -> Optional[Dict[str, Any]]:
    """Get a collection by slug."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM collections WHERE slug = ?", (slug,))
        row = cursor.fetchone()
        return _row_to_dict(row) if row else None


def get_collection_item(collection_id: int, source_image_id: int) -> Optional[Dict[str, Any]]:
    """Get a collection item by collection and source image IDs."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM collection_items WHERE collection_id = ? AND source_image_id = ?",
            (collection_id, source_image_id)
        )
        row = cursor.fetchone()
        return _row_to_dict(row) if row else None


def add_collection_item(
    collection_id: int,
    source_image_id: int,
    copied_path: str,
    prompt: Optional[str],
    negative_prompt: Optional[str],
    checkpoint: Optional[str],
    loras: Optional[str],
    metadata_json: Optional[str],
    created_at: Optional[datetime],
    width: Optional[int],
    height: Optional[int],
    file_size: Optional[int],
) -> int:
    """Insert or replace a collection snapshot item."""
    metadata_json = _compact_persisted_metadata_json(metadata_json)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO collection_items (
                collection_id, source_image_id, copied_path, prompt, negative_prompt,
                checkpoint, loras, metadata_json, created_at, width, height, file_size
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(collection_id, source_image_id) DO UPDATE SET
                copied_path = excluded.copied_path,
                prompt = excluded.prompt,
                negative_prompt = excluded.negative_prompt,
                checkpoint = excluded.checkpoint,
                loras = excluded.loras,
                metadata_json = excluded.metadata_json,
                created_at = excluded.created_at,
                width = excluded.width,
                height = excluded.height,
                file_size = excluded.file_size,
                added_at = CURRENT_TIMESTAMP
            """,
            (
                collection_id,
                source_image_id,
                copied_path,
                prompt,
                negative_prompt,
                checkpoint,
                loras,
                metadata_json,
                created_at,
                width,
                height,
                file_size,
            )
        )
        return cursor.lastrowid


def remove_collection_item(collection_id: int, source_image_id: int):
    """Remove a collection item without deleting the copied file."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM collection_items WHERE collection_id = ? AND source_image_id = ?",
            (collection_id, source_image_id)
        )


def get_favorite_source_ids() -> List[int]:
    """Current image ids whose file path is favorited (newest-favorited first).

    Favorites are anchored by PATH in ``favorite_paths`` (not by the volatile
    image row id), so a library Clear/rescan that re-IDs images keeps them: a
    re-scanned file with the same path resolves back to a favorite automatically.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT i.id
            FROM images i
            INNER JOIN favorite_paths f ON lower(i.path) = f.path_key
            ORDER BY f.added_at DESC, i.id DESC
            """
        )
        return [row[0] for row in cursor.fetchall()]


def get_favorites_count() -> int:
    """Count of favorited paths that resolve to a currently-indexed image."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM images i
            INNER JOIN favorite_paths f ON lower(i.path) = f.path_key
            """
        )
        return cursor.fetchone()[0]


# ---------------------------------------------------------------------------
# v3.3.0 FEAT-COLLECTIONS: lightweight "favorite" (heart) toggle.
#
# Favorites use the existing collection_items table as a *reference* (the
# copied_path points at the source image's own path) instead of physically
# copying the file. This keeps the heart toggle instant and reversible with no
# schema migration. The richer "copy into a collection folder" snapshot path
# (add_collection_item with a real copied_path) still exists for callers that
# want physical copies.
# ---------------------------------------------------------------------------
def get_favorites_collection_id() -> Optional[int]:
    """Return the seeded Favorites collection id (or None if missing)."""
    collection = get_collection_by_slug(FAVORITES_COLLECTION_SLUG)
    return int(collection["id"]) if collection else None


def is_favorited(source_image_id: int) -> bool:
    """True when the image's file path is favorited (path-anchored)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT 1
            FROM images i
            INNER JOIN favorite_paths f ON lower(i.path) = f.path_key
            WHERE i.id = ?
            """,
            (source_image_id,),
        )
        return cursor.fetchone() is not None


def set_favorite(source_image_id: int, favorited: bool) -> bool:
    """Toggle Favorites for a source image, anchored by file PATH.

    Storing the favorite by path (in ``favorite_paths``) instead of the image
    row id means it survives a library Clear/rescan that re-IDs images. Returns
    the resulting favorited state. Raises ValueError if the image row does not
    exist (the caller maps that to a 404).
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT path FROM images WHERE id = ?", (source_image_id,))
        row = cursor.fetchone()
        if row is None:
            raise ValueError(f"Image {source_image_id} not found")
        path_key = (row[0] or "").lower()
        if favorited:
            cursor.execute(
                "INSERT OR IGNORE INTO favorite_paths (path_key) VALUES (?)", (path_key,)
            )
        else:
            cursor.execute("DELETE FROM favorite_paths WHERE path_key = ?", (path_key,))

    if not favorited:
        # Clean up any pre-migration collection_items favorite row (now vestigial,
        # since reads go through favorite_paths). Best-effort.
        fav_id = get_favorites_collection_id()
        if fav_id is not None:
            remove_collection_item(fav_id, source_image_id)
    return favorited


# ---------------------------------------------------------------------------
# v3.3.0 FEAT-COLLECTIONS: user-managed collections (list / create / rename /
# delete) plus reference-style membership and an image listing for the UI.
# ---------------------------------------------------------------------------
import re as _re


def _slugify_collection_name(name: str) -> str:
    """Derive a URL-safe slug from a display name."""
    base = _re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    return base or "collection"


def list_collections() -> List[Dict[str, Any]]:
    """List all collections with their item counts, newest first."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT c.id, c.slug, c.name, c.folder_path, c.created_at,
                   COUNT(ci.id) AS item_count
            FROM collections c
            LEFT JOIN collection_items ci ON ci.collection_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC, c.id DESC
            """
        )
        collections = [_row_to_dict(row) for row in cursor.fetchall()]
    # Favorites is path-anchored (not a collection_items snapshot), so report its
    # live, rescan-proof count instead of the stale collection_items count.
    fav_count = get_favorites_count()
    for collection in collections:
        if collection.get("slug") == FAVORITES_COLLECTION_SLUG:
            collection["item_count"] = fav_count
    return collections


def create_collection(name: str, folder_path: Optional[str] = None) -> Dict[str, Any]:
    """Create a new collection with a unique slug. Returns the created row."""
    clean_name = (name or "").strip()
    if not clean_name:
        raise ValueError("Collection name is required")

    base_slug = _slugify_collection_name(clean_name)
    with get_db() as conn:
        cursor = conn.cursor()
        # Ensure slug uniqueness by suffixing -2, -3, ... on collision.
        slug = base_slug
        suffix = 2
        while True:
            cursor.execute("SELECT 1 FROM collections WHERE slug = ?", (slug,))
            if cursor.fetchone() is None:
                break
            slug = f"{base_slug}-{suffix}"
            suffix += 1
        cursor.execute(
            "INSERT INTO collections (slug, name, folder_path) VALUES (?, ?, ?)",
            (slug, clean_name, folder_path or ""),
        )
        new_id = cursor.lastrowid
        cursor.execute("SELECT * FROM collections WHERE id = ?", (new_id,))
        return _row_to_dict(cursor.fetchone())


def rename_collection(collection_id: int, name: str) -> bool:
    """Rename a collection (the slug is left stable to keep references valid)."""
    clean_name = (name or "").strip()
    if not clean_name:
        raise ValueError("Collection name is required")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE collections SET name = ? WHERE id = ?",
            (clean_name, collection_id),
        )
        return cursor.rowcount > 0


def delete_collection(collection_id: int) -> bool:
    """Delete a collection and its items (the Favorites collection is protected)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT slug FROM collections WHERE id = ?", (collection_id,))
        row = cursor.fetchone()
        if row is None:
            return False
        if _row_to_dict(row).get("slug") == FAVORITES_COLLECTION_SLUG:
            raise ValueError("The Favorites collection cannot be deleted")
        cursor.execute("DELETE FROM collection_items WHERE collection_id = ?", (collection_id,))
        cursor.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
        return cursor.rowcount > 0


def collection_exists(collection_id: int) -> bool:
    """True when a collection with this id exists."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM collections WHERE id = ?", (collection_id,))
        return cursor.fetchone() is not None


def set_collection_membership(collection_id: int, source_image_id: int, member: bool) -> bool:
    """Add/remove a source image to/from a collection as a reference (no copy).

    Returns the resulting membership state. Raises ValueError on a missing
    collection or image row (the caller maps that to a 404).
    """
    if not collection_exists(collection_id):
        raise ValueError(f"Collection {collection_id} not found")

    if not member:
        remove_collection_item(collection_id, source_image_id)
        return False

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT path, prompt, negative_prompt, checkpoint, loras, metadata_json, "
            "created_at, width, height, file_size FROM images WHERE id = ?",
            (source_image_id,),
        )
        row = cursor.fetchone()
    if row is None:
        raise ValueError(f"Image {source_image_id} not found")

    image = _row_to_dict(row)
    add_collection_item(
        collection_id=collection_id,
        source_image_id=source_image_id,
        copied_path=image.get("path") or "",
        prompt=image.get("prompt"),
        negative_prompt=image.get("negative_prompt"),
        checkpoint=image.get("checkpoint"),
        loras=image.get("loras"),
        metadata_json=image.get("metadata_json"),
        created_at=image.get("created_at"),
        width=image.get("width"),
        height=image.get("height"),
        file_size=image.get("file_size"),
    )
    return True


# Stays under SQLite's 999 bound-variable cap (chunk + a couple extra params).
_BULK_MEMBERSHIP_CHUNK_SIZE = 500


def set_collection_membership_bulk(
    collection_id: int, source_image_ids: List[int], member: bool
) -> int:
    """Add/remove many source images to/from a collection in one transaction.

    Returns the number of memberships actually written (upserted rows for
    member=True, deleted rows for member=False). Image ids that no longer
    exist are silently skipped. Raises ValueError on a missing collection
    (the caller maps that to a 404).
    """
    if not collection_exists(collection_id):
        raise ValueError(f"Collection {collection_id} not found")

    # Dedupe (order-preserving) so duplicate ids can't double-count.
    ids = list(dict.fromkeys(int(image_id) for image_id in source_image_ids))
    if not ids:
        return 0

    fav_id = get_favorites_collection_id()
    if fav_id is not None and int(collection_id) == int(fav_id):
        # Favorites is path-anchored (favorite_paths), not a collection_items
        # snapshot — route through the same storage set_favorite uses so the
        # heart hydration / count / rescan-proofing keep working.
        return _set_favorites_membership_bulk(ids, fav_id, member)

    changed = 0
    with get_db() as conn:
        cursor = conn.cursor()
        for start in range(0, len(ids), _BULK_MEMBERSHIP_CHUNK_SIZE):
            chunk = ids[start:start + _BULK_MEMBERSHIP_CHUNK_SIZE]
            placeholders = ",".join("?" * len(chunk))
            if not member:
                cursor.execute(
                    f"DELETE FROM collection_items WHERE collection_id = ? "
                    f"AND source_image_id IN ({placeholders})",
                    [collection_id, *chunk],
                )
                changed += cursor.rowcount
                continue
            cursor.execute(
                "SELECT id, path, prompt, negative_prompt, checkpoint, loras, "
                "metadata_json, created_at, width, height, file_size "
                f"FROM images WHERE id IN ({placeholders})",
                chunk,
            )
            images = [_row_to_dict(row) for row in cursor.fetchall()]
            if not images:
                continue
            cursor.executemany(
                """
                INSERT INTO collection_items (
                    collection_id, source_image_id, copied_path, prompt, negative_prompt,
                    checkpoint, loras, metadata_json, created_at, width, height, file_size
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(collection_id, source_image_id) DO UPDATE SET
                    copied_path = excluded.copied_path,
                    prompt = excluded.prompt,
                    negative_prompt = excluded.negative_prompt,
                    checkpoint = excluded.checkpoint,
                    loras = excluded.loras,
                    metadata_json = excluded.metadata_json,
                    created_at = excluded.created_at,
                    width = excluded.width,
                    height = excluded.height,
                    file_size = excluded.file_size,
                    added_at = CURRENT_TIMESTAMP
                """,
                [
                    (
                        collection_id,
                        image.get("id"),
                        image.get("path") or "",
                        image.get("prompt"),
                        image.get("negative_prompt"),
                        image.get("checkpoint"),
                        image.get("loras"),
                        _compact_persisted_metadata_json(image.get("metadata_json")),
                        image.get("created_at"),
                        image.get("width"),
                        image.get("height"),
                        image.get("file_size"),
                    )
                    for image in images
                ],
            )
            changed += len(images)
    return changed


def _set_favorites_membership_bulk(ids: List[int], fav_id: int, member: bool) -> int:
    """Bulk Favorites toggle, path-anchored like set_favorite (rescan-proof)."""
    changed = 0
    with get_db() as conn:
        cursor = conn.cursor()
        for start in range(0, len(ids), _BULK_MEMBERSHIP_CHUNK_SIZE):
            chunk = ids[start:start + _BULK_MEMBERSHIP_CHUNK_SIZE]
            placeholders = ",".join("?" * len(chunk))
            cursor.execute(
                f"SELECT path FROM images WHERE id IN ({placeholders})", chunk
            )
            path_keys = [(row[0] or "").lower() for row in cursor.fetchall()]
            if member:
                if path_keys:
                    cursor.executemany(
                        "INSERT OR IGNORE INTO favorite_paths (path_key) VALUES (?)",
                        [(key,) for key in path_keys],
                    )
                    changed += len(path_keys)
                continue
            if path_keys:
                key_placeholders = ",".join("?" * len(path_keys))
                cursor.execute(
                    f"DELETE FROM favorite_paths WHERE path_key IN ({key_placeholders})",
                    path_keys,
                )
                changed += cursor.rowcount
            # Clean up vestigial pre-migration collection_items favorite rows
            # (reads go through favorite_paths) — mirrors set_favorite.
            cursor.execute(
                f"DELETE FROM collection_items WHERE collection_id = ? "
                f"AND source_image_id IN ({placeholders})",
                [fav_id, *chunk],
            )
    return changed


def get_collection_image_ids(collection_id: int) -> List[int]:
    """Return the source image ids in a collection (newest-added first)."""
    # Favorites is path-anchored (rescan-proof), resolved live from favorite_paths
    # rather than the cascade-deletable collection_items snapshot.
    fav_id = get_favorites_collection_id()
    if fav_id is not None and collection_id == fav_id:
        return get_favorite_source_ids()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT ci.source_image_id
            FROM collection_items ci
            INNER JOIN images i ON i.id = ci.source_image_id
            WHERE ci.collection_id = ?
            ORDER BY ci.added_at DESC, ci.id DESC
            """,
            (collection_id,),
        )
        return [row[0] for row in cursor.fetchall()]

