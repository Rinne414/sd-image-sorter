"""
Tagging service for SD Image Sorter.

Handles business logic for AI tagging, tag management, and import/export.
"""
import logging
import os
import gc
import time
import threading
import queue as queue_module
import multiprocessing
from pathlib import Path
from typing import Optional, List, Dict, Any, Callable

from fastapi import HTTPException, BackgroundTasks
from pydantic import BaseModel, Field, field_validator

import database as db
from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS
from image_fingerprint import compute_image_content_fingerprint
from metadata_parser import verify_image_readable
from services.state_compat import MutableStateProxy
from services.tag_export_service import export_tags_batch_request
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)

# Validation constants
THRESHOLD_MIN = 0.0
THRESHOLD_MAX = 1.0
PATH_MAX_LENGTH = 4096
BATCH_EXPORT_LIMIT = 10000
VALID_SORT_OPTIONS = ["frequency", "alphabetical"]
TRUE_BATCH_MODEL_MAX = 32
CPU_CHUNK_MAX = 64
TORIIGATE_GPU_CHUNK_MAX = 1
TORIIGATE_LOAD_HEARTBEAT_SECONDS = 5.0

TAGGER_MODEL_HINTS = {
    "wd-eva02-large-tagger-v3": {
        "summary": "Most accurate overall. The app now drives it with adaptive runtime limits instead of a fixed conservative lock.",
        "speed": "Slow",
        "memory": "High",
        "best_for": "Max Quality / final library cleanup",
        "safe_mode_note": "Adaptive runtime keeps GPU throughput high first, while automatic hardware clamps still cap the true batch size for long runs.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive max-throughput runtime. Highest quality without a fixed CPU lock.",
        "quality_score": 5,
        "speed_score": 3,
        "stability_score": 3,
    },
    "wd-swinv2-tagger-v3": {
        "summary": "Balanced quality and speed. Good default if you are not sure.",
        "speed": "Medium",
        "memory": "Medium",
        "best_for": "Recommended general use",
        "recommended": True,
        "safe_mode_note": "Usually fine on average PCs. Safe Mode is optional.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 4,
        "speed_score": 4,
        "stability_score": 4,
    },
    "wd-convnext-tagger-v3": {
        "summary": "Faster than the larger models while keeping decent tagging quality.",
        "speed": "Medium-fast",
        "memory": "Medium",
        "best_for": "Daily tagging on average PCs",
        "safe_mode_note": "A good fallback when EVA02 feels too heavy.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 3,
        "speed_score": 4,
        "stability_score": 4,
    },
    "wd-vit-tagger-v3": {
        "summary": "Lightweight and quick, but less accurate than the larger models.",
        "speed": "Fast",
        "memory": "Low",
        "best_for": "Weak machines / fastest pass",
        "safe_mode_note": "Best pick for weak machines. CPU Safe Mode works well here.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 2,
        "speed_score": 5,
        "stability_score": 5,
    },
    "wd-vit-large-tagger-v3": {
        "summary": "A middle ground between ViT speed and EVA02 accuracy.",
        "speed": "Medium",
        "memory": "Medium-high",
        "best_for": "Better accuracy without going full EVA02",
        "safe_mode_note": "Use Safe Mode if you notice freezes during model load.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 4,
        "speed_score": 3,
        "stability_score": 3,
    },
    "camie-tagger-v2": {
        "summary": "Much newer danbooru-era tag space. Strong artist / character / copyright coverage, but it can emit many more tags if the threshold is set too low.",
        "speed": "Medium-slow",
        "memory": "High",
        "best_for": "Modern tag coverage / deeper library enrichment",
        "safe_mode_note": "Camie uses ImageNet normalization and a much larger tag space. Keep the higher default threshold unless you intentionally want denser tags.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive runtime with denser modern tags. Better coverage than older WD models, but heavier and noisier if you lower the threshold too much.",
        "quality_score": 5,
        "speed_score": 2,
        "stability_score": 3,
    },
    "pixai-tagger-v0.9": {
        "summary": "PixAI v0.9 ONNX export with a newer tag space than classic WD models. Strong for modern danbooru-style tagging, and the app now fills rating from a local fallback so library workflows stay complete.",
        "speed": "Medium-slow",
        "memory": "High",
        "best_for": "Modern general + character tags with lower default threshold",
        "safe_mode_note": "Uses direct 448 resize and [-1, 1] normalization. This ONNX export has no native rating head, so the app derives a practical rating fallback from the returned tags.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive runtime with newer PixAI tags. Heavier than the small WD models and should still be watched on long GPU runs.",
        "quality_score": 5,
        "speed_score": 2,
        "stability_score": 3,
    },
    "toriigate-0.5": {
        "summary": "Large anime-art multimodal caption tagger with strong NSFW, character, and copyright knowledge.",
        "speed": "Slow",
        "memory": "Very high",
        "best_for": "Rich VLM tagging / difficult anime image understanding",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Runs through the dedicated Transformers VLM backend instead of the WD14 ONNX runtime. GPU is strongly recommended, and the app still clamps chunk size to the safe range.",
        "quality_score": 5,
        "speed_score": 1,
        "stability_score": 2,
    },
}


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


