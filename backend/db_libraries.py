"""CRUD for long-lived libraries (workspaces)."""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Optional

from db_core import get_db
from library_context import MAIN_LIBRARY_ID, get_current_library_id, normalize_library_id


_NAME_RE = re.compile(r"\s+")


def _display_name(name: str) -> str:
    cleaned = _NAME_RE.sub(" ", str(name or "").strip())
    return cleaned[:80] or "Library"


def ensure_default_library(conn=None) -> None:
    def _run(c):
        c.execute(
            """
            INSERT OR IGNORE INTO libraries (id, name, is_default)
            VALUES (?, 'Main library', 1)
            """,
            (MAIN_LIBRARY_ID,),
        )

    if conn is not None:
        _run(conn)
        return
    with get_db() as c:
        _run(c)


def list_libraries() -> List[Dict[str, Any]]:
    ensure_default_library()
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT l.id, l.name, l.created_at, l.is_default,
                   (SELECT COUNT(*) FROM images i
                    WHERE COALESCE(i.library_id, 'main') = l.id) AS image_count
            FROM libraries l
            ORDER BY l.is_default DESC, l.created_at ASC, l.id ASC
            """
        ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "name": str(row["name"]),
            "created_at": str(row["created_at"] or ""),
            "is_default": bool(row["is_default"]),
            "image_count": int(row["image_count"] or 0),
        }
        for row in rows
    ]


def get_library(library_id: str) -> Optional[Dict[str, Any]]:
    lid = normalize_library_id(library_id)
    ensure_default_library()
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT l.id, l.name, l.created_at, l.is_default,
                   (SELECT COUNT(*) FROM images i
                    WHERE COALESCE(i.library_id, 'main') = l.id) AS image_count
            FROM libraries l
            WHERE l.id = ?
            """,
            (lid,),
        ).fetchone()
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "name": str(row["name"]),
        "created_at": str(row["created_at"] or ""),
        "is_default": bool(row["is_default"]),
        "image_count": int(row["image_count"] or 0),
    }


def library_exists(library_id: str) -> bool:
    return get_library(library_id) is not None


def resolve_active_library_id(requested: Optional[str] = None) -> str:
    """Return a library id that exists; fall back to main."""
    ensure_default_library()
    lid = normalize_library_id(requested or get_current_library_id())
    if library_exists(lid):
        return lid
    return MAIN_LIBRARY_ID


def create_library(name: str) -> Dict[str, Any]:
    ensure_default_library()
    display = _display_name(name)
    new_id = normalize_library_id(f"lib_{uuid.uuid4().hex[:12]}")
    with get_db() as conn:
        conn.execute(
            "INSERT INTO libraries (id, name, is_default) VALUES (?, ?, 0)",
            (new_id, display),
        )
    lib = get_library(new_id)
    assert lib is not None
    return lib


def rename_library(library_id: str, name: str) -> Dict[str, Any]:
    lid = normalize_library_id(library_id)
    if not library_exists(lid):
        raise KeyError(lid)
    display = _display_name(name)
    with get_db() as conn:
        conn.execute("UPDATE libraries SET name = ? WHERE id = ?", (display, lid))
    lib = get_library(lid)
    assert lib is not None
    return lib


def clear_library_images(library_id: Optional[str] = None) -> int:
    """Delete all image rows for one library. Cascades tags via FK."""
    lid = resolve_active_library_id(library_id)
    paths: List[str] = []
    with get_db() as conn:
        try:
            path_rows = conn.execute(
                "SELECT path FROM images WHERE COALESCE(library_id, 'main') = ?",
                (lid,),
            ).fetchall()
            paths = [str(r["path"]) for r in path_rows if r and r["path"]]
        except Exception:
            paths = []
        cursor = conn.execute(
            "DELETE FROM images WHERE COALESCE(library_id, 'main') = ?",
            (lid,),
        )
        removed = int(cursor.rowcount or 0)
    if removed:
        try:
            from db_tags import _invalidate_tags_cache  # type: ignore

            _invalidate_tags_cache()
        except Exception:
            pass
        try:
            from db_facets import _invalidate_facet_caches  # type: ignore

            _invalidate_facet_caches()
        except Exception:
            pass
        # Best-effort: free thumbnail cache for removed library paths.
        try:
            from thumbnail_cache import delete_thumbnails_for_paths

            delete_thumbnails_for_paths(paths)
        except Exception:
            pass
        # Reclaim SQLite pages after large clears (non-blocking best-effort).
        if removed >= 50:
            try:
                with get_db() as conn:
                    conn.execute("PRAGMA incremental_vacuum(64)")
            except Exception:
                pass
    return removed


