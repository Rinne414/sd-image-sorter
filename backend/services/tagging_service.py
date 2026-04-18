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
import queue as queue_module
import multiprocessing
from typing import Optional, List, Dict, Any, Callable

from fastapi import HTTPException, BackgroundTasks
from pydantic import BaseModel, Field, field_validator

import database as db
from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS

logger = logging.getLogger(__name__)

# Validation constants
THRESHOLD_MIN = 0.0
THRESHOLD_MAX = 1.0
PATH_MAX_LENGTH = 4096
BATCH_EXPORT_LIMIT = 10000
VALID_SORT_OPTIONS = ["frequency", "alphabetical"]
TRUE_BATCH_MODEL_MAX = 32
CPU_CHUNK_MAX = 64
TORIIGATE_GPU_CHUNK_MAX = 2


def _format_runtime_adjustment_message(runtime_info: Dict[str, Any]) -> str:
    """Summarize adaptive runtime adjustments for the progress UI."""
    backoff_steps = runtime_info.get("backoff_steps") or []
    if not backoff_steps:
        return ""

    parts = []
    for step in backoff_steps:
        mode = step.get("mode")
        from_size = step.get("from")
        to_size = step.get("to")
        if mode == "gpu_backoff":
            parts.append(f"GPU batch {from_size}->{to_size}")
        elif mode == "cpu_fallback":
            parts.append(f"GPU batch {from_size}->CPU Safe Mode")

    final_chunk_size = runtime_info.get("final_chunk_size")
    if runtime_info.get("used_cpu_fallback"):
        parts.append("continued on CPU")
    elif final_chunk_size:
        parts.append(f"current chunk {final_chunk_size}")
    return ", ".join(parts)


def _build_tag_progress_state(
    status: str,
    current: int = 0,
    total: int = 0,
    tagged: int = 0,
    errors: int = 0,
    message: str = "",
) -> Dict[str, Any]:
    """Build a normalized tag progress payload."""
    return {
        "status": status,
        "current": current,
        "processed": current,
        "total": total,
        "tagged": tagged,
        "errors": errors,
        "message": message,
    }


