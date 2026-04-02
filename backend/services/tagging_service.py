"""
Tagging service for SD Image Sorter.

Handles business logic for AI tagging, tag management, and import/export.
"""
import logging
import os
import re
import gc
import time
import json
import threading
from typing import Optional, List, Dict, Any, Callable

from fastapi import HTTPException, BackgroundTasks
from pydantic import BaseModel, Field, field_validator

import database as db

logger = logging.getLogger(__name__)

# Validation constants
THRESHOLD_MIN = 0.0
THRESHOLD_MAX = 1.0
PATH_MAX_LENGTH = 4096
BATCH_EXPORT_LIMIT = 10000
VALID_SORT_OPTIONS = ["frequency", "alphabetical"]


class TagRequest(BaseModel):
    """Request model for tagging operations."""
    image_ids: Optional[List[int]] = Field(default=None, max_length=BATCH_EXPORT_LIMIT)
    threshold: float = Field(default=0.35, ge=THRESHOLD_MIN, le=THRESHOLD_MAX)
    character_threshold: float = Field(default=0.85, ge=THRESHOLD_MIN, le=THRESHOLD_MAX)
    retag_all: bool = False
    model_name: Optional[str] = Field(default=None, max_length=256)
    model_path: Optional[str] = Field(default=None, max_length=PATH_MAX_LENGTH)
    tags_path: Optional[str] = Field(default=None, max_length=PATH_MAX_LENGTH)
    use_gpu: bool = True


class TagImportRequest(BaseModel):
    """Request model for tag import."""
    images: List[dict] = Field(..., max_length=BATCH_EXPORT_LIMIT)
    overwrite: bool = False


class BatchTagExportRequest(BaseModel):
    """Request model for batch tag export."""
    image_ids: List[int] = Field(..., min_length=1, max_length=BATCH_EXPORT_LIMIT)
    output_folder: str = Field(..., max_length=PATH_MAX_LENGTH)
    blacklist: Optional[List[str]] = Field(default=[], max_length=500)
    prefix: Optional[str] = Field(default="", max_length=256)


