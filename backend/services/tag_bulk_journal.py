"""Server-side undo journal for bulk tag operations (FE-2s).

Every applied (non-dry-run) bulk op records, per modified image, the FULL
tag rows before the write plus a digest of the tag set after it. Undo
restores the before rows through ``add_tags(replace_scope="all")``; the
digest detects images edited again since the op (skipped unless
``force=True``). The undo run itself is journaled, so undoing an undo is
redo. Undo is one-shot per op: a partially conflicted undo still marks the
op undone — pick ``force`` up front to override conflicts.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import uuid
from typing import Any, Dict, List, Tuple

from db_core import get_db

logger = logging.getLogger(__name__)

# Undo journals hold full before-rows per image. Past this many modified
# images the blob is not stored (the op is still listed, undo unavailable)
# so a 100k-image sweep cannot balloon memory or the DB file. The limit is
# surfaced to clients via ``undo_available`` — never silently.
MAX_JOURNAL_IMAGES = 20_000
# Keep only the most recent N ops (journal blobs are the heavy part).
MAX_RETAINED_OPS = 20


def rows_digest(rows: List[Dict[str, Any]]) -> str:
    """Digest of an image's tag SET (names only, case-folded).

    Confidence/provenance drift does not flag a conflict — only a changed
    tag set means someone edited the image after the journaled op.
    """
    names = sorted({str(r.get("tag") or "").lower() for r in rows if r.get("tag")})
    return hashlib.sha1(json.dumps(names, ensure_ascii=False).encode("utf-8")).hexdigest()


def record_op(
    *,
    operation: str,
    scope_source: str,
    params: Dict[str, Any],
    entries: List[Dict[str, Any]],
) -> Tuple[str, bool]:
    """Persist one journal row. Returns (op_id, truncated)."""
    op_id = uuid.uuid4().hex
    truncated = len(entries) > MAX_JOURNAL_IMAGES
    blob = None
    if not truncated:
        payload = [
            {
                "image_id": int(entry["image_id"]),
                "before": entry.get("before") or [],
                "after_digest": rows_digest(entry.get("after") or []),
            }
            for entry in entries
        ]
        blob = gzip.compress(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    with get_db() as conn:
        conn.execute(
            "INSERT INTO tag_bulk_ops (id, operation, scope_source, params_json, images_affected, journal_gz, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                op_id,
                operation,
                scope_source,
                json.dumps(params, ensure_ascii=False),
                len(entries),
                blob,
                1 if truncated else 0,
            ),
        )
        conn.execute(
            "DELETE FROM tag_bulk_ops WHERE id NOT IN (SELECT id FROM tag_bulk_ops ORDER BY created_at DESC, rowid DESC LIMIT ?)",
            (MAX_RETAINED_OPS,),
        )
    return op_id, truncated


def list_ops(limit: int = MAX_RETAINED_OPS) -> List[Dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, operation, created_at, scope_source, params_json, images_affected, truncated, undone_at FROM tag_bulk_ops ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    ops: List[Dict[str, Any]] = []
    for row in rows:
        try:
            params = json.loads(row[4] or "{}")
        except (TypeError, ValueError):
            params = {}
        ops.append(
            {
                "id": row[0],
                "operation": row[1],
                "created_at": row[2],
                "scope_source": row[3],
                "params": params,
                "images_affected": int(row[5] or 0),
                "undo_available": not bool(row[6]) and row[7] is None,
                "undone_at": row[7],
            }
        )
    return ops


def undo_op(op_id: str, *, force: bool = False) -> Dict[str, Any]:
    """Restore the before-rows of one journaled op.

    Raises KeyError for unknown ids and ValueError when the op was already
    undone or carries no journal (truncated). Conflicted images (tag set
    changed since the op) are skipped and reported unless ``force``.
    """
    import database as db

    with get_db() as conn:
        row = conn.execute(
            "SELECT operation, journal_gz, truncated, undone_at FROM tag_bulk_ops WHERE id = ?",
            (op_id,),
        ).fetchone()
    if not row:
        raise KeyError(op_id)
    operation, blob, truncated, undone_at = row[0], row[1], bool(row[2]), row[3]
    if undone_at is not None:
        raise ValueError("This operation was already undone")
    if truncated or not blob:
        raise ValueError("No undo journal was stored for this operation (too many images)")

    payload = json.loads(gzip.decompress(blob).decode("utf-8"))
    restored = 0
    skipped_conflicts: List[int] = []
    redo_entries: List[Dict[str, Any]] = []
    for entry in payload:
        image_id = int(entry["image_id"])
        before_rows = entry.get("before") or []
        current = db.get_image_tags(image_id)
        if not force and rows_digest(current) != entry.get("after_digest"):
            skipped_conflicts.append(image_id)
            continue
        db.add_tags(image_id, before_rows, replace_scope="all")
        redo_entries.append({"image_id": image_id, "before": current, "after": before_rows})
        restored += 1

    redo_op_id = None
    if redo_entries:
        redo_op_id, _ = record_op(
            operation=f"undo:{operation}",
            scope_source="undo",
            params={"undo_of": op_id, "force": bool(force)},
            entries=redo_entries,
        )
    with get_db() as conn:
        conn.execute(
            "UPDATE tag_bulk_ops SET undone_at = datetime('now'), undo_op_id = ? WHERE id = ?",
            (redo_op_id, op_id),
        )
    return {
        "op_id": op_id,
        "operation": operation,
        "restored": restored,
        "skipped_conflicts": skipped_conflicts,
        "redo_op_id": redo_op_id,
    }
