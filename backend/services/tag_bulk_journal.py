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
import io
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Mapping, Optional, Sequence, TypedDict

from db_core import get_db

logger = logging.getLogger(__name__)

# Undo journals hold full before-rows per image. Past this many modified
# images the blob is not stored (the op is still listed, undo unavailable)
# so a 100k-image sweep cannot balloon memory or the DB file. The limit is
# surfaced to clients via ``undo_available`` — never silently.
MAX_JOURNAL_IMAGES = 20_000
# The retained JSON representation is the dominant controllable heap cost.
# Keep it bounded independently of image count so tag-heavy libraries cannot
# recreate the former hundreds-of-megabytes journal peak.
MAX_JOURNAL_SERIALIZED_BYTES = 16 * 1024 * 1024
# Keep only the most recent N ops (journal blobs are the heavy part).
MAX_RETAINED_OPS = 20

JournalTruncationReason = Literal["image_limit", "serialized_byte_limit"]
RedoWarningCode = Literal[
    "redo_journal_truncated",
    "redo_journal_persistence_failed",
]


class RedoWarning(TypedDict):
    code: RedoWarningCode
    message: str


@dataclass(slots=True)
class JournalBuffer:
    serialized_json: bytearray
    entry_count: int
    max_images: int
    max_serialized_bytes: int
    truncated: bool
    truncation_reason: Optional[JournalTruncationReason]


@dataclass(frozen=True, slots=True)
class JournalRecordResult:
    op_id: str
    truncated: bool
    truncation_reason: Optional[JournalTruncationReason]


_JOURNAL_ENCODER = json.JSONEncoder(
    ensure_ascii=False,
    separators=(",", ":"),
)


def rows_digest(rows: Sequence[Mapping[str, object]]) -> str:
    """Digest of an image's tag SET (names only, case-folded).

    Confidence/provenance drift does not flag a conflict — only a changed
    tag set means someone edited the image after the journaled op.
    """
    names = sorted({str(r.get("tag") or "").lower() for r in rows if r.get("tag")})
    return hashlib.sha1(json.dumps(names, ensure_ascii=False).encode("utf-8")).hexdigest()


def create_journal_buffer(
    max_images: int,
    max_serialized_bytes: int,
) -> JournalBuffer:
    """Create a bounded serialized journal accumulator."""
    normalized_max_images = int(max_images)
    normalized_max_bytes = int(max_serialized_bytes)
    if normalized_max_images <= 0:
        raise ValueError("max_images must be greater than zero")
    if normalized_max_bytes < 2:
        raise ValueError("max_serialized_bytes must allow JSON array framing")
    return JournalBuffer(
        serialized_json=bytearray(b"["),
        entry_count=0,
        max_images=normalized_max_images,
        max_serialized_bytes=normalized_max_bytes,
        truncated=False,
        truncation_reason=None,
    )


def _truncate_journal(
    journal: JournalBuffer,
    reason: JournalTruncationReason,
) -> None:
    journal.serialized_json = bytearray()
    journal.truncated = True
    journal.truncation_reason = reason


def append_journal_entry(
    journal: JournalBuffer,
    image_id: int,
    before_rows: Sequence[Mapping[str, object]],
    after_rows: Sequence[Mapping[str, object]],
) -> None:
    """Serialize one undo row directly into the bounded retained buffer."""
    if journal.truncated:
        return
    if journal.entry_count >= journal.max_images:
        _truncate_journal(journal, "image_limit")
        return

    entry: Dict[str, object] = {
        "image_id": int(image_id),
        "before": before_rows,
        "after_digest": rows_digest(after_rows),
    }
    entry_start = len(journal.serialized_json)
    if journal.entry_count > 0:
        journal.serialized_json.extend(b",")
    try:
        for text_chunk in _JOURNAL_ENCODER.iterencode(entry):
            encoded_chunk = text_chunk.encode("utf-8")
            projected_size = len(journal.serialized_json) + len(encoded_chunk) + 1
            if projected_size > journal.max_serialized_bytes:
                _truncate_journal(journal, "serialized_byte_limit")
                return
            journal.serialized_json.extend(encoded_chunk)
    except Exception:
        del journal.serialized_json[entry_start:]
        raise
    journal.entry_count += 1


def _compress_journal(
    journal: JournalBuffer,
    images_affected: int,
) -> Optional[bytes]:
    if journal.truncated:
        return None
    if journal.entry_count != images_affected:
        raise ValueError(
            "Undo journal entry count does not match images_affected: "
            f"entries={journal.entry_count}, images_affected={images_affected}."
        )
    output = io.BytesIO()
    with gzip.GzipFile(
        filename="",
        mode="wb",
        compresslevel=6,
        fileobj=output,
        mtime=0,
    ) as compressed:
        compressed.write(journal.serialized_json)
        compressed.write(b"]")
    return output.getvalue()


