"""Library read surface and backup import/export for the tagging service.

Moved verbatim from services/tagging_service.py (decomposition 2026-07).
"""

import sqlite3
from typing import Any, Dict, List, Optional, Tuple

import database as db
from library_context import current_library_sql
from services.tagging.request import VALID_SORT_OPTIONS, TagImportRequest

# Why an import row changed nothing. ``skipped`` in the import result is their
# sum; each is also reported on its own so the UI can say why.
IMPORT_SKIP_REASONS = ("not_found", "ambiguous", "already_tagged", "duplicate")


class LibraryIOMixin:
    """Library/backup slice of TaggingService (assembled in services.tagging.service)."""

    def get_all_tags(self, limit: Optional[int] = None) -> Dict[str, Any]:
        """Get all unique tags with occurrence counts."""
        tags = db.get_all_tags()
        return {"tags": tags if limit is None else tags[:limit], "total": len(tags)}

    def get_generators(self) -> Dict[str, Any]:
        """Get all generators with image counts."""
        generators = db.get_all_generators()
        return {"generators": generators}

    def get_tags_library(
        self,
        sort_by: str = "frequency",
        limit: Optional[int] = None,
        search_query: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get tags library with frequency and sorting options."""
        if sort_by not in VALID_SORT_OPTIONS:
            sort_by = "frequency"

        return db.search_tags(search_query, sort_by=sort_by, limit=limit)

    def get_prompts_library(
        self,
        limit: Optional[int] = None,
        search_query: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get unique prompt tokens from the normalized prompt-token index."""
        return db.get_all_prompt_tokens(limit=limit, search_query=search_query)

    def get_loras_library(
        self,
        limit: Optional[int] = None,
        search_query: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get unique LoRAs from the normalized indexed LoRA table."""
        return db.get_all_loras(limit=limit, search_query=search_query)

    def get_checkpoints_library(
        self,
        limit: Optional[int] = None,
        search_query: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get unique checkpoints (normalized) with frequency counts.

        v3.3.0 FEAT-CHECKPOINT-TAB: mirrors get_loras_library so the library
        modal can show a Checkpoints tab. db.get_all_checkpoints returns a
        list, so wrap it in the {items, total} envelope the frontend expects.
        """
        checkpoints = db.get_all_checkpoints(limit=limit, search_query=search_query)
        total = len(checkpoints) if limit is None else db.count_checkpoints(search_query=search_query)
        return {"checkpoints": checkpoints, "total": total}

    def export_tags(self) -> Dict[str, Any]:
        """Export the current library's image tags as JSON for backup/transfer."""
        lib_sql, lib_params = current_library_sql("i.library_id")
        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute(
                f"""
                SELECT i.id, i.path, i.filename, i.generator, i.checkpoint,
                       i.ai_caption,
                       GROUP_CONCAT(t.tag || ':' || t.confidence, '|||') as tags
                FROM images i
                LEFT JOIN tags t ON i.id = t.image_id
                WHERE i.tagged_at IS NOT NULL AND {lib_sql}
                GROUP BY i.id
                """,
                lib_params,
            )

            export_data = []
            for row in cursor.fetchall():
                image_data = {
                    "path": row["path"],
                    "filename": row["filename"],
                    "generator": row["generator"],
                    "checkpoint": row["checkpoint"],
                    "ai_caption": row["ai_caption"] or "",
                    "tags": [],
                }

                if row["tags"]:
                    for tag_pair in row["tags"].split("|||"):
                        if ":" in tag_pair:
                            tag, conf = tag_pair.rsplit(":", 1)
                            try:
                                image_data["tags"].append(
                                    {"tag": tag, "confidence": float(conf)}
                                )
                            except ValueError:
                                image_data["tags"].append(
                                    {"tag": tag_pair, "confidence": 0.5}
                                )

                export_data.append(image_data)

            return {"version": "1.0", "count": len(export_data), "images": export_data}

    def import_tags(self, request: TagImportRequest) -> Dict[str, int]:
        """Import tags from exported JSON data into the current library.

        Rows are matched to the library's own images, by path and then by file
        name; another library's image is never written. A file name that
        several of the library's images share is skipped, not guessed.
        Returns ``imported``, ``skipped`` and each reason in
        :data:`IMPORT_SKIP_REASONS` (they add up to ``skipped``). Rows with
        neither tags nor a caption are left out of every count.
        """
        counts = dict.fromkeys(("imported", *IMPORT_SKIP_REASONS), 0)
        batched_updates: List[Dict[str, Any]] = []
        scheduled_image_ids: set[int] = set()

        with db.get_db() as conn:
            cursor = conn.cursor()

            for img_data in request.images:
                tags = self._normalize_import_tags(img_data.get("tags", []))
                ai_caption = str(img_data.get("ai_caption") or "").strip()
                if not tags and not ai_caption:
                    continue

                row, miss = self._find_import_target(
                    cursor, img_data.get("path", ""), img_data.get("filename", "")
                )
                if row is None:
                    counts[miss] += 1
                    continue

                image_id = row["id"]
                if row["tagged_at"] is not None and not request.overwrite:
                    counts["already_tagged"] += 1
                    continue

                # Keep import semantics stable for overwrite=False:
                # duplicate rows targeting the same previously-untagged image
                # should only import once in a single request.
                if not request.overwrite and image_id in scheduled_image_ids:
                    counts["duplicate"] += 1
                    continue

                batched_updates.append(
                    {
                        "image_id": image_id,
                        "tags": tags,
                        "ai_caption": ai_caption,
                    }
                )
                scheduled_image_ids.add(image_id)
                counts["imported"] += 1

        if batched_updates:
            # User-supplied import data: mark rows 'manual' so later tagger
            # re-runs (pipeline scope) don't wipe what the user brought in.
            db.add_tags_batch(batched_updates, default_source="manual")

        skipped = sum(counts[reason] for reason in IMPORT_SKIP_REASONS)
        return {
            "imported": counts["imported"],
            "skipped": skipped,
            **{reason: counts[reason] for reason in IMPORT_SKIP_REASONS},
        }

    @staticmethod
    def _find_import_target(
        cursor: sqlite3.Cursor, path: str, filename: str
    ) -> Tuple[Optional[sqlite3.Row], Optional[str]]:
        """The current library's image an import row names, or why there is none.

        Returns ``(row, None)`` with the row's ``id`` and ``tagged_at``, or
        ``(None, "not_found" | "ambiguous")``.
        """
        image_row = (
            db.get_image_by_path(path, current_library_only=True) if path else None
        )
        if image_row:
            cursor.execute(
                "SELECT id, tagged_at FROM images WHERE id = ?",
                (image_row["id"],),
            )
            row = cursor.fetchone()
            return (row, None) if row else (None, "not_found")
        if not filename:
            return None, "not_found"
        lib_sql, lib_params = current_library_sql()
        cursor.execute(
            f"SELECT id, tagged_at FROM images WHERE filename = ? AND {lib_sql} LIMIT 2",
            (filename, *lib_params),
        )
        rows = cursor.fetchall()
        if len(rows) > 1:
            return None, "ambiguous"
        return (rows[0], None) if rows else (None, "not_found")

    @staticmethod
    def _normalize_import_tags(raw_tags: Any) -> List[Dict[str, Any]]:
        """
        Normalize imported tag payloads into a deduplicated list.

        We keep last-write-wins confidence semantics for duplicate tags to
        match prior INSERT OR REPLACE behavior.
        """
        deduped: Dict[str, Dict[str, Any]] = {}
        for tag_info in raw_tags or []:
            if not isinstance(tag_info, dict):
                continue

            tag = str(tag_info.get("tag", "")).strip()
            if not tag:
                continue

            confidence_raw = tag_info.get("confidence", 0.5)
            try:
                confidence = float(confidence_raw)
            except (TypeError, ValueError):
                confidence = 0.5

            deduped[tag] = {"tag": tag, "confidence": confidence}

        return list(deduped.values())

    def fix_rating_tags(self) -> Dict[str, Any]:
        """Clean up duplicate rating tags in existing database."""
        rating_tags = ["general", "sensitive", "questionable", "explicit"]
        fixed_count = 0

        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute(
                """
                SELECT DISTINCT image_id
                FROM tags
                WHERE tag IN (?, ?, ?, ?)
            """,
                rating_tags,
            )

            image_ids = [row[0] for row in cursor.fetchall()]

            for image_id in image_ids:
                cursor.execute(
                    """
                    SELECT id, tag, confidence
                    FROM tags
                    WHERE image_id = ? AND tag IN (?, ?, ?, ?)
                    ORDER BY confidence DESC
                """,
                    [image_id] + rating_tags,
                )

                ratings = cursor.fetchall()

                if len(ratings) > 1:
                    remove_ids = [r["id"] for r in ratings[1:]]

                    placeholders = ",".join("?" * len(remove_ids))
                    cursor.execute(
                        f"DELETE FROM tags WHERE id IN ({placeholders})", remove_ids
                    )
                    fixed_count += 1

            conn.commit()

        return {
            "status": "ok",
            "images_fixed": fixed_count,
            "message": f"Cleaned up rating tags for {fixed_count} images",
        }

    def get_scope_count(self, retag_all: bool = False) -> Dict[str, Any]:
        """How many images a whole-library tagging run would process.

        Mirrors the worker's own selection: untagged readable images, or every
        readable image with ``retag_all``. The tag modal shows it before a run.
        """
        count = db.count_all_image_ids() if retag_all else db.count_untagged_image_ids()
        return {"count": int(count), "retag_all": bool(retag_all)}