def delete_library(library_id: str) -> Dict[str, Any]:
    """Delete a non-default library and its images. Main library cannot be deleted."""
    lid = normalize_library_id(library_id)
    if lid == MAIN_LIBRARY_ID:
        raise PermissionError("default_library_protected")
    lib = get_library(lid)
    if lib is None:
        raise KeyError(lid)
    removed = clear_library_images(lid)
    with get_db() as conn:
        # Drop roots owned by this workspace (images already cleared).
        try:
            conn.execute(
                "DELETE FROM library_roots WHERE COALESCE(library_id, 'main') = ?",
                (lid,),
            )
        except Exception:
            pass
        conn.execute("DELETE FROM libraries WHERE id = ?", (lid,))
    return {"id": lid, "removed_images": removed, "name": lib["name"]}


def move_images_to_library(
    image_ids: List[int],
    target_library_id: str,
) -> Dict[str, Any]:
    """Reassign existing image rows to another long-lived library.

    Path uniqueness is preserved (ownership moves; no duplicate rows).
    """
    target = resolve_active_library_id(target_library_id)
    ids = sorted({int(i) for i in image_ids if int(i) > 0})
    if not ids:
        return {"moved": 0, "target_library_id": target, "image_ids": []}
    placeholders = ",".join("?" for _ in ids)
    with get_db() as conn:
        cursor = conn.execute(
            f"""
            UPDATE images
            SET library_id = ?
            WHERE id IN ({placeholders})
              AND COALESCE(library_id, 'main') != ?
            """,
            (target, *ids, target),
        )
        moved = int(cursor.rowcount or 0)
    if moved:
        try:
            from db_tags import _invalidate_tags_cache  # type: ignore

            _invalidate_tags_cache()
        except Exception:
            pass
        try:
            from db_facets import _invalidate_facet_caches  # type: ignore

            _invalidate_facet_caches()
        except Exception:
            pass
    return {"moved": moved, "target_library_id": target, "image_ids": ids}


def claim_paths_to_library(
    paths: List[str],
    target_library_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Move ownership of indexed paths into ``target_library_id`` (current by default).

    Used after a scan reports ``skipped_other_library`` for paths already indexed
    under a different workspace.
    """
    from db_helpers import _normalize_indexed_image_path

    target = resolve_active_library_id(target_library_id)
    normalized = []
    seen = set()
    for raw in paths or []:
        path = _normalize_indexed_image_path(str(raw or ""))
        if not path or path in seen:
            continue
        seen.add(path)
        normalized.append(path)
    if not normalized:
        return {"moved": 0, "target_library_id": target, "paths": []}

    moved = 0
    chunk = 80
    with get_db() as conn:
        for start in range(0, len(normalized), chunk):
            batch = normalized[start : start + chunk]
            placeholders = ",".join("?" for _ in batch)
            cursor = conn.execute(
                f"""
                UPDATE images
                SET library_id = ?
                WHERE path IN ({placeholders})
                  AND COALESCE(library_id, 'main') != ?
                """,
                (target, *batch, target),
            )
            moved += int(cursor.rowcount or 0)
    if moved:
        try:
            from db_tags import _invalidate_tags_cache  # type: ignore

            _invalidate_tags_cache()
        except Exception:
            pass
        try:
            from db_facets import _invalidate_facet_caches  # type: ignore

            _invalidate_facet_caches()
        except Exception:
            pass
    return {"moved": moved, "target_library_id": target, "paths": normalized}


def export_library_index(library_id: Optional[str] = None) -> Dict[str, Any]:
    """Export a portable JSON index for one library (paths + light metadata)."""
    from datetime import datetime, timezone

    lid = resolve_active_library_id(library_id)
    lib = get_library(lid)
    if lib is None:
        raise KeyError(lid)

    roots: List[Dict[str, Any]] = []
    try:
        from db_library_roots import list_library_roots

        for root in list_library_roots(lid):
            roots.append({
                "path": root.get("path"),
                "label": root.get("label"),
                "enabled": bool(root.get("enabled")),
                "last_scanned_at": root.get("last_scanned_at"),
            })
    except Exception:
        roots = []

    images: List[Dict[str, Any]] = []
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, path, filename, generator, width, height, file_size,
                   checkpoint, prompt, negative_prompt, created_at, indexed_at
            FROM images
            WHERE COALESCE(library_id, 'main') = ?
            ORDER BY id ASC
            """,
            (lid,),
        ).fetchall()
        for row in rows:
            images.append({
                "id": int(row["id"]),
                "path": str(row["path"] or ""),
                "filename": str(row["filename"] or ""),
                "generator": str(row["generator"] or "unknown"),
                "width": row["width"],
                "height": row["height"],
                "file_size": row["file_size"],
                "checkpoint": row["checkpoint"],
                "prompt": row["prompt"],
                "negative_prompt": row["negative_prompt"],
                "created_at": row["created_at"],
                "indexed_at": row["indexed_at"],
            })

    return {
        "format": "sd-image-sorter-library-export-v1",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "library": {
            "id": lib["id"],
            "name": lib["name"],
            "is_default": bool(lib.get("is_default")),
        },
        "image_count": len(images),
        "roots": roots,
        "images": images,
        "notes": (
            "Index-only export. Image files on disk are not copied. "
            "Use paths to locate originals or re-scan roots into this or another install."
        ),
    }