def record_op(
    *,
    operation: str,
    scope_source: str,
    params: Dict[str, Any],
    journal: JournalBuffer,
    images_affected: int,
) -> JournalRecordResult:
    """Persist one bounded journal row without rebuilding its JSON payload."""
    normalized_images_affected = int(images_affected)
    if normalized_images_affected < 0:
        raise ValueError("images_affected cannot be negative")
    op_id = uuid.uuid4().hex
    try:
        blob = _compress_journal(journal, normalized_images_affected)
    finally:
        journal.serialized_json = bytearray()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO tag_bulk_ops (id, operation, scope_source, params_json, images_affected, journal_gz, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                op_id,
                operation,
                scope_source,
                json.dumps(params, ensure_ascii=False),
                normalized_images_affected,
                blob,
                1 if journal.truncated else 0,
            ),
        )
        conn.execute(
            "DELETE FROM tag_bulk_ops WHERE id NOT IN (SELECT id FROM tag_bulk_ops ORDER BY created_at DESC, rowid DESC LIMIT ?)",
            (MAX_RETAINED_OPS,),
        )
    return JournalRecordResult(
        op_id=op_id,
        truncated=journal.truncated,
        truncation_reason=journal.truncation_reason,
    )


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


def _load_journal_payload(
    blob: bytes,
    max_serialized_bytes: int,
) -> List[Dict[str, Any]]:
    """Decode persisted journal data without unbounded decompression."""
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(blob), mode="rb") as compressed:
            serialized = compressed.read(int(max_serialized_bytes) + 1)
    except (EOFError, OSError) as exc:
        raise ValueError(f"Undo journal compressed data is invalid: {exc}") from exc
    if len(serialized) > int(max_serialized_bytes):
        raise ValueError(
            "Undo journal exceeds the supported serialized-data limit: "
            f"limit={int(max_serialized_bytes)} bytes."
        )
    try:
        payload = json.loads(serialized.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Undo journal payload is invalid: {exc}") from exc
    if not isinstance(payload, list):
        raise ValueError("Undo journal payload must be a list")

    validated: List[Dict[str, Any]] = []
    for index, raw_entry in enumerate(payload):
        if not isinstance(raw_entry, dict):
            raise ValueError(f"Undo journal entry {index} must be an object")
        if "image_id" not in raw_entry or "before" not in raw_entry:
            raise ValueError(
                f"Undo journal entry {index} is missing image_id or before"
            )
        before_rows = raw_entry["before"]
        after_digest = raw_entry.get("after_digest")
        if not isinstance(before_rows, list) or not all(
            isinstance(row, dict) for row in before_rows
        ):
            raise ValueError(f"Undo journal entry {index} has invalid before rows")
        if not isinstance(after_digest, str):
            raise ValueError(f"Undo journal entry {index} has invalid after_digest")
        try:
            image_id = int(raw_entry["image_id"])
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"Undo journal entry {index} has invalid image_id"
            ) from exc
        if image_id <= 0:
            raise ValueError(f"Undo journal entry {index} has invalid image_id")
        validated.append(
            {
                "image_id": image_id,
                "before": before_rows,
                "after_digest": after_digest,
            }
        )
    return validated


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
        raise ValueError(
            "No undo journal was stored for this operation "
            "(journal image or serialized-data limit exceeded)"
        )

    payload = _load_journal_payload(blob, MAX_JOURNAL_SERIALIZED_BYTES)
    restored = 0
    skipped_conflicts: List[int] = []
    redo_journal = create_journal_buffer(
        MAX_JOURNAL_IMAGES,
        MAX_JOURNAL_SERIALIZED_BYTES,
    )
    for entry in payload:
        image_id = int(entry["image_id"])
        before_rows = entry.get("before") or []
        current = db.get_image_tags(image_id)
        if not force and rows_digest(current) != entry.get("after_digest"):
            skipped_conflicts.append(image_id)
            continue
        db.add_tags(image_id, before_rows, replace_scope="all")
        append_journal_entry(
            redo_journal,
            image_id,
            current,
            before_rows,
        )
        restored += 1

    recorded_redo_op_id: Optional[str] = None
    redo_op_id: Optional[str] = None
    redo_available = False
    warnings: List[RedoWarning] = []
    if restored > 0:
        try:
            redo_result = record_op(
                operation=f"undo:{operation}",
                scope_source="undo",
                params={"undo_of": op_id, "force": bool(force)},
                journal=redo_journal,
                images_affected=restored,
            )
            recorded_redo_op_id = redo_result.op_id
            if redo_result.truncated:
                if redo_result.truncation_reason == "serialized_byte_limit":
                    limit_description = (
                        f"the {redo_journal.max_serialized_bytes}-byte "
                        "serialized-data limit"
                    )
                else:
                    limit_description = (
                        f"the {redo_journal.max_images}-image limit"
                    )
                warnings.append({
                    "code": "redo_journal_truncated",
                    "message": (
                        "Undo was applied, but redo is unavailable because the "
                        f"journal exceeded {limit_description}."
                    ),
                })
            else:
                redo_op_id = redo_result.op_id
                redo_available = True
        except Exception as exc:
            logger.warning(
                "bulk redo journal record failed",
                extra={
                    "operation": operation,
                    "restored": restored,
                    "error_type": type(exc).__name__,
                },
                exc_info=exc,
            )
            warnings.append({
                "code": "redo_journal_persistence_failed",
                "message": (
                    "Undo was applied, but redo is unavailable because the journal "
                    f"could not be saved. Cause: {type(exc).__name__}: {exc}"
                ),
            })
    with get_db() as conn:
        conn.execute(
            "UPDATE tag_bulk_ops SET undone_at = datetime('now'), undo_op_id = ? WHERE id = ?",
            (recorded_redo_op_id, op_id),
        )
    return {
        "op_id": op_id,
        "operation": operation,
        "restored": restored,
        "skipped_conflicts": skipped_conflicts,
        "redo_op_id": redo_op_id,
        "redo_available": redo_available,
        "warnings": warnings,
    }