def _tagging_worker_main(
    runtime_plan_payload: Dict[str, Any],
    progress_queue: Any,
    cancel_event: Any,
) -> None:
    """Run the heavy tagger work in a child process so GPU/provider crashes do not kill the API."""
    import database as worker_db
    from tagger import get_tagger
    from toriigate_tagger import get_toriigate_tagger

    request = TagRequest.model_validate(runtime_plan_payload.get("request", {}))
    effective_model_name = runtime_plan_payload.get("model_name") or (request.model_name or DEFAULT_TAGGER_MODEL).strip()
    model_config = TAGGER_MODELS.get(effective_model_name, {})
    runtime_backend = str(model_config.get("runtime_backend", "wd14")).lower()
    effective_use_gpu = bool(runtime_plan_payload.get("effective_use_gpu", request.use_gpu))
    startup_notice = str(runtime_plan_payload.get("startup_notice", "") or "")
    batch_size = max(1, int(runtime_plan_payload.get("fetch_batch_size", 100)))
    commit_interval = max(1, int(runtime_plan_payload.get("commit_interval", 50)))
    gc_interval = max(1, int(runtime_plan_payload.get("gc_interval", 50)))
    cpu_pause_seconds = max(0.0, float(runtime_plan_payload.get("cpu_pause_seconds", 0.0)))
    session_refresh_interval = max(0, int(runtime_plan_payload.get("session_refresh_interval", 0)))
    total_processed = 0
    total_tagged = 0
    total_errors = 0
    total = 0
    gpu_fallback_announced = False
    tagging_start_time = 0.0

    def send(status: str, message: str, current: Optional[int] = None, total_override: Optional[int] = None) -> None:
        progress_queue.put(
            _build_tag_progress_state(
                status=status,
                current=total_processed if current is None else current,
                total=total if total_override is None else total_override,
                tagged=total_tagged,
                errors=total_errors,
                message=message,
            )
        )

    def send_with_eta(base_message: str) -> None:
        """Send a progress message with ETA calculation when in tagging phase."""
        if tagging_start_time > 0 and total_processed > 0 and total > 0:
            elapsed = time.time() - tagging_start_time
            rate = total_processed / max(elapsed, 0.001)
            remaining = total - total_processed
            eta_seconds = remaining / max(rate, 0.001)
            if eta_seconds < 60:
                eta_str = f"{int(eta_seconds)}s"
            elif eta_seconds < 3600:
                eta_str = f"{int(eta_seconds // 60)}m {int(eta_seconds % 60)}s"
            else:
                eta_str = f"{int(eta_seconds // 3600)}h {int((eta_seconds % 3600) // 60)}m"
            send("running", f"{base_message} (ETA: {eta_str})")
        else:
            send("running", base_message)

    try:
        if request.model_path:
            send("running", "Loading custom model...")
        elif effective_use_gpu:
            send("running", "Loading model on GPU...")
        else:
            send("running", "Loading model on CPU...")

        tagger_getter = get_toriigate_tagger if runtime_backend == "toriigate" else get_tagger
        tagger = tagger_getter(
            model_name=effective_model_name,
            model_path=request.model_path,
            tags_path=request.tags_path,
            threshold=request.threshold,
            character_threshold=request.character_threshold,
            use_gpu=effective_use_gpu,
            force_reload=True,
        )

        # Eagerly load the model so progress transitions from "loading" to "tagging"
        if hasattr(tagger, "load"):
            tagger.load()

        if hasattr(tagger, "set_session_refresh_interval"):
            tagger.set_session_refresh_interval(session_refresh_interval)

        if startup_notice:
            send("running", startup_notice)

        if effective_use_gpu and not getattr(tagger, "use_gpu", False):
            gpu_fallback_announced = True
            send("running", "GPU load failed. Continuing in CPU Safe Mode instead.")

        if cancel_event.is_set():
            send("cancelled", "Tagging cancelled before processing images")
            return

        send("running", "Collecting image list...")
        if request.image_ids:
            all_ids = [img_id for img_id in request.image_ids if worker_db.get_image_by_id(img_id) is not None]
        elif request.retag_all:
            all_ids = worker_db.get_all_image_ids()
        else:
            all_ids = worker_db.get_untagged_image_ids()

        total = len(all_ids)
        send("running", f"Model loaded. Tagging {total} images...", current=0, total_override=total)
        tagging_start_time = time.time()
        tags_batch: List[Dict[str, Any]] = []

        for batch_start in range(0, total, batch_size):
            if cancel_event.is_set():
                break

            batch_ids = all_ids[batch_start:batch_start + batch_size]
            batch_images_map = worker_db.get_images_by_ids(batch_ids)
            batch_images = [img for img in batch_images_map.values() if img]

            existing_images: List[Dict[str, Any]] = []
            batch_paths: List[str] = []

            for img in batch_images:
                if os.path.exists(img["path"]):
                    existing_images.append(img)
                    batch_paths.append(img["path"])
                else:
                    total_errors += 1
                    total_processed += 1
                    logger.error("Image file missing during tagging: %s", img["path"])
                    send_with_eta(
                        f"Processed {total_processed}/{total} ({total_tagged} tagged{f', {total_errors} failed' if total_errors else ''})",
                    )

            if existing_images:
                processed_in_batch = 0
                try:
                    # Elastic batch sizing: check memory and reduce batch if under pressure
                    try:
                        from hardware_monitor import check_memory_pressure
                        pressure = check_memory_pressure()
                        if pressure.get("should_restart_session"):
                            tagger._recreate_session()
                        ram_avail = pressure.get("ram_available_gb")
                        if pressure.get("should_pause"):
                            logger.warning("Memory pressure critical (RAM: %.1fGB). Pausing 2s and reducing batch.", ram_avail or 0)
                            time.sleep(2)
                            gc.collect()
                            batch_size = max(1, batch_size // 2)
                        elif ram_avail is not None and ram_avail < 2.0 and batch_size > 2:
                            logger.info("Low RAM (%.1fGB available). Reducing batch size %d -> %d.", ram_avail, batch_size, max(2, batch_size // 2))
                            batch_size = max(2, batch_size // 2)
                    except Exception:
                        pass  # hardware_monitor not available

                    # Show which images are being tagged
                    first_name = os.path.basename(existing_images[0]["path"])
                    if len(existing_images) > 1:
                        last_name = os.path.basename(existing_images[-1]["path"])
                        send(
                            "running",
                            f"Tagging {total_processed + 1}-{total_processed + len(existing_images)}/{total}: {first_name} ... {last_name}",
                        )
                    else:
                        send(
                            "running",
                            f"Tagging {total_processed + 1}/{total}: {first_name}",
                        )
                    batch_results, runtime_info = tagger.tag_batch(
                        batch_paths,
                        preferred_batch_size=batch_size,
                        min_batch_size=1,
                        return_runtime_info=True,
                    )

                    runtime_adjustment_message = _format_runtime_adjustment_message(runtime_info)
                    if runtime_adjustment_message:
                        send("running", f"Adaptive runtime: {runtime_adjustment_message}")

                    if effective_use_gpu and not gpu_fallback_announced and not getattr(tagger, "use_gpu", False):
                        gpu_fallback_announced = True
                        send(
                            "running",
                            "GPU became unstable during inference. Continuing in CPU Safe Mode...",
                        )

                    for img, result in zip(existing_images, batch_results):
                        if cancel_event.is_set():
                            break

                        if result.get("error"):
                            total_errors += 1
                            logger.error("Error tagging %s: %s", img["path"], result["error"])
                        else:
                            entry = {
                                "image_id": img["id"],
                                "tags": result["all_tags"],
                            }
                            if result.get("raw_text"):
                                entry["ai_caption"] = result["raw_text"]
                            tags_batch.append(entry)
                            total_tagged += 1

                        total_processed += 1
                        processed_in_batch += 1
                        current_filename = os.path.basename(img["path"])
                        send_with_eta(
                            f"{total_processed}/{total} ({total_tagged} tagged{f', {total_errors} failed' if total_errors else ''}) - {current_filename}",
                        )

                        if len(tags_batch) >= commit_interval:
                            worker_db.add_tags_batch(tags_batch)
                            tags_batch = []

                        if total_processed % gc_interval == 0:
                            gc.collect()
                            if cpu_pause_seconds > 0:
                                time.sleep(cpu_pause_seconds)
                except Exception as error:
                    logger.error("Error tagging batch starting at %s: %s", batch_start, error)
                    remaining = len(existing_images) - processed_in_batch
                    total_errors += remaining
                    total_processed += remaining
                    send(
                        "running",
                        f"Processed {total_processed}/{total} ({total_tagged} tagged, {total_errors} failed)",
                    )

            if tags_batch:
                worker_db.add_tags_batch(tags_batch)
                tags_batch = []

            del batch_images
            gc.collect()
            if cpu_pause_seconds > 0:
                time.sleep(cpu_pause_seconds)

        if cancel_event.is_set():
            send(
                "cancelled",
                f"Tagging cancelled. Processed {total_processed}/{total} images.",
            )
            return

        send(
            "done",
            f"Completed! Processed {total_processed} images: {total_tagged} tagged" + (f", {total_errors} failed." if total_errors else "."),
        )
    except Exception as error:
        send("error", f"Error: {error}")


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
    allow_unsafe_acceleration: bool = False
    batch_size: Optional[int] = Field(default=None, ge=1, le=128)


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
        self._progress: Dict[str, Any] = _build_tag_progress_state("idle")
        self._lock = threading.Lock()
        self._get_tagger: Optional[Callable] = None
        self._cancel_requested = False
        self._worker_process: Optional[Any] = None
        self._worker_cancel_event: Optional[Any] = None

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
            if self._worker_process and self._worker_process.is_alive():
                return {"status": self._progress["status"], "message": "Cannot reset while the tagger worker is still running"}
            if self._progress["status"] in {"running", "cancelling", "error", "done", "cancelled"}:
                self._progress = _build_tag_progress_state("idle", message="Reset by user")
                self._cancel_requested = False
                self._worker_process = None
                self._worker_cancel_event = None
                return {"status": "reset", "message": "Tagging progress reset to idle"}
            return {"status": self._progress["status"], "message": "Nothing to reset"}

    def cancel_tagging(self) -> Dict[str, Any]:
        """Request cooperative cancellation of the current tagging task."""
        with self._lock:
            if self._progress["status"] not in {"running", "cancelling"}:
                return {"status": self._progress["status"], "message": "No tagging task is running"}

            self._cancel_requested = True
            if self._worker_cancel_event is not None:
                self._worker_cancel_event.set()
            self._progress["status"] = "cancelling"
            current = self._progress.get("current", 0)
            total = self._progress.get("total", 0)
            self._progress["message"] = f"Cancelling... ({current}/{total})"

            worker = self._worker_process

        # If the worker is alive, give it a short grace period then forcefully terminate
        if worker is not None and worker.is_alive():
            worker.join(timeout=3.0)
            if worker.is_alive():
                logger.warning("Tagger worker did not stop cooperatively, terminating process.")
                try:
                    worker.terminate()
                    worker.join(timeout=5.0)
                except Exception as exc:
                    logger.error("Error terminating tagger worker: %s", exc)
                    try:
                        worker.kill()
                    except Exception:
                        pass
                with self._lock:
                    self._progress = _build_tag_progress_state(
                        "cancelled",
                        current=current,
                        total=total,
                        tagged=self._progress.get("tagged", 0),
                        errors=self._progress.get("errors", 0),
                        message=f"Tagging forcefully cancelled at {current}/{total}.",
                    )
                    self._worker_process = None
                    self._worker_cancel_event = None

        return {"status": "cancelling", "message": "Cancellation requested"}

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

    def _resolve_model_name(self, request: TagRequest) -> str:
        """Resolve the effective built-in model name for a request."""
        return (request.model_name or DEFAULT_TAGGER_MODEL).strip()

    def _validate_tag_request(self, request: TagRequest) -> None:
        """Reject unsafe or invalid tagger combinations before background work starts."""
        if request.model_path:
            model_ext = os.path.splitext(request.model_path)[1].lower()
            if model_ext != ".onnx":
                raise HTTPException(
                    status_code=400,
                    detail="Custom tagger model must be an .onnx file.",
                )

        if request.tags_path:
            tags_ext = os.path.splitext(request.tags_path)[1].lower()
            if tags_ext != ".csv":
                raise HTTPException(
                    status_code=400,
                    detail="Custom tags file must be a .csv file.",
                )

        model_name = self._resolve_model_name(request)
        if not request.model_path and model_name not in TAGGER_MODELS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown tagger model: {model_name}",
            )

        if not request.model_path:
            model_config = TAGGER_MODELS.get(model_name, {})
            if model_config.get("disabled"):
                raise HTTPException(
                    status_code=409,
                    detail=model_config.get("disabled_reason") or f"Model {model_name} is not available in the current build.",
                )

    def _build_runtime_plan(self, request: TagRequest) -> Dict[str, Any]:
        """Translate a public tag request into a high-throughput runtime plan with adaptive safety."""
        from hardware_monitor import get_system_info, recommend_tagger_config

        model_name = self._resolve_model_name(request)
        model_config = TAGGER_MODELS.get(model_name, {})
        runtime_backend = str(model_config.get("runtime_backend", "wd14")).lower()
        effective_use_gpu = bool(request.use_gpu)
        startup_notice = ""
        fetch_batch_size = 16 if effective_use_gpu else 8
        commit_interval = fetch_batch_size
        gc_interval = max(4, fetch_batch_size)
        cpu_pause_seconds = 0.0
        session_refresh_interval = 180 if effective_use_gpu else 0
        requested_chunk_size = int(request.batch_size) if request.batch_size else None

        system_info = get_system_info()
        hardware_rec = recommend_tagger_config(system_info, model_name=model_name, use_gpu=effective_use_gpu)

        if runtime_backend == "toriigate":
            if effective_use_gpu:
                fetch_batch_size = 2 if (hardware_rec.get("recommended_use_gpu") and (system_info.get("gpu_vram_total_mb") or 0) >= 16000) else 1
                session_refresh_interval = 0
                startup_notice = (
                    "ToriiGate runs through the multimodal caption backend. "
                    "GPU is strongly recommended, and runtime chunk size stays intentionally small to avoid VRAM spikes."
                )
            else:
                fetch_batch_size = 1
                cpu_pause_seconds = 0.0
                session_refresh_interval = 0
                startup_notice = (
                    "ToriiGate is running on CPU. This is valid but much slower than the CUDA path."
                )
        elif effective_use_gpu:
            fetch_batch_size = int(hardware_rec.get("recommended_batch_size") or fetch_batch_size)
            session_refresh_interval = int(hardware_rec.get("recommended_session_refresh_interval") or session_refresh_interval)
        else:
            fetch_batch_size = min(CPU_CHUNK_MAX, max(4, int(hardware_rec.get("recommended_cpu_chunk_size") or 12)))
            cpu_pause_seconds = 0.01 if fetch_batch_size >= 24 else 0.0

        if request.model_path:
            fetch_batch_size = min(fetch_batch_size, TRUE_BATCH_MODEL_MAX if effective_use_gpu else CPU_CHUNK_MAX)
        elif runtime_backend == "toriigate":
            fetch_batch_size = min(fetch_batch_size, TORIIGATE_GPU_CHUNK_MAX if effective_use_gpu else 1)

        if requested_chunk_size:
            if runtime_backend == "toriigate":
                chunk_cap = TORIIGATE_GPU_CHUNK_MAX if effective_use_gpu else 1
            else:
                chunk_cap = TRUE_BATCH_MODEL_MAX if effective_use_gpu else CPU_CHUNK_MAX
            applied_chunk_size = max(1, min(requested_chunk_size, chunk_cap))
            if applied_chunk_size != requested_chunk_size:
                clamp_notice = (
                    f"Requested runtime chunk size {requested_chunk_size} was reduced to {applied_chunk_size} "
                    "to stay inside the supported runtime range."
                )
                startup_notice = f"{startup_notice} {clamp_notice}".strip()

            fetch_batch_size = applied_chunk_size
        elif runtime_backend == "toriigate":
            startup_notice = startup_notice or (
                "ToriiGate uses the multimodal caption runtime. The app keeps the queue chunk small so long runs stay stable."
            )
        elif effective_use_gpu:
            startup_notice = (
                "Auto runtime is using the highest batched throughput this hardware profile should hold for long runs."
            )
        else:
            startup_notice = "CPU mode is using a larger worker chunk because true multi-image GPU batching is not active."

        commit_interval = max(1, min(fetch_batch_size, 10))
        gc_interval = max(4, min(fetch_batch_size, 8))

        runtime_request = request.model_copy(
            update={
                "use_gpu": effective_use_gpu,
                "allow_unsafe_acceleration": request.allow_unsafe_acceleration,
            }
        )

        return {
            "request": runtime_request.model_dump(mode="python"),
            "model_name": model_name,
            "effective_use_gpu": effective_use_gpu,
            "gpu_locked": False,
            "startup_notice": startup_notice,
            "fetch_batch_size": fetch_batch_size,
            "commit_interval": commit_interval,
            "gc_interval": gc_interval,
            "cpu_pause_seconds": cpu_pause_seconds,
            "session_refresh_interval": session_refresh_interval,
        }

    def _apply_worker_progress(self, payload: Dict[str, Any]) -> None:
        """Merge a worker progress message into shared service state."""
        with self._lock:
            self._progress = {
                "status": payload.get("status", self._progress.get("status", "idle")),
                "current": payload.get("current", self._progress.get("current", 0)),
                "processed": payload.get("processed", payload.get("current", self._progress.get("processed", 0))),
                "total": payload.get("total", self._progress.get("total", 0)),
                "tagged": payload.get("tagged", self._progress.get("tagged", 0)),
                "errors": payload.get("errors", self._progress.get("errors", 0)),
                "message": payload.get("message", self._progress.get("message", "")),
            }

    def _drain_worker_queue(self, progress_queue: Any) -> bool:
        """Drain queued worker progress messages. Returns True if a terminal state was seen."""
        saw_terminal_state = False
        while True:
            try:
                payload = progress_queue.get_nowait()
            except queue_module.Empty:
                break
            self._apply_worker_progress(payload)
            if payload.get("status") in {"done", "error", "cancelled"}:
                saw_terminal_state = True
        return saw_terminal_state

    def _cleanup_worker_handles(self, progress_queue: Any = None) -> None:
        """Clear worker references and close IPC handles when possible."""
        with self._lock:
            self._worker_process = None
            self._worker_cancel_event = None
            if self._progress["status"] != "cancelling":
                self._cancel_requested = False

        if progress_queue is not None:
            close = getattr(progress_queue, "close", None)
            if callable(close):
                close()
            join_thread = getattr(progress_queue, "join_thread", None)
            if callable(join_thread):
                join_thread()

    def _run_tagging_job(self, request: TagRequest) -> None:
        """Run a tagging job in an isolated worker process and mirror progress back to the API."""
        runtime_plan = self._build_runtime_plan(request)
        ctx = multiprocessing.get_context("spawn")
        progress_queue = ctx.Queue()
        cancel_event = ctx.Event()
        worker_process = ctx.Process(
            target=_tagging_worker_main,
            args=(runtime_plan, progress_queue, cancel_event),
            daemon=True,
        )

        with self._lock:
            self._progress = _build_tag_progress_state("running", message="Preparing tagger...")
            self._worker_process = worker_process
            self._worker_cancel_event = cancel_event
            self._cancel_requested = False

        saw_terminal_state = False

        try:
            worker_process.start()
            while True:
                if self._cancel_requested:
                    cancel_event.set()

                try:
                    payload = progress_queue.get(timeout=0.25)
                    self._apply_worker_progress(payload)
                    if payload.get("status") in {"done", "error", "cancelled"}:
                        saw_terminal_state = True
                except queue_module.Empty:
                    pass

                if not worker_process.is_alive():
                    saw_terminal_state = self._drain_worker_queue(progress_queue) or saw_terminal_state
                    break

                if saw_terminal_state:
                    worker_process.join(timeout=2.0)
                    saw_terminal_state = self._drain_worker_queue(progress_queue) or saw_terminal_state
                    if not worker_process.is_alive():
                        break

            worker_process.join(timeout=1.0)

            if not saw_terminal_state:
                current_state = self.get_progress()
                if self._cancel_requested:
                    self._apply_worker_progress(
                        _build_tag_progress_state(
                            "cancelled",
                            current=current_state.get("processed", 0),
                            total=current_state.get("total", 0),
                            tagged=current_state.get("tagged", 0),
                            errors=current_state.get("errors", 0),
                            message="Tagging worker stopped during cancellation.",
                        )
                    )
                else:
                    self._apply_worker_progress(
                        _build_tag_progress_state(
                            "error",
                            current=current_state.get("processed", 0),
                            total=current_state.get("total", 0),
                            tagged=current_state.get("tagged", 0),
                            errors=current_state.get("errors", 0),
                            message="Tagger worker crashed unexpectedly. The app stayed alive, but this tagging run was stopped.",
                        )
                    )
        except Exception as error:
            current_state = self.get_progress()
            self._apply_worker_progress(
                _build_tag_progress_state(
                    "error",
                    current=current_state.get("processed", 0),
                    total=current_state.get("total", 0),
                    tagged=current_state.get("tagged", 0),
                    errors=current_state.get("errors", 0),
                    message=f"Error monitoring tagging worker: {error}",
                )
            )
        finally:
            self._cleanup_worker_handles(progress_queue)

    def start_tagging(
        self,
        request: TagRequest,
        background_tasks: BackgroundTasks
    ) -> Dict[str, str]:
        """Start tagging images with WD14 tagger."""
        if self._progress["status"] in {"running", "cancelling"}:
            raise HTTPException(status_code=400, detail="Tagging already in progress")

        self._validate_tag_request(request)

        if self._get_tagger is None:
            raise HTTPException(status_code=500, detail="Tagger not initialized")
        background_tasks.add_task(self._run_tagging_job, request)
        return {"status": "started", "message": "Tagging started in background"}

    def export_tags_batch(self, request: BatchTagExportRequest) -> Dict[str, Any]:
        """Export tags for each image to individual .txt files."""
        from utils.path_validation import validate_folder_path

        is_valid, error = validate_folder_path(request.output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error)

        exported = 0
        errors = 0
        used_output_paths = set()
        output_folder_ready = os.path.isdir(request.output_folder)

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
                file_content = ", ".join(filtered_tags)
                if request.prefix:
                    file_content = f"{request.prefix}{file_content}" if file_content else request.prefix

                basename = os.path.splitext(image["filename"])[0]
                candidate_names = [f"{basename}.txt", f"{image['filename']}.txt"]
                txt_path = None

                for candidate_name in candidate_names:
                    candidate_path = os.path.join(request.output_folder, candidate_name)
                    if candidate_path not in used_output_paths and not os.path.exists(candidate_path):
                        txt_path = candidate_path
                        break

                if txt_path is None:
                    stem = image["filename"]
                    counter = 1
                    while True:
                        candidate_path = os.path.join(request.output_folder, f"{stem}_{counter}.txt")
                        if candidate_path not in used_output_paths and not os.path.exists(candidate_path):
                            txt_path = candidate_path
                            break
                        counter += 1

                if not output_folder_ready:
                    try:
                        os.makedirs(request.output_folder, exist_ok=True)
                    except OSError as exc:
                        raise HTTPException(status_code=400, detail=f"Cannot create output folder: {exc}") from exc
                    output_folder_ready = True

                with open(txt_path, "w", encoding="utf-8") as f:
                    f.write(file_content)

                used_output_paths.add(txt_path)
                exported += 1
            except HTTPException:
                raise
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