class TaggingService:
    """Service for AI tagging and tag management."""

    def __init__(self):
        """Initialize the tagging service."""
        self._progress: Dict[str, Any] = {"status": "idle", "current": 0, "total": 0, "message": ""}
        self._lock = threading.Lock()
        self._get_tagger: Optional[Callable] = None

    def set_tagger_getter(self, tagger_getter: Callable) -> None:
        """Set the tagger getter function from main module."""
        self._get_tagger = tagger_getter

    def get_progress(self) -> Dict[str, Any]:
        """Get the current tagging progress state."""
        with self._lock:
            return self._progress.copy()

    def set_progress(self, state: Dict[str, Any]) -> None:
        """Set the tag progress state."""
        with self._lock:
            self._progress = state

    def reset_progress(self) -> Dict[str, Any]:
        """Reset a stuck tagging task back to idle."""
        with self._lock:
            if self._progress["status"] == "running":
                self._progress = {
                    "status": "idle",
                    "current": 0,
                    "total": 0,
                    "message": "Reset by user"
                }
                return {"status": "reset", "message": "Tagging progress reset to idle"}
            return {"status": self._progress["status"], "message": "Nothing to reset (not running)"}

    def get_all_tags(self, limit: int = 500) -> Dict[str, Any]:
        """Get all unique tags with occurrence counts."""
        tags = db.get_all_tags()
        return {"tags": tags[:limit]}

    def get_generators(self) -> Dict[str, Any]:
        """Get all generators with image counts."""
        generators = db.get_all_generators()
        return {"generators": generators}

    def get_tags_library(self, sort_by: str = "frequency", limit: int = 1000) -> Dict[str, Any]:
        """Get tags library with frequency and sorting options."""
        if sort_by not in VALID_SORT_OPTIONS:
            sort_by = "frequency"

        tags = db.get_all_tags()

        if sort_by == "alphabetical":
            tags = sorted(tags, key=lambda x: x["tag"].lower())

        return {
            "tags": tags[:limit],
            "total": len(tags),
            "sort": sort_by
        }

    def get_prompts_library(self, limit: int = 500) -> Dict[str, Any]:
        """Get unique prompt tokens from images with frequency counts."""
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, prompt
                FROM images
                WHERE prompt IS NOT NULL AND prompt != ''
            """)

            token_counts: dict[str, int] = {}

            for row in cursor.fetchall():
                prompt = row["prompt"]

                clean_prompt = re.sub(r'<[^>]+>[^<]*</[^>]+>', '', prompt)
                clean_prompt = re.sub(r'<lora:[^>]+>', '', clean_prompt)
                clean_prompt = re.sub(r'<[^>]+>', '', clean_prompt)

                image_tokens = set()

                tokens = [t.strip() for t in clean_prompt.split(',') if t.strip()]
                for token in tokens:
                    clean_token = re.sub(r'^\(+|\)+$', '', token)
                    clean_token = re.sub(r':\d+\.?\d*\)?$', '', clean_token)
                    clean_token = clean_token.strip()

                    if clean_token and len(clean_token) > 1:
                        normalized = self._normalize_prompt_token(clean_token)
                        if normalized and len(normalized) > 1:
                            image_tokens.add(normalized)

                for normalized in image_tokens:
                    token_counts[normalized] = token_counts.get(normalized, 0) + 1

            sorted_tokens = sorted(token_counts.items(), key=lambda x: x[1], reverse=True)
            prompts = [{"prompt": normalized, "count": count} for normalized, count in sorted_tokens]

        return {
            "prompts": prompts[:limit],
            "total": len(prompts)
        }

    def get_loras_library(self, limit: int = 500) -> Dict[str, Any]:
        """Get unique LoRAs from images with frequency counts."""
        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT id, loras, prompt
                FROM images
                WHERE (loras IS NOT NULL AND loras != '[]' AND loras != '')
                   OR (prompt IS NOT NULL AND prompt LIKE '%<lora:%')
            """)

            lora_counts: dict[str, int] = {}

            for row in cursor.fetchall():
                loras_str = row["loras"] or ""
                prompt_str = row["prompt"] or ""

                image_loras = set()

                if loras_str:
                    try:
                        loras_list = json.loads(loras_str)
                        for lora_name in loras_list:
                            if lora_name and len(lora_name) > 2:
                                normalized = self._normalize_lora_name(lora_name)
                                if normalized and len(normalized) > 2:
                                    image_loras.add(normalized)
                    except (json.JSONDecodeError, TypeError):
                        pass

                if prompt_str:
                    lora_matches = re.findall(r'<lora:([^:>]+)(?:[^>]*)?>', prompt_str, re.IGNORECASE)
                    for lora_name in lora_matches:
                        if lora_name and len(lora_name) > 2:
                            normalized = self._normalize_lora_name(lora_name)
                            if normalized and len(normalized) > 2:
                                image_loras.add(normalized)

                for normalized in image_loras:
                    lora_counts[normalized] = lora_counts.get(normalized, 0) + 1

            sorted_loras = sorted(lora_counts.items(), key=lambda x: x[1], reverse=True)
            loras = [{"lora": normalized, "count": count} for normalized, count in sorted_loras[:limit]]

        return {
            "loras": loras,
            "total": len(lora_counts)
        }

    def export_tags(self) -> Dict[str, Any]:
        """Export all image tags as JSON for backup/transfer."""
        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT i.id, i.path, i.filename, i.generator, i.checkpoint,
                       GROUP_CONCAT(t.tag || ':' || t.confidence, '|||') as tags
                FROM images i
                LEFT JOIN tags t ON i.id = t.image_id
                WHERE i.tagged_at IS NOT NULL
                GROUP BY i.id
            """)

            export_data = []
            for row in cursor.fetchall():
                image_data = {
                    "path": row["path"],
                    "filename": row["filename"],
                    "generator": row["generator"],
                    "checkpoint": row["checkpoint"],
                    "tags": []
                }

                if row["tags"]:
                    for tag_pair in row["tags"].split("|||"):
                        if ":" in tag_pair:
                            tag, conf = tag_pair.rsplit(":", 1)
                            try:
                                image_data["tags"].append({"tag": tag, "confidence": float(conf)})
                            except ValueError:
                                image_data["tags"].append({"tag": tag_pair, "confidence": 0.5})

                export_data.append(image_data)

            return {
                "version": "1.0",
                "count": len(export_data),
                "images": export_data
            }

    def import_tags(self, request: TagImportRequest) -> Dict[str, int]:
        """Import tags from exported JSON data."""
        imported = 0
        skipped = 0

        with db.get_db() as conn:
            cursor = conn.cursor()

            for img_data in request.images:
                path = img_data.get("path", "")
                filename = img_data.get("filename", "")
                tags = img_data.get("tags", [])

                if not tags:
                    continue

                cursor.execute(
                    "SELECT id, tagged_at FROM images WHERE path = ? OR filename = ?",
                    (path, filename)
                )
                row = cursor.fetchone()

                if not row:
                    skipped += 1
                    continue

                image_id = row["id"]
                already_tagged = row["tagged_at"] is not None

                if already_tagged and not request.overwrite:
                    skipped += 1
                    continue

                if request.overwrite:
                    cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))

                for tag_info in tags:
                    tag = tag_info.get("tag", "")
                    conf = tag_info.get("confidence", 0.5)
                    if tag:
                        cursor.execute(
                            "INSERT OR REPLACE INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                            (image_id, tag, conf)
                        )

                cursor.execute(
                    "UPDATE images SET tagged_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (image_id,)
                )
                imported += 1

            conn.commit()

        return {"imported": imported, "skipped": skipped}

    def start_tagging(
        self,
        request: TagRequest,
        background_tasks: BackgroundTasks
    ) -> Dict[str, str]:
        """Start tagging images with WD14 tagger."""
        if self._progress["status"] == "running":
            raise HTTPException(status_code=400, detail="Tagging already in progress")

        if self._get_tagger is None:
            raise HTTPException(status_code=500, detail="Tagger not initialized")

        def run_tagging():
            with self._lock:
                self._progress = {"status": "running", "current": 0, "total": 0, "message": "Loading model..."}

            total_tagged = 0
            try:
                tagger = self._get_tagger(
                    model_name=request.model_name,
                    model_path=request.model_path,
                    tags_path=request.tags_path,
                    threshold=request.threshold,
                    character_threshold=request.character_threshold,
                    use_gpu=request.use_gpu
                )

                if request.image_ids:
                    all_ids = [img_id for img_id in request.image_ids
                               if db.get_image_by_id(img_id) is not None]
                elif request.retag_all:
                    all_ids = db.get_all_image_ids()
                else:
                    all_ids = db.get_untagged_image_ids()

                total = len(all_ids)
                with self._lock:
                    self._progress["total"] = total
                    self._progress["message"] = f"Tagging {total} images..."

                BATCH_SIZE = 100
                COMMIT_INTERVAL = 50  # Commit every 50 images to avoid long-running transactions
                tags_batch = []  # Collect tags for batch insert
                
                for batch_start in range(0, total, BATCH_SIZE):
                    batch_ids = all_ids[batch_start:batch_start + BATCH_SIZE]
                    # N+1 fix: Use batch fetch instead of individual get_image_by_id calls
                    batch_images_map = db.get_images_by_ids(batch_ids)
                    batch_images = [img for img in batch_images_map.values() if img]

                    for img in batch_images:
                        i = total_tagged
                        with self._lock:
                            self._progress["current"] = i + 1
                            self._progress["message"] = f"Tagging: {img['filename']} ({i+1}/{total})"

                        try:
                            if os.path.exists(img["path"]):
                                result = tagger.tag(img["path"])
                                tags_batch.append({
                                    "image_id": img["id"],
                                    "tags": result["all_tags"]
                                })
                                
                                # Batch insert tags every COMMIT_INTERVAL images
                                if len(tags_batch) >= COMMIT_INTERVAL:
                                    db.add_tags_batch(tags_batch)
                                    tags_batch = []
                        except Exception as e:
                            logger.error("Error tagging %s: %s", img['path'], e)

                        total_tagged += 1
                        if total_tagged % 50 == 0:
                            gc.collect()
                            time.sleep(0.5)
                            with self._lock:
                                self._progress["message"] = f"Processed {total_tagged}/{total} - brief rest..."

                    # Insert any remaining tags in the batch
                    if tags_batch:
                        db.add_tags_batch(tags_batch)
                        tags_batch = []
                    
                    del batch_images
                    gc.collect()

                with self._lock:
                    self._progress = {
                        "status": "done",
                        "current": total_tagged,
                        "total": total,
                        "message": f"Completed! Tagged {total_tagged} images."
                    }
            except Exception as e:
                with self._lock:
                    self._progress = {
                        "status": "error",
                        "current": total_tagged,
                        "total": self._progress.get("total", 0),
                        "message": f"Error: {str(e)}"
                    }
            finally:
                with self._lock:
                    if self._progress["status"] == "running":
                        self._progress["status"] = "error"
                        self._progress["message"] = "Task ended unexpectedly"

        background_tasks.add_task(run_tagging)
        return {"status": "started", "message": "Tagging started in background"}

    def export_tags_batch(self, request: BatchTagExportRequest) -> Dict[str, Any]:
        """Export tags for each image to individual .txt files."""
        from utils.path_validation import validate_folder_path

        is_valid, error = validate_folder_path(request.output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error)

        os.makedirs(request.output_folder, exist_ok=True)

        exported = 0
        errors = 0

        for image_id in request.image_ids:
            try:
                image = db.get_image_by_id(image_id)
                if not image:
                    errors += 1
                    continue

                tags = db.get_image_tags(image_id)
                if not tags:
                    continue

                blacklist = request.blacklist or []
                filtered_tags = [t["tag"] for t in tags if t["tag"] not in blacklist]

                if request.prefix:
                    filtered_tags = [request.prefix + t for t in filtered_tags]

                basename = os.path.splitext(image["filename"])[0]
                txt_path = os.path.join(request.output_folder, f"{basename}.txt")

                with open(txt_path, "w", encoding="utf-8") as f:
                    f.write(", ".join(filtered_tags))

                exported += 1
            except Exception as e:
                logger.error("Error exporting tags for image %d: %s", image_id, e)
                errors += 1

        return {"exported": exported, "errors": errors}

    def fix_rating_tags(self) -> Dict[str, Any]:
        """Clean up duplicate rating tags in existing database."""
        rating_tags = ['general', 'sensitive', 'questionable', 'explicit']
        fixed_count = 0

        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT DISTINCT image_id
                FROM tags
                WHERE tag IN (?, ?, ?, ?)
            """, rating_tags)

            image_ids = [row[0] for row in cursor.fetchall()]

            for image_id in image_ids:
                cursor.execute("""
                    SELECT id, tag, confidence
                    FROM tags
                    WHERE image_id = ? AND tag IN (?, ?, ?, ?)
                    ORDER BY confidence DESC
                """, [image_id] + rating_tags)

                ratings = cursor.fetchall()

                if len(ratings) > 1:
                    keep_id = ratings[0]['id']
                    remove_ids = [r['id'] for r in ratings[1:]]

                    placeholders = ",".join("?" * len(remove_ids))
                    cursor.execute(f"DELETE FROM tags WHERE id IN ({placeholders})", remove_ids)
                    fixed_count += 1

            conn.commit()

        return {
            "status": "ok",
            "images_fixed": fixed_count,
            "message": f"Cleaned up rating tags for {fixed_count} images"
        }

    @staticmethod
    def _normalize_prompt_token(token: str) -> str:
        """Normalize a prompt token for consistent matching."""
        return token.lower().replace('_', ' ').strip()

    @staticmethod
    def _normalize_lora_name(lora_name: str) -> str:
        """Normalize a LORA name for consistent matching."""
        if ':' in lora_name:
            parts = lora_name.rsplit(':', 1)
            try:
                float(parts[1])
                lora_name = parts[0]
            except ValueError:
                pass

        extensions_to_strip = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']
        lora_lower = lora_name.lower()
        for ext in extensions_to_strip:
            if lora_lower.endswith(ext):
                lora_name = lora_name[:-len(ext)]
                break

        return lora_name.lower().strip()