def _iter_rescaling_batches(all_ids, get_batch_size):
    """Yield (batch_start, batch_ids) slices while re-reading batch_size.

    The worker mutates batch_size mid-run whenever memory pressure hits, but
    ``range(0, total, batch_size)`` captures its step at creation time — so the
    old for-range loop kept stepping by the ORIGINAL batch_size and silently
    skipped images after a reduction. This helper re-queries the current size
    each iteration and advances by the actual slice length so every id is
    visited exactly once, regardless of how many times batch_size shrinks.
    """
    batch_start = 0
    total = len(all_ids)
    while batch_start < total:
        batch_size = max(1, int(get_batch_size()))
        batch_ids = all_ids[batch_start:batch_start + batch_size]
        if not batch_ids:
            break
        yield batch_start, batch_ids
        batch_start += len(batch_ids)


def _build_tag_progress_state(
    status: str,
    current: int = 0,
    total: int = 0,
    tagged: int = 0,
    errors: int = 0,
    message: str = "",
    runtime_backend_target: str = "",
    runtime_backend_actual: str = "",
    runtime_backend_reason: str = "",
    memory_pressure_warning: str = "",
    run_id: int = 0,
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
        "runtime_backend_target": runtime_backend_target,
        "runtime_backend_actual": runtime_backend_actual,
        "runtime_backend_reason": runtime_backend_reason,
        "memory_pressure_warning": memory_pressure_warning,
        "run_id": run_id,
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
    runtime_backend_target = "gpu" if effective_use_gpu else "cpu"
    # Don't claim an actual backend until the tagger is actually loaded. ONNX Runtime
    # silently falls back to CPU when CUDA init fails (no exception), so reading
    # session.get_providers() post-load is the only honest source of truth. Leaving
    # this blank during the load phase makes the UI show "GPU Target" (from checkbox)
    # instead of lying with "GPU target -> GPU actual" before the session exists.
    runtime_backend_actual = ""
    runtime_backend_reason = ""
    memory_pressure_warning = ""

    def infer_runtime_reason() -> str:
        try:
            from hardware_monitor import get_system_info

            system_info = get_system_info()
        except Exception:
            system_info = {}

        if runtime_backend == "toriigate":
            if not system_info.get("torch_cuda_available"):
                return "CUDA is unavailable or this build only has the CPU PyTorch runtime."
            return "ToriiGate failed to stay on CUDA and fell back to CPU."

        providers = [str(item).lower() for item in (system_info.get("onnx_providers") or [])]
        if not any(provider in providers for provider in ["cudaexecutionprovider", "dmlexecutionprovider", "tensorrtexecutionprovider"]):
            return "The ONNX runtime has no GPU provider on this machine."
        return "The GPU provider failed, so the run continued in CPU Safe Mode."

    def send(
        status: str,
        message: str,
        current: Optional[int] = None,
        total_override: Optional[int] = None,
    ) -> None:
        progress_queue.put(
            _build_tag_progress_state(
                status=status,
                current=total_processed if current is None else current,
                total=total if total_override is None else total_override,
                tagged=total_tagged,
                errors=total_errors,
                message=message,
                runtime_backend_target=runtime_backend_target,
                runtime_backend_actual=runtime_backend_actual,
                runtime_backend_reason=runtime_backend_reason,
                memory_pressure_warning=memory_pressure_warning,
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
        elif runtime_backend == "toriigate":
            # ToriiGate first-use pulls Qwen2.5-VL (~5 GB). Detect the empty
            # cache and surface a clear size warning BEFORE the download starts
            # so users on slow / metered links know what is about to happen.
            try:
                from config import get_toriigate_model_dir
                cache_root = Path(get_toriigate_model_dir()) / effective_model_name
                already_cached = (cache_root / "config.json").exists()
            except Exception:
                already_cached = False
            if not already_cached:
                send(
                    "running",
                    "First-time ToriiGate download: ~5 GB from HuggingFace. "
                    "This runs once; keep the app open until it completes.",
                )
            else:
                send(
                    "running",
                    f"Loading ToriiGate on {'GPU' if effective_use_gpu else 'CPU'}...",
                )
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
            from ai_runtime_guard import exclusive_ai_runtime

            with exclusive_ai_runtime(f"tagger-load:{effective_model_name}"):
                tagger.load()

        if hasattr(tagger, "set_session_refresh_interval"):
            tagger.set_session_refresh_interval(session_refresh_interval)

        runtime_backend_actual = "gpu" if getattr(tagger, "use_gpu", False) else "cpu"
        if runtime_backend_actual == "gpu":
            runtime_backend_reason = "The runtime loaded successfully on GPU."
        elif effective_use_gpu:
            runtime_backend_reason = infer_runtime_reason()
        else:
            runtime_backend_reason = "CPU Safe Mode was requested for this run."

        if startup_notice:
            send("running", startup_notice)

        if effective_use_gpu and not getattr(tagger, "use_gpu", False):
            gpu_fallback_announced = True
            send(
                "running",
                f"GPU load failed. Continuing in CPU Safe Mode instead. Reason: {runtime_backend_reason}",
            )

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

        # Use _iter_rescaling_batches so memory-pressure reductions to batch_size
        # take effect on the very next iteration. A plain range(0, total, batch_size)
        # would capture the step at creation and skip images whenever the chunk
        # shrank mid-run.
        for batch_start, batch_ids in _iter_rescaling_batches(all_ids, lambda: batch_size):
            if cancel_event.is_set():
                break

            batch_images_map = worker_db.get_images_by_ids(batch_ids)
            batch_images = [img for img in batch_images_map.values() if img]

            existing_images: List[Dict[str, Any]] = []
            batch_paths: List[str] = []

            for img in batch_images:
                image_path = img["path"]
                resolved_path = resolve_existing_indexed_image_path(image_path, backend_file=__file__)
                image_name = os.path.basename(resolved_path or image_path)
                if not resolved_path:
                    total_errors += 1
                    total_processed += 1
                    worker_db.mark_image_unreadable(img["id"], "File not found")
                    logger.error("Image file missing during tagging: %s", image_path)
                    send_with_eta(
                        f"Skipped unreadable image: {image_name} (File not found)",
                    )
                    continue

                readable, read_error = verify_image_readable(resolved_path)
                if not readable:
                    total_errors += 1
                    total_processed += 1
                    worker_db.mark_image_unreadable(img["id"], read_error or "Unreadable image")
                    logger.warning("Skipping unreadable image during tagging: %s (%s)", image_path, read_error)
                    send_with_eta(
                        f"Skipped unreadable image: {image_name} ({read_error or 'Unreadable image'})",
                    )
                    continue

                existing_images.append({**img, "_resolved_path": resolved_path})
                batch_paths.append(resolved_path)

            if existing_images:
                processed_in_batch = 0
                try:
                    # Elastic batch sizing: check memory and reduce batch if under pressure
                    try:
                        from hardware_monitor import check_memory_pressure
                        pressure = check_memory_pressure()
                        if pressure.get("should_restart_session"):
                            tagger._recreate_session()
                            memory_pressure_warning = "VRAM pressure forced a runtime session refresh."
                            send("running", memory_pressure_warning)
                        ram_avail = pressure.get("ram_available_gb")
                        ram_total = pressure.get("ram_total_gb")
                        ram_pct = pressure.get("ram_percent_used")
                        if pressure.get("should_pause"):
                            logger.warning(
                                "Memory pressure critical (RAM: %.1f/%.1f GB, %.0f%% used). Pausing 2s and reducing batch.",
                                ram_avail or 0, ram_total or 0, ram_pct or 0,
                            )
                            if ram_avail is not None and ram_total is not None:
                                memory_pressure_warning = (
                                    f"Memory pressure is critical "
                                    f"({ram_avail:.1f} of {ram_total:.1f} GB RAM free, {ram_pct:.0f}% used). "
                                    f"Pausing briefly and reducing chunk size."
                                )
                            else:
                                memory_pressure_warning = "Memory pressure is critical. Pausing briefly and reducing chunk size."
                            send("running", memory_pressure_warning)
                            time.sleep(2)
                            gc.collect()
                            batch_size = max(1, batch_size // 2)
                        elif ram_pct is not None and ram_pct >= 90.0 and batch_size > 2:
                            reduced = max(2, batch_size // 2)
                            logger.info(
                                "High RAM usage (%.0f%% used, %.1f/%.1f GB free). Reducing batch size %d -> %d.",
                                ram_pct, ram_avail or 0, ram_total or 0, batch_size, reduced,
                            )
                            if ram_avail is not None and ram_total is not None:
                                memory_pressure_warning = (
                                    f"High RAM usage ({ram_pct:.0f}% used, {ram_avail:.1f} of {ram_total:.1f} GB free). "
                                    f"Reducing chunk size to {reduced}."
                                )
                            else:
                                memory_pressure_warning = f"High RAM usage detected. Reducing chunk size to {reduced}."
                            send("running", memory_pressure_warning)
                            batch_size = reduced
                    except Exception:
                        pass  # hardware_monitor not available

                    # Show which images are being tagged
                    first_name = os.path.basename(batch_paths[0])
                    if len(existing_images) > 1:
                        last_name = os.path.basename(batch_paths[-1])
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

                    if runtime_info.get("used_cpu_fallback"):
                        runtime_backend_actual = "cpu"
                        runtime_backend_reason = "GPU inference became unstable, so the run continued on CPU Safe Mode."

                    if effective_use_gpu and not gpu_fallback_announced and not getattr(tagger, "use_gpu", False):
                        gpu_fallback_announced = True
                        runtime_backend_actual = "cpu"
                        runtime_backend_reason = "GPU inference became unstable, so the run continued on CPU Safe Mode."
                        send(
                            "running",
                            f"GPU became unstable during inference. Continuing in CPU Safe Mode... Reason: {runtime_backend_reason}",
                        )

                    for img, result in zip(existing_images, batch_results):
                        if cancel_event.is_set():
                            break

                        if result.get("error"):
                            total_errors += 1
                            logger.error("Error tagging %s: %s", img.get("_resolved_path") or img["path"], result["error"])
                        else:
                            content_fingerprint = None
                            resolved_path = img.get("_resolved_path") or img["path"]
                            try:
                                content_fingerprint = compute_image_content_fingerprint(resolved_path)
                            except Exception as exc:
                                logger.warning("Could not compute content fingerprint for %s: %s", resolved_path, exc)
                            entry = {
                                "image_id": img["id"],
                                "tags": result["all_tags"],
                                "content_fingerprint": content_fingerprint,
                            }
                            if result.get("raw_text"):
                                entry["ai_caption"] = result["raw_text"]
                            tags_batch.append(entry)
                            total_tagged += 1

                        total_processed += 1
                        processed_in_batch += 1
                        current_filename = os.path.basename(img.get("_resolved_path") or img["path"])
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
    """Request model for batch sidecar export."""
    image_ids: List[int] = Field(..., min_length=1, max_length=BATCH_EXPORT_LIMIT)
    output_folder: str = Field(..., max_length=PATH_MAX_LENGTH)
    blacklist: Optional[List[str]] = Field(default=[], max_length=500)
    prefix: Optional[str] = Field(default="", max_length=256)
    content_mode: str = Field(default="tags", max_length=32)
    overwrite_policy: str = Field(default="unique", max_length=16)


class TaggingService:
    """Service for AI tagging and tag management."""

    def __init__(self):
        """Initialize the tagging service."""
        self._progress: Dict[str, Any] = _build_tag_progress_state("idle")
        self._lock = threading.Lock()
        self._progress_proxy = MutableStateProxy(self.get_progress, self.set_progress)
        self._get_tagger: Optional[Callable] = None
        self._cancel_requested = False
        self._worker_process: Optional[Any] = None
        self._worker_cancel_event: Optional[Any] = None
        self._active_run_id = 0

    @staticmethod
    def _coerce_progress_state(state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize externally injected progress state onto the canonical shape."""
        state = state or {}
        coerced = _build_tag_progress_state(
            str(state.get("status", "idle")),
            current=int(state.get("current", 0) or 0),
            total=int(state.get("total", 0) or 0),
            tagged=int(state.get("tagged", 0) or 0),
            errors=int(state.get("errors", 0) or 0),
            message=str(state.get("message", "") or ""),
            runtime_backend_target=str(state.get("runtime_backend_target", "") or ""),
            runtime_backend_actual=str(state.get("runtime_backend_actual", "") or ""),
            runtime_backend_reason=str(state.get("runtime_backend_reason", "") or ""),
            memory_pressure_warning=str(state.get("memory_pressure_warning", "") or ""),
            run_id=int(state.get("run_id", 0) or 0),
        )
        if "processed" in state:
            coerced["processed"] = int(state.get("processed", coerced["current"]) or 0)
        return coerced

    def set_tagger_getter(self, tagger_getter: Callable) -> None:
        """Set the tagger getter function from main module."""
        self._get_tagger = tagger_getter

    def get_progress(self) -> Dict[str, Any]:
        """Get the current tagging progress state."""
        with self._lock:
            return self._progress.copy()

    def get_progress_proxy(self) -> MutableStateProxy:
        """Expose the legacy dict-style progress handle without moving ownership out of the service."""
        return self._progress_proxy

    def set_progress(self, state: Dict[str, Any]) -> None:
        """Set the tag progress state."""
        with self._lock:
            self._progress = self._coerce_progress_state(state)

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
            tagged = self._progress.get("tagged", 0)
            errors = self._progress.get("errors", 0)
            run_id = int(self._progress.get("run_id") or self._active_run_id or 0)
            self._progress["message"] = f"Cancelling... ({current}/{total})"

            worker = self._worker_process

        worker_stopped = worker is None
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
            worker_stopped = not worker.is_alive()

        if worker_stopped:
            with self._lock:
                if run_id == self._active_run_id:
                    self._progress = _build_tag_progress_state(
                        "cancelled",
                        current=current,
                        total=total,
                        tagged=tagged,
                        errors=errors,
                        message=f"Tagging cancelled at {current}/{total}.",
                        run_id=run_id,
                    )
                    self._worker_process = None
                    self._worker_cancel_event = None
            return {"status": "cancelled", "message": "Tagging cancelled"}

        return {"status": "cancelling", "message": "Cancellation requested"}

    def get_all_tags(self, limit: int = 500) -> Dict[str, Any]:
        """Get all unique tags with occurrence counts."""
        tags = db.get_all_tags()
        return {"tags": tags[:limit]}

    def get_generators(self) -> Dict[str, Any]:
        """Get all generators with image counts."""
        generators = db.get_all_generators()
        return {"generators": generators}

    def get_tagger_models(self) -> Dict[str, Any]:
        """Return tagger model catalog with UI/runtime guidance."""
        models = [
            {
                "name": name,
                "path": config["repo_id"],
                "description": TAGGER_MODEL_HINTS.get(name, {}).get("summary", f"{name} model"),
                "disabled": bool(config.get("disabled") or TAGGER_MODEL_HINTS.get(name, {}).get("disabled", False)),
                "disabled_reason": config.get("disabled_reason", ""),
                "default_threshold": config.get("default_threshold"),
                "default_character_threshold": config.get("default_character_threshold"),
                "speed": TAGGER_MODEL_HINTS.get(name, {}).get("speed", "Unknown"),
                "memory": TAGGER_MODEL_HINTS.get(name, {}).get("memory", "Unknown"),
                "best_for": TAGGER_MODEL_HINTS.get(name, {}).get("best_for", "General use"),
                "recommended": TAGGER_MODEL_HINTS.get(name, {}).get("recommended", False),
                "safe_mode_note": TAGGER_MODEL_HINTS.get(name, {}).get("safe_mode_note", "Use Safe Mode if your PC becomes unstable."),
                "gpu_default": TAGGER_MODEL_HINTS.get(name, {}).get("gpu_default", True),
                "gpu_confirmation_required": TAGGER_MODEL_HINTS.get(name, {}).get("gpu_confirmation_required", False),
                "gpu_locked": TAGGER_MODEL_HINTS.get(name, {}).get("gpu_locked", False),
                "runtime_note": TAGGER_MODEL_HINTS.get(name, {}).get("runtime_note", ""),
                "quality_score": TAGGER_MODEL_HINTS.get(name, {}).get("quality_score", 3),
                "speed_score": TAGGER_MODEL_HINTS.get(name, {}).get("speed_score", 3),
                "stability_score": TAGGER_MODEL_HINTS.get(name, {}).get("stability_score", 3),
                "runtime_safety_tier": config.get("runtime_safety_tier", "balanced"),
                "minimum_total_ram_gb": config.get("minimum_total_ram_gb"),
                "minimum_available_ram_gb": config.get("minimum_available_ram_gb"),
                "minimum_gpu_vram_mb": config.get("minimum_gpu_vram_mb"),
                "minimum_gpu_available_vram_mb": config.get("minimum_gpu_available_vram_mb"),
                "minimum_cpu_total_ram_gb": config.get("minimum_cpu_total_ram_gb"),
                "minimum_cpu_available_ram_gb": config.get("minimum_cpu_available_ram_gb"),
            }
            for name, config in TAGGER_MODELS.items()
        ]
        return {
            "models": models,
            "default": DEFAULT_TAGGER_MODEL,
        }

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
        """Get unique prompt tokens from the normalized prompt-token index."""
        return db.get_all_prompt_tokens(limit=limit)

    def get_loras_library(self, limit: int = 500) -> Dict[str, Any]:
        """Get unique LoRAs from the normalized indexed LoRA table."""
        return db.get_all_loras(limit=limit)

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
        batched_updates: List[Dict[str, Any]] = []
        scheduled_image_ids: set[int] = set()

        with db.get_db() as conn:
            cursor = conn.cursor()

            for img_data in request.images:
                path = img_data.get("path", "")
                filename = img_data.get("filename", "")
                tags = self._normalize_import_tags(img_data.get("tags", []))
                if not tags:
                    continue

                image_row = db.get_image_by_path(path) if path else None
                row = None
                if image_row:
                    cursor.execute(
                        "SELECT id, tagged_at FROM images WHERE id = ?",
                        (image_row["id"],),
                    )
                    row = cursor.fetchone()
                elif filename:
                    cursor.execute(
                        "SELECT id, tagged_at FROM images WHERE filename = ?",
                        (filename,),
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

                # Keep import semantics stable for overwrite=False:
                # duplicate rows targeting the same previously-untagged image
                # should only import once in a single request.
                if not request.overwrite and image_id in scheduled_image_ids:
                    skipped += 1
                    continue

                batched_updates.append({
                    "image_id": image_id,
                    "tags": tags,
                })
                scheduled_image_ids.add(image_id)
                imported += 1

        if batched_updates:
            db.add_tags_batch(batched_updates)

        return {"imported": imported, "skipped": skipped}

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

    def _resolve_model_name(self, request: TagRequest) -> str:
        """Resolve the effective built-in model name for a request."""
        if request.model_path:
            return "custom"
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
            self._validate_model_hardware_requirements(model_name, request.use_gpu)

    def _validate_model_hardware_requirements(self, model_name: str, use_gpu: bool) -> None:
        """Reject models that should not run on the detected hardware."""
        model_config = TAGGER_MODELS.get(model_name, {})
        runtime_backend = str(model_config.get("runtime_backend", "wd14")).lower()
        if runtime_backend != "toriigate":
            return

        from hardware_monitor import get_system_info

        system_info = get_system_info()
        total_ram_gb = float(system_info.get("total_ram_gb") or 0)
        available_ram_gb = float(system_info.get("available_ram_gb") or 0)
        gpu_vram_total_mb = float(system_info.get("gpu_vram_total_mb") or 0)
        gpu_vram_available_mb = float(system_info.get("gpu_vram_available_mb") or 0)
        torch_cuda_available = bool(system_info.get("torch_cuda_available"))

        if use_gpu:
            min_total_ram_gb = float(model_config.get("minimum_total_ram_gb") or 0)
            min_available_ram_gb = float(model_config.get("minimum_available_ram_gb") or 0)
            min_gpu_vram_mb = float(model_config.get("minimum_gpu_vram_mb") or 0)
            min_gpu_available_vram_mb = float(model_config.get("minimum_gpu_available_vram_mb") or 0)

            failures = []
            if not torch_cuda_available:
                failures.append("PyTorch CUDA runtime is unavailable")
            if min_total_ram_gb and total_ram_gb and total_ram_gb < min_total_ram_gb:
                failures.append(f"system RAM {total_ram_gb:.0f} GB < required {min_total_ram_gb:.0f} GB")
            if min_available_ram_gb and available_ram_gb and available_ram_gb < min_available_ram_gb:
                failures.append(f"free RAM {available_ram_gb:.1f} GB < required {min_available_ram_gb:.0f} GB")
            if min_gpu_vram_mb and gpu_vram_total_mb and gpu_vram_total_mb < min_gpu_vram_mb:
                failures.append(f"GPU VRAM {gpu_vram_total_mb/1024:.1f} GB < required {min_gpu_vram_mb/1024:.0f} GB")
            if min_gpu_available_vram_mb and gpu_vram_available_mb and gpu_vram_available_mb < min_gpu_available_vram_mb:
                failures.append(f"free VRAM {gpu_vram_available_mb/1024:.1f} GB < required {min_gpu_available_vram_mb/1024:.0f} GB")

            if failures:
                detected = []
                if total_ram_gb:
                    detected.append(f"{total_ram_gb:.0f} GB RAM")
                if available_ram_gb:
                    detected.append(f"{available_ram_gb:.1f} GB free RAM")
                if gpu_vram_total_mb:
                    detected.append(f"{gpu_vram_total_mb/1024:.1f} GB VRAM")
                if gpu_vram_available_mb:
                    detected.append(f"{gpu_vram_available_mb/1024:.1f} GB free VRAM")
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "ToriiGate GPU mode is blocked on this hardware. "
                        f"Minimum: {min_total_ram_gb:.0f} GB RAM and {min_gpu_vram_mb/1024:.0f} GB VRAM. "
                        f"Detected: {', '.join(detected) if detected else 'unknown hardware'}. "
                        f"Reason: {'; '.join(failures)}."
                    ),
                )
        else:
            min_cpu_total_ram_gb = float(model_config.get("minimum_cpu_total_ram_gb") or 0)
            min_cpu_available_ram_gb = float(model_config.get("minimum_cpu_available_ram_gb") or 0)
            failures = []
            if min_cpu_total_ram_gb and total_ram_gb and total_ram_gb < min_cpu_total_ram_gb:
                failures.append(f"system RAM {total_ram_gb:.0f} GB < required {min_cpu_total_ram_gb:.0f} GB")
            if min_cpu_available_ram_gb and available_ram_gb and available_ram_gb < min_cpu_available_ram_gb:
                failures.append(f"free RAM {available_ram_gb:.1f} GB < required {min_cpu_available_ram_gb:.0f} GB")
            if failures:
                detected = []
                if total_ram_gb:
                    detected.append(f"{total_ram_gb:.0f} GB RAM")
                if available_ram_gb:
                    detected.append(f"{available_ram_gb:.1f} GB free RAM")
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "ToriiGate CPU mode is blocked on this hardware. "
                        f"Minimum: {min_cpu_total_ram_gb:.0f} GB RAM. "
                        f"Detected: {', '.join(detected) if detected else 'unknown hardware'}. "
                        f"Reason: {'; '.join(failures)}."
                    ),
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

        custom_runtime_notice = ""
        if request.model_path:
            custom_runtime_notice = (
                "Custom ONNX model on GPU. Automatic hardware clamps stay active, but the app starts from a conservative runtime chunk until this model proves stable."
                if effective_use_gpu
                else "Custom ONNX model on CPU Safe Mode. Start here, then try GPU only after one stable run."
            )

        if runtime_backend == "toriigate":
            if effective_use_gpu:
                fetch_batch_size = 1
                session_refresh_interval = 0
                startup_notice = (
                    "ToriiGate runs through the multimodal caption backend. "
                    "GPU is strongly recommended, and runtime chunk size is fixed to 1 in Safe Mode to avoid VRAM spikes."
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
            fetch_batch_size = min(CPU_CHUNK_MAX, max(1, int(hardware_rec.get("recommended_cpu_chunk_size") or 12)))
            cpu_pause_seconds = 0.01 if fetch_batch_size >= 24 else 0.0

        if request.model_path:
            fetch_batch_size = min(fetch_batch_size, TRUE_BATCH_MODEL_MAX if effective_use_gpu else CPU_CHUNK_MAX)
        elif runtime_backend == "toriigate":
            fetch_batch_size = min(fetch_batch_size, TORIIGATE_GPU_CHUNK_MAX if effective_use_gpu else 1)

        if requested_chunk_size:
            safety_cap = int(
                hardware_rec.get("recommended_batch_size")
                if effective_use_gpu
                else hardware_rec.get("recommended_cpu_chunk_size") or fetch_batch_size
            )
            if runtime_backend == "toriigate":
                chunk_cap = TORIIGATE_GPU_CHUNK_MAX if effective_use_gpu else 1
            else:
                chunk_cap = TRUE_BATCH_MODEL_MAX if effective_use_gpu else CPU_CHUNK_MAX
            applied_chunk_size = max(1, min(requested_chunk_size, chunk_cap, max(1, safety_cap)))
            if applied_chunk_size != requested_chunk_size:
                clamp_notice = (
                    f"Requested runtime chunk size {requested_chunk_size} was reduced to {applied_chunk_size} "
                    "to stay inside the supported runtime range."
                )
                startup_notice = f"{startup_notice} {clamp_notice}".strip()

            fetch_batch_size = applied_chunk_size
        elif request.model_path:
            startup_notice = custom_runtime_notice
        elif runtime_backend == "toriigate":
            startup_notice = startup_notice or (
                "ToriiGate uses the multimodal caption runtime. The app forces queue chunk 1 so long runs stay stable."
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

    def _apply_worker_progress(self, payload: Dict[str, Any], run_id: Optional[int] = None) -> None:
        """Merge a worker progress message into shared service state."""
        with self._lock:
            if run_id is not None and run_id != self._active_run_id:
                return
            effective_run_id = int(payload.get("run_id") or run_id or self._progress.get("run_id") or self._active_run_id or 0)
            self._progress = {
                "status": payload.get("status", self._progress.get("status", "idle")),
                "current": payload.get("current", self._progress.get("current", 0)),
                "processed": payload.get("processed", payload.get("current", self._progress.get("processed", 0))),
                "total": payload.get("total", self._progress.get("total", 0)),
                "tagged": payload.get("tagged", self._progress.get("tagged", 0)),
                "errors": payload.get("errors", self._progress.get("errors", 0)),
                "message": payload.get("message", self._progress.get("message", "")),
                "runtime_backend_target": payload.get("runtime_backend_target", self._progress.get("runtime_backend_target", "")),
                "runtime_backend_actual": payload.get("runtime_backend_actual", self._progress.get("runtime_backend_actual", "")),
                "runtime_backend_reason": payload.get("runtime_backend_reason", self._progress.get("runtime_backend_reason", "")),
                "memory_pressure_warning": payload.get("memory_pressure_warning", self._progress.get("memory_pressure_warning", "")),
                "run_id": effective_run_id,
            }

    def _drain_worker_queue(self, progress_queue: Any, run_id: int) -> bool:
        """Drain queued worker progress messages. Returns True if a terminal state was seen."""
        saw_terminal_state = False
        while True:
            try:
                payload = progress_queue.get_nowait()
            except queue_module.Empty:
                break
            self._apply_worker_progress(payload, run_id=run_id)
            if payload.get("status") in {"done", "error", "cancelled"}:
                saw_terminal_state = True
        return saw_terminal_state

    def _cleanup_worker_handles(self, progress_queue: Any = None, run_id: Optional[int] = None) -> None:
        """Clear worker references and close IPC handles when possible."""
        with self._lock:
            if run_id is None or run_id == self._active_run_id:
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

    def _run_tagging_job(self, request: TagRequest, run_id: Optional[int] = None) -> None:
        """Run a tagging job in an isolated worker process and mirror progress back to the API."""
        if run_id is None:
            with self._lock:
                if self._active_run_id <= 0:
                    self._active_run_id = 1
                run_id = self._active_run_id

        runtime_plan = self._build_runtime_plan(request)
        ctx = multiprocessing.get_context("spawn")
        progress_queue = ctx.Queue()
        cancel_event = ctx.Event()
        worker_process = ctx.Process(
            target=_tagging_worker_main,
            args=(runtime_plan, progress_queue, cancel_event),
            daemon=True,
        )

        should_abort = False
        with self._lock:
            if run_id != self._active_run_id:
                should_abort = True
            else:
                self._progress = _build_tag_progress_state("running", message="Preparing tagger...", run_id=run_id)
                self._worker_process = worker_process
                self._worker_cancel_event = cancel_event
                self._cancel_requested = False

        if should_abort:
            self._cleanup_worker_handles(progress_queue, run_id=run_id)
            return

        saw_terminal_state = False
        last_worker_message_at = time.monotonic()
        last_loading_heartbeat_at = last_worker_message_at
        model_name = str(runtime_plan.get("model_name") or "")
        runtime_backend = str(TAGGER_MODELS.get(model_name, {}).get("runtime_backend", "wd14")).lower()

        try:
            worker_process.start()
            while True:
                if self._cancel_requested:
                    cancel_event.set()

                try:
                    payload = progress_queue.get(timeout=0.25)
                    self._apply_worker_progress(payload, run_id=run_id)
                    last_worker_message_at = time.monotonic()
                    if payload.get("status") in {"done", "error", "cancelled"}:
                        saw_terminal_state = True
                except queue_module.Empty:
                    pass

                now = time.monotonic()
                if (
                    worker_process.is_alive()
                    and runtime_backend == "toriigate"
                    and (now - last_worker_message_at) >= TORIIGATE_LOAD_HEARTBEAT_SECONDS
                    and (now - last_loading_heartbeat_at) >= TORIIGATE_LOAD_HEARTBEAT_SECONDS
                ):
                    current_state = self.get_progress()
                    if (
                        current_state.get("status") == "running"
                        and int(current_state.get("current", 0) or 0) == 0
                        and int(current_state.get("total", 0) or 0) == 0
                    ):
                        elapsed_seconds = int(max(1, now - last_worker_message_at))
                        self._apply_worker_progress(
                            _build_tag_progress_state(
                                "running",
                                current=0,
                                total=0,
                                tagged=current_state.get("tagged", 0),
                                errors=current_state.get("errors", 0),
                                message=(
                                    "ToriiGate is still loading. "
                                    f"Elapsed {elapsed_seconds}s. This stage can use a lot of RAM/VRAM before the first image starts."
                                ),
                                runtime_backend_target=current_state.get("runtime_backend_target", ""),
                                runtime_backend_actual=current_state.get("runtime_backend_actual", ""),
                                runtime_backend_reason=current_state.get("runtime_backend_reason", ""),
                                memory_pressure_warning=current_state.get("memory_pressure_warning", ""),
                                run_id=run_id,
                            ),
                            run_id=run_id,
                        )
                        last_loading_heartbeat_at = now

                if not worker_process.is_alive():
                    saw_terminal_state = self._drain_worker_queue(progress_queue, run_id=run_id) or saw_terminal_state
                    break

                if saw_terminal_state:
                    worker_process.join(timeout=2.0)
                    saw_terminal_state = self._drain_worker_queue(progress_queue, run_id=run_id) or saw_terminal_state
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
                            run_id=run_id,
                        ),
                        run_id=run_id,
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
                            run_id=run_id,
                        ),
                        run_id=run_id,
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
                    run_id=run_id,
                ),
                run_id=run_id,
            )
        finally:
            self._cleanup_worker_handles(progress_queue, run_id=run_id)

    def start_tagging(
        self,
        request: TagRequest,
        background_tasks: BackgroundTasks
    ) -> Dict[str, str]:
        """Start tagging images with WD14 tagger."""
        self._validate_tag_request(request)

        if self._get_tagger is None:
            raise HTTPException(status_code=500, detail="Tagger not initialized")

        with self._lock:
            if self._progress["status"] in {"running", "cancelling"}:
                worker_alive = bool(self._worker_process and self._worker_process.is_alive())
                if worker_alive:
                    raise HTTPException(status_code=400, detail="Tagging already in progress")
                logger.warning(
                    "Recovering from stale tagging state %r with no live worker; allowing a fresh start.",
                    self._progress["status"],
                )
                self._worker_process = None
                self._worker_cancel_event = None
                self._cancel_requested = False

            self._active_run_id += 1
            run_id = self._active_run_id
            self._progress = _build_tag_progress_state("running", message="Preparing tagger...", run_id=run_id)
        background_tasks.add_task(self._run_tagging_job, request, run_id)
        return {"status": "started", "message": "Tagging started in background"}

    def export_tags_batch(self, request: BatchTagExportRequest) -> Dict[str, Any]:
        """Export tags for each image to individual .txt files."""
        result = export_tags_batch_request(request)
        error_count = int(result.get("error_count", 0) or 0)
        exported = int(result.get("exported", 0) or 0)
        skipped = int(result.get("skipped", 0) or 0)
        if error_count > 0:
            status = "partial" if exported > 0 or skipped > 0 else "error"
        elif skipped > 0:
            status = "partial"
        else:
            status = "ok"
        return {
            "status": status,
            "exported": exported,
            "errors": error_count,
            "error_count": error_count,
            "error_messages": result.get("error_messages", []),
            "skipped": skipped,
            "total": result.get("total", len(request.image_ids)),
            "content_mode": result.get("content_mode", request.content_mode),
            "overwrite_policy": result.get("overwrite_policy", request.overwrite_policy),
        }

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
