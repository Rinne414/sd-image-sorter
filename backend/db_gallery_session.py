"""Short-lived Gallery membership stored separately from the permanent library."""

from typing import Iterable, List

from db_core import get_db


def clear_gallery_session() -> int:
    """Clear only the current Gallery membership and preserve all library rows."""
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM gallery_session_images")
        return int(cursor.rowcount or 0)


def add_gallery_session_image_ids(image_ids: Iterable[int]) -> int:
    """Add existing image IDs to the current Gallery session."""
    normalized_ids = sorted({int(image_id) for image_id in image_ids if int(image_id) > 0})
    if not normalized_ids:
        return 0
    with get_db() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO gallery_session_images (image_id) VALUES (?)",
            ((image_id,) for image_id in normalized_ids),
        )
        return len(normalized_ids)


def add_gallery_session_paths(paths: Iterable[str]) -> int:
    """Add indexed image rows matching scanned paths to the current session."""
    normalized_paths = sorted({str(path) for path in paths if str(path)})
    if not normalized_paths:
        return 0
    with get_db() as conn:
        placeholders = ",".join("?" for _ in normalized_paths)
        rows = conn.execute(
            f"SELECT id FROM images WHERE path IN ({placeholders})",
            normalized_paths,
        ).fetchall()
        image_ids = [int(row[0]) for row in rows]
        conn.executemany(
            "INSERT OR IGNORE INTO gallery_session_images (image_id) VALUES (?)",
            ((image_id,) for image_id in image_ids),
        )
        return len(image_ids)


def get_gallery_session_image_ids() -> List[int]:
    """Return current-session image IDs in stable insertion order."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT image_id FROM gallery_session_images ORDER BY added_at, image_id"
        ).fetchall()
        return [int(row[0]) for row in rows]
