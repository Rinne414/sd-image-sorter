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
from pydantic import BaseModel, Field, model_validator

import database as db
from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS
from image_fingerprint import compute_image_content_fingerprint
from metadata_parser import verify_image_readable
from services import entry_stats_service
from services.state_compat import MutableStateProxy
from services.tag_export_service import (
    count_selection_token_ids,
    export_tags_combined_request,
    export_tags_batch_request,
    iter_selection_token_id_chunks,
    render_export_preview,
)
from services.bulk_job_service import JOB_KIND_EXPORT_SIDECARS, get_bulk_job_service
from utils.source_paths import resolve_existing_indexed_image_path
from utils.path_validation import normalize_user_path, validate_file_path

CUSTOM_PROFILE_ALIASES = {
    "": "wd14",
    "custom": "wd14",
    "wd14": "wd14",
    "wd14-compatible": "wd14",
    "wd14_csv": "wd14",
    "wd14-csv": "wd14",
    "wd-eva02-large-tagger-v3": "wd14",
    "wd-swinv2-tagger-v3": "wd14",
    "wd-convnext-tagger-v3": "wd14",
    "wd-vit-tagger-v3": "wd14",
    "wd-vit-large-tagger-v3": "wd14",
    "camie-tagger-v2": "camie-tagger-v2",
    "pixai-tagger-v0.9": "pixai-tagger-v0.9",
    "toriigate-0.5": "toriigate-0.5",
    "oppai-oracle-v1.1": "oppai-oracle-v1.1",
}
CUSTOM_ONNX_PROFILE_NAMES = {
    "wd14",
    "camie-tagger-v2",
    "pixai-tagger-v0.9",
}
CUSTOM_WD14_PROFILE_MODEL = "wd-swinv2-tagger-v3"
CUSTOM_PROFILE_MODEL_NAMES = {
    "wd14": CUSTOM_WD14_PROFILE_MODEL,
    "camie-tagger-v2": "camie-tagger-v2",
    "pixai-tagger-v0.9": "pixai-tagger-v0.9",
}

logger = logging.getLogger(__name__)

# Validation constants
THRESHOLD_MIN = 0.0
THRESHOLD_MAX = 1.0
PATH_MAX_LENGTH = 4096
# Background-task / sequential pipeline: per-image work runs one at a time,
# so the only thing this ceiling caps is the request payload memory. The
# internal SQLite IN(...) reads are already chunked at 500 ids inside
# `database.get_images_by_ids` / `get_image_tags_map`, so a 5M ceiling does
# not change the database access pattern. The previous 10k ceiling was
# rejecting realistic personal SD libraries.
BATCH_EXPORT_LIMIT = 5_000_000
VALID_SORT_OPTIONS = ["frequency", "alphabetical"]
TRUE_BATCH_MODEL_MAX = 64
CPU_CHUNK_MAX = 64
CUSTOM_ONNX_GPU_START_CHUNK_MAX = 8
CUSTOM_ONNX_CPU_START_CHUNK_MAX = 8
TORIIGATE_GPU_CHUNK_MAX = 1
TORIIGATE_LOAD_HEARTBEAT_SECONDS = 5.0

TAGGER_MODEL_HINTS = {
    "wd-eva02-large-tagger-v3": {
        "summary": "Most accurate overall — confirmed best in the v3.5.0 live test (highest precision at default threshold, zero hallucinations). The app drives it with adaptive runtime limits instead of forcing CPU by default.",
        "speed": "Slow",
        "memory": "High",
        "best_for": "Max Quality / final library cleanup",
        "safe_mode_note": "Adaptive runtime keeps GPU throughput first, while automatic hardware clamps still cap the true batch size for long runs.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive max-throughput runtime. Highest quality without a forced CPU default.",
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
        "safe_mode_note": "Uses GPU by default. Switch to CPU manually only when troubleshooting.",
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
        "safe_mode_note": "Best pick for weak machines. CPU works, but it is slower.",
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
        "safe_mode_note": "Switch to CPU manually only when troubleshooting model load.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 4,
        "speed_score": 3,
        "stability_score": 3,
    },
    "camie-tagger-v2": {
        "summary": "Much newer danbooru-era tag space with WD-level accuracy (v3.5.0 live test: 4/4 characters found). Strong artist / character / copyright / year coverage, but it can emit many more tags if the threshold is set too low.",
        "speed": "Medium-slow",
        "memory": "High",
        "best_for": "Modern tag coverage / deeper library enrichment",
        "safe_mode_note": "Camie uses ImageNet normalization and a much larger tag space. Keep the higher default threshold unless you intentionally want denser tags.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive runtime with denser modern tags. Better coverage than older WD models, but heavier and noisier if you lower the threshold too much.",
        "quality_score": 4,
        "speed_score": 2,
        "stability_score": 3,
    },
    "pixai-tagger-v0.9": {
        "summary": "Highest recall of all bundled taggers (v3.5.0 live test), but it also produces confident hallucinations — wrong tags ABOVE the confidence threshold that thresholding cannot remove. Best used inside multi-tagger consensus, which removed 11/12 hallucinations in testing.",
        "speed": "Medium-slow",
        "memory": "High",
        "best_for": "Recall-heavy passes / multi-tagger consensus member",
        "safe_mode_note": "Uses direct 448 resize and [-1, 1] normalization. This ONNX export has no native rating head, so the app derives a practical rating fallback from the returned tags. Review its solo output before training on it.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive runtime with newer PixAI tags. Heavier than the small WD models and should still be watched on long GPU runs.",
        "quality_score": 4,
        "speed_score": 2,
        "stability_score": 3,
    },
    "toriigate-0.5": {
        "summary": "Large anime-art multimodal CAPTIONER — writes excellent natural-language captions with strong NSFW, character, and copyright knowledge. Not a tagger: measured as one it emitted 5-7 loose tags per image with invented details, so tag mode is disabled (owner decision, v3.5.0).",
        "speed": "Slow",
        "memory": "Very high",
        "best_for": "Natural-language captions via Smart Tag (not booru tagging)",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Runs through the dedicated Transformers VLM backend instead of the WD14 ONNX runtime. GPU is strongly recommended, and the app keeps chunk size fixed to 1.",
        "quality_score": 5,
        "speed_score": 1,
        "stability_score": 2,
    },
    "oppai-oracle-v1.1": {
        "summary": "Grio43 OppaiOracle V1.1: 448x448 ViT (~247M params, 19,294 general tags) trained on a cleaned anime corpus. Highest reported macro-F1 in the open anime tagger comparison.",
        "speed": "Slow",
        "memory": "High",
        "best_for": "Highest-quality general tagging on anime / illustration images",
        "safe_mode_note": "Two-input ONNX (pixel_values + padding_mask). General-only vocabulary; rating tags exposed via the rating:* head. v3.5.0 live test: its ratings run about one level looser than WD models (explicit content can rate as questionable) — don't rely on it alone for strict rating gates.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Runs through the dedicated OppaiOracleTagger backend. CPU inference is ~1s/image; a GPU is strongly recommended for batch jobs.",
        "quality_score": 5,
        "speed_score": 2,
        "stability_score": 4,
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
            parts.append(f"GPU batch {from_size}->CPU fallback")

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


def _iter_rescaling_chunk_source(id_chunks, get_batch_size):
    """Yield dynamically sized batches from a chunk iterator without materializing all IDs."""
    carry: List[int] = []
    batch_start = 0
    for id_chunk in id_chunks:
        carry.extend(id_chunk)
        while carry:
            batch_size = max(1, int(get_batch_size()))
            if len(carry) < batch_size:
                break
            batch_ids = carry[:batch_size]
            del carry[:batch_size]
            yield batch_start, batch_ids
            batch_start += len(batch_ids)
    while carry:
        batch_size = max(1, int(get_batch_size()))
        batch_ids = carry[:batch_size]
        del carry[:batch_size]
        yield batch_start, batch_ids
        batch_start += len(batch_ids)


def _apply_pre_tag_filters(
    tags: List[Dict[str, Any]],
    *,
    blacklist: List[str],
    max_tags: int,
) -> List[Dict[str, Any]]:
    """Apply v3.2.2 T-power-PR1 pre-tag filters before DB write.

    Filters in order:

    1. **Blacklist** — drop any tag whose name matches one of
       ``blacklist`` after normalisation (lowercase, underscores
       collapsed to spaces, leading/trailing whitespace stripped).
       Score-style prefixes such as ``score_9_up`` are kept verbatim
       on the tag side because Pony / NoobAI recipes need them, but
       blacklist entries are also normalised so the user can write
       either ``score_9_up`` or ``score 9 up`` in their list.
    2. **max_tags** — keep the top N tags by confidence, descending.
       0 = unlimited (legacy behaviour).

    Returns a new list; the caller's tag list is not mutated.
    """
    if not tags:
        return []

    def _norm(s: str) -> str:
        return " ".join(str(s or "").strip().lower().replace("_", " ").split())

    blocked = {_norm(b) for b in (blacklist or []) if str(b or "").strip()}
    out: List[Dict[str, Any]] = []
    for tag in tags:
        name = tag.get("tag") if isinstance(tag, dict) else str(tag)
        if not name:
            continue
        if blocked and _norm(name) in blocked:
            continue
        out.append(tag if isinstance(tag, dict) else {"tag": str(tag), "confidence": 1.0})

    if max_tags and max_tags > 0 and len(out) > max_tags:
        out = sorted(
            out,
            key=lambda t: -float(t.get("confidence") or 0.0)
            if isinstance(t, dict) else 0.0,
        )[: int(max_tags)]
    return out


def _build_last_run_stats(
    start_time: float,
    total_processed: int,
    total_tagged: int,
    total_errors: int,
    top_tags_counter: Any,
) -> Dict[str, Any]:
    """Snapshot of the just-finished tagging run for the post-completion
    stats modal (v3.2.2 T-power-PR2 / H).

    Only ever populated on terminal progress states (done / cancelled /
    error). The frontend uses the presence of this key to know it's
    safe to pop the modal exactly once.
    """
    import time as _time
    elapsed = max(0.0, _time.time() - float(start_time)) if start_time else 0.0
    avg = (total_tagged / total_processed) if total_processed else 0.0
    top = []
    try:
        # ``top_tags_counter`` is a collections.Counter from the worker.
        for tag, count in top_tags_counter.most_common(10):
            if tag and count:
                top.append({"tag": str(tag), "count": int(count)})
    except Exception:
        # Defensive: never break the terminal send because of stats math.
        top = []
    return {
        "elapsed_seconds": round(elapsed, 1),
        "total_processed": int(total_processed),
        "total_tagged": int(total_tagged),
        "total_errors": int(total_errors),
        "avg_tags_per_image": round(avg, 2),
        "top_tags": top,
    }


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
    last_run_stats: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a normalized tag progress payload."""
    payload: Dict[str, Any] = {
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
    if last_run_stats:
        # Only present on terminal states (done / cancelled / error). The
        # frontend uses the presence of this key to know it's safe to pop
        # the post-tag stats modal exactly once per run.
        payload["last_run_stats"] = last_run_stats
    return payload


class _E2ETaggingStub:
    """Small deterministic tagger for Playwright full-flow tests only."""

    use_gpu = False

    def load(self) -> None:
        return None

    def set_session_refresh_interval(self, _interval: int) -> None:
        return None

    def tag_batch(
        self,
        image_paths: List[str],
        *,
        preferred_batch_size: int = 1,
        min_batch_size: int = 1,
        return_runtime_info: bool = False,
    ) -> Any:
        results = []
        for image_path in image_paths:
            stem = Path(image_path).stem.replace("_", " ").replace("-", " ").strip() or "image"
            all_tags = [
                {"tag": "e2e_fixture", "confidence": 0.99, "category": "general"},
                {"tag": stem, "confidence": 0.88, "category": "general"},
                {"tag": "general", "confidence": 0.99, "category": "rating"},
            ]
            results.append({
                "all_tags": all_tags,
                "general_tags": all_tags[:2],
                "character_tags": [],
                "rating": {"tag": "general", "confidence": 0.99},
                "error": None,
            })
        runtime_info = {
            "requested_batch_size": preferred_batch_size,
            "effective_batch_size": max(min_batch_size, min(preferred_batch_size, max(1, len(image_paths)))),
            "fallbacks": [],
        }
        if return_runtime_info:
            return results, runtime_info
        return results


def _e2e_tagger_getter(**_kwargs: Any) -> _E2ETaggingStub:
    return _E2ETaggingStub()


def _tagging_worker_main(
    runtime_plan_payload: Dict[str, Any],
    progress_queue: Any,
    cancel_event: Any,
) -> None:
    """Run the heavy tagger work in a child process so GPU/provider crashes do not kill the API."""
    import database as worker_db
    from tagger import get_tagger
    from toriigate_tagger import get_toriigate_tagger
    from oppai_oracle_tagger import get_oppai_oracle_tagger

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
        return "The GPU provider failed, so the run continued on CPU."

    def send(
        status: str,
        message: str,
        current: Optional[int] = None,
        total_override: Optional[int] = None,
        last_run_stats: Optional[Dict[str, Any]] = None,
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
                last_run_stats=last_run_stats,
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
        elif runtime_backend == "oppai-oracle":
            # OppaiOracle V1.1 ONNX is ~947 MB. Surface a clear size warning
            # BEFORE the download starts so users on slow / metered links
            # know what is about to happen.
            try:
                from config import get_oppai_oracle_model_dir
                cache_root = Path(get_oppai_oracle_model_dir()) / effective_model_name
                already_cached = any(cache_root.rglob("model.onnx")) if cache_root.exists() else False
            except Exception:
                already_cached = False
            if not already_cached:
                send(
                    "running",
                    "First-time OppaiOracle download: ~947 MB from HuggingFace. "
                    "This runs once; keep the app open until it completes.",
                )
            else:
                send(
                    "running",
                    f"Loading OppaiOracle on {'GPU' if effective_use_gpu else 'CPU'}...",
                )
        elif effective_use_gpu:
            send("running", "Loading model on GPU...")
        else:
            send("running", "Loading model on CPU...")

        if os.environ.get("SD_IMAGE_SORTER_E2E_FAKE_TAGGER") == "1" and runtime_backend != "toriigate":
            tagger_getter = _e2e_tagger_getter
        else:
            if runtime_backend == "toriigate":
                tagger_getter = get_toriigate_tagger
            elif runtime_backend == "oppai-oracle":
                tagger_getter = get_oppai_oracle_tagger
            else:
                tagger_getter = get_tagger
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
            runtime_backend_reason = "CPU mode was requested for this run."

        if startup_notice:
            send("running", startup_notice)

        if effective_use_gpu and not getattr(tagger, "use_gpu", False):
            gpu_fallback_announced = True
            send(
                "running",
                f"GPU load failed. Continuing on CPU instead. Reason: {runtime_backend_reason}",
            )

        if cancel_event.is_set():
            send("cancelled", "Tagging cancelled before processing images")
            return

        send("running", "Collecting image list...")
        if request.image_ids:
            # Avoid N+1: per-id `get_image_by_id` becomes one round-trip per
            # image and would block "Collecting image list..." for minutes
            # on a 5M-id request before the first image is even tagged.
            # `get_images_by_ids` already chunks IN(...) at 500.
            existing_ids = set(worker_db.get_images_by_ids(list(request.image_ids)).keys())
            all_ids = [img_id for img_id in request.image_ids if img_id in existing_ids]
            id_batches = _iter_rescaling_batches(all_ids, lambda: batch_size)
            total = len(all_ids)
        elif request.retag_all:
            total = worker_db.count_all_image_ids()
            id_batches = _iter_rescaling_chunk_source(
                worker_db.iter_all_image_id_chunks(max(batch_size, 1000)),
                lambda: batch_size,
            )
        else:
            total = worker_db.count_untagged_image_ids()
            id_batches = _iter_rescaling_chunk_source(
                worker_db.iter_untagged_image_id_chunks(max(batch_size, 1000)),
                lambda: batch_size,
            )

        send("running", f"Model loaded. Tagging {total} images...", current=0, total_override=total)
        tagging_start_time = time.time()
        tags_batch: List[Dict[str, Any]] = []
        # v3.2.2 T-power-PR2 (H): accumulate top-tag frequency for the
        # post-completion stats modal. Counter is process-local; no IPC
        # cost — flushed once into the terminal progress send.
        from collections import Counter as _Counter
        top_tags_counter: _Counter = _Counter()

        # Use _iter_rescaling_batches so memory-pressure reductions to batch_size
        # take effect on the very next iteration. A plain range(0, total, batch_size)
        # would capture the step at creation and skip images whenever the chunk
        # shrank mid-run.
        for batch_start, batch_ids in id_batches:
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
                        runtime_backend_reason = "GPU inference failed, so the run continued on CPU."

                    if effective_use_gpu and not gpu_fallback_announced and not getattr(tagger, "use_gpu", False):
                        gpu_fallback_announced = True
                        runtime_backend_actual = "cpu"
                        runtime_backend_reason = "GPU inference failed, so the run continued on CPU."
                        send(
                            "running",
                            f"GPU inference failed. Continuing on CPU... Reason: {runtime_backend_reason}",
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

                            # Apply pre-tag filters (T-power-PR1):
                            # 1. pre_tag_blacklist: drop any tag whose name (case-insensitive,
                            #    underscores normalized) matches one of the blacklist entries.
                            # 2. max_tags_per_image: keep top N tags by confidence (0 = unlimited).
                            #
                            # We touch the result dict in place so existing callers that read
                            # `general_tags` / `character_tags` / `all_tags` see the same view.
                            filtered_tags = _apply_pre_tag_filters(
                                result["all_tags"],
                                blacklist=request.pre_tag_blacklist,
                                max_tags=request.max_tags_per_image,
                            )
                            # H: feed counter for post-run stats modal.
                            for t in filtered_tags or []:
                                if isinstance(t, dict):
                                    name = str(t.get("tag") or "").strip()
                                else:
                                    name = str(t or "").strip()
                                if name:
                                    top_tags_counter[name] += 1
                            entry = {
                                "image_id": img["id"],
                                "tags": filtered_tags,
                                "content_fingerprint": content_fingerprint,
                            }
                            tags_batch.append(entry)
                            total_tagged += 1

                        total_processed += 1
                        processed_in_batch += 1
                        current_filename = os.path.basename(img.get("_resolved_path") or img["path"])
                        send_with_eta(
                            f"{total_processed}/{total} ({total_tagged} tagged{f', {total_errors} failed' if total_errors else ''}) - {current_filename}",
                        )

                        if len(tags_batch) >= commit_interval:
                            worker_db.add_tags_batch(tags_batch, default_source="tagger", replace_scope="pipeline")
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
                worker_db.add_tags_batch(tags_batch, default_source="tagger", replace_scope="pipeline")
                tags_batch = []

            del batch_images
            gc.collect()
            if cpu_pause_seconds > 0:
                time.sleep(cpu_pause_seconds)

        if cancel_event.is_set():
            send(
                "cancelled",
                f"Tagging cancelled. Processed {total_processed}/{total} images.",
                last_run_stats=_build_last_run_stats(
                    tagging_start_time, total_processed, total_tagged,
                    total_errors, top_tags_counter,
                ),
            )
            return

        send(
            "done",
            f"Completed! Processed {total_processed} images: {total_tagged} tagged" + (f", {total_errors} failed." if total_errors else "."),
            last_run_stats=_build_last_run_stats(
                tagging_start_time, total_processed, total_tagged,
                total_errors, top_tags_counter,
            ),
        )
        entry_stats_service.record_activity(
            entry_stats_service.KIND_TAGGED, total_processed
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
    custom_profile: Optional[str] = Field(default=None, max_length=64)
    use_gpu: bool = True
    allow_unsafe_acceleration: bool = False
    batch_size: Optional[int] = Field(default=None, ge=1, le=128)
    # v3.2.2 follow-up (T-power-PR1):
    # pre-tag blacklist applied at write time so unwanted tags
    # (masterpiece / monochrome / signature / watermark / ...) NEVER
    # enter the DB instead of being stripped at export time. Saves
    # repeated cleanup work for users who always reject the same set.
    pre_tag_blacklist: List[str] = Field(default_factory=list, max_length=500)
    # Max tags per image written to DB after the blacklist filter. 0 =
    # unlimited (current default behaviour). Suggested values vary by
    # base-model architecture (CLIP/SDXL ~50, T5/FLUX ~120, Anima/Qwen3 ~200);
    # see backend/services/dataset_audit_service.py and the frontend
    # base-model preset for the live recommendation.
    max_tags_per_image: int = Field(default=0, ge=0, le=2000)


class TagImportRequest(BaseModel):
    """Request model for tag import."""
    images: List[dict] = Field(..., max_length=BATCH_EXPORT_LIMIT)
    overwrite: bool = False


class BatchTagExportRequest(BaseModel):
    """Request model for batch sidecar export."""
    image_ids: Optional[List[int]] = Field(default=None, min_length=1, max_length=BATCH_EXPORT_LIMIT)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    # ``output_folder`` is required when ``output_mode == "folder"``. When
    # ``output_mode == "beside_image"`` the field is ignored, so the schema
    # allows an empty string and the service-level validator only enforces
    # the path on the folder branch. Default is empty so callers do not have
    # to send a fake path when they pick beside_image.
    output_folder: str = Field(default="", max_length=PATH_MAX_LENGTH)
    output_mode: str = Field(default="folder", max_length=24)
    blacklist: Optional[List[str]] = Field(default=[], max_length=500)
    prefix: Optional[str] = Field(default="", max_length=256)
    content_mode: str = Field(default="tags", max_length=32)
    overwrite_policy: str = Field(default="unique", max_length=16)
    # v3.2.1: options for template content mode (preset_id, template_override, trigger, etc.)
    template_options: Optional[Dict[str, Any]] = Field(default=None)
    # v3.2.1: per-image caption overrides {image_id: caption_text} from live-preview edits
    image_overrides: Optional[Dict[int, str]] = Field(default=None)
    # Compact all-image rules from the v321 caption editor. This keeps
    # "add/remove from all" working for selection tokens without sending
    # every image ID or caption to the browser.
    caption_transforms: Optional[Dict[str, Any]] = Field(default=None)
    # Aurora #25c caption consolidation: per-image caption type + edited NL
    # sentence — the same contract the Dataset Maker export already speaks.
    # ``image_types`` values: "booru" | "nl" | "both"; an absent key means
    # "booru" and reproduces the pre-feature output byte-for-byte.
    # ``image_nl_overrides`` carries the caption editor's NL-box text; when a
    # key is absent the stored nl_caption (then ai_caption) is used instead.
    image_types: Optional[Dict[int, str]] = Field(default=None)
    image_nl_overrides: Optional[Dict[int, str]] = Field(default=None)
    # v3.2.1 follow-up: convert danbooru-style tag underscores to spaces while
    # preserving ``score_*`` prefixes (LoRA-trainer convention). ``None``
    # (default) means "follow the per-content-mode default" — tag modes
    # normalize, free-form text / prompt modes do not. ``True`` / ``False``
    # is an explicit user override surfaced as a checkbox in the export
    # modal.
    normalize_tag_underscores: Optional[bool] = Field(default=None)
    # P0-3 (diffusion-pipe style split export): additionally write each image's
    # natural-language caption to a second sidecar ``{stem}{suffix}.txt`` next
    # to the tag sidecar. Only valid for tag-only content modes (tags,
    # template) — NL-bearing modes already embed the sentence. The trigger
    # (template trigger, else ``prefix``) is injected at the front of the NL
    # text so each file stands alone as a training caption.
    nl_sidecar: bool = Field(default=False)
    nl_sidecar_suffix: str = Field(default="_nl", min_length=1, max_length=32, pattern=r"^[A-Za-z0-9._-]+$")
    # P2-19 (2026-07-07): purpose-aware filtering in the export engine —
    # '' = off; character/style/concept reuse Smart Tag's semantics
    # (services.tag_training_filters) on the stored tag rows.
    training_purpose: str = Field(default="", max_length=24)
    # P2-18 (2026-07-07): collapse danbooru implication parents (cat_ears
    # present drops animal_ears) behind an explicit opt-in toggle.
    dedupe_implications: bool = Field(default=False)
    # Debt-22 opt-in: when true, POST /api/tags/export-batch starts a durable-id
    # background job (BulkJobService) with per-image progress and mid-run cancel
    # instead of exporting synchronously in the request.
    background: bool = Field(default=False)

    @model_validator(mode="after")
    def require_ids_or_selection_token(self):
        if self.image_ids is None and not self.selection_token:
            raise ValueError("Either image_ids or selection_token is required")
        if self.image_ids is not None and self.selection_token:
            raise ValueError("Provide either image_ids or selection_token, not both")
        return self


class ExportPreviewRequest(BaseModel):
    """Request model for template live preview rendering."""
    image_ids: List[int] = Field(default_factory=list, max_length=500)
    preset_id: str = "custom"
    template_override: Optional[str] = None
    trigger: str = ""
    blacklist: List[str] = Field(default_factory=list)
    replace_rules: Dict[str, str] = Field(default_factory=dict)
    max_tags: int = 0
    append: List[str] = Field(default_factory=list)
    caption_transforms: Optional[Dict[str, Any]] = Field(default=None)
    # P1-7 preview unification: when set to a real (non-template) content
    # mode, the preview renders through build_sidecar_content — the exact
    # engine the export writes with — instead of a template approximation.
    content_mode: Optional[str] = Field(default=None, max_length=32)
    prefix: str = Field(default="", max_length=256)
    normalize_tag_underscores: Optional[bool] = Field(default=None)
    quality_override: Optional[str] = None
    safety_override: Optional[str] = None
    rating_override: Optional[str] = None
    # v3.2.1 follow-up: forward the user's underscore-toggle to the live
    # preview so the preview matches what the same-name .txt export will
    # actually write. None = follow preset default.
    underscore_to_space_override: Optional[bool] = None
    preserve_underscore_prefixes_override: Optional[List[str]] = None
    # P2-19 / P2-18: preview twins of the export request fields so the live
    # preview shows exactly what the sidecars will contain.
    training_purpose: str = Field(default="", max_length=24)
    dedupe_implications: bool = Field(default=False)


class CombinedTagExportRequest(BatchTagExportRequest):
    """Request model for one-file combined export rendered server-side."""


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
        # v3.3.2 Phase-1: background batch tag-export job. The underlying
        # export_tags_batch is monolithic, so this runs it off the request thread
        # to avoid freezing the browser; progress is coarse (running -> done),
        # no mid-run cancel. The terminal payload embeds the full export result.
        self._export_progress: Dict[str, Any] = self._build_default_export_progress_state()
        self._export_lock = threading.Lock()
        self._export_run_id = 0

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

            # If start_tagging just queued a background task but the worker
            # process has not been spawned yet, _worker_process is still None.
            # Finalize the cancellation here and bump _active_run_id so the
            # pending _run_tagging_job aborts when it finally executes (its
            # run_id will no longer match self._active_run_id, so it takes
            # the should_abort path instead of clobbering progress and
            # spawning a worker that nobody can cancel).
            if worker is None:
                self._progress = _build_tag_progress_state(
                    "cancelled",
                    current=current,
                    total=total,
                    tagged=tagged,
                    errors=errors,
                    message=f"Tagging cancelled at {current}/{total}.",
                    run_id=run_id,
                )
                self._active_run_id += 1
                self._cancel_requested = False
                return {"status": "cancelled", "message": "Tagging cancelled"}

        worker_stopped = not worker.is_alive()
        # If the worker is alive, give it a short grace period then forcefully terminate
        if worker.is_alive():
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

    def get_all_tags(self, limit: Optional[int] = None) -> Dict[str, Any]:
        """Get all unique tags with occurrence counts."""
        tags = db.get_all_tags()
        return {"tags": tags if limit is None else tags[:limit], "total": len(tags)}

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
                "default_copyright_threshold": config.get("default_copyright_threshold"),
                "default_max_tags_per_image": config.get("default_max_tags_per_image"),
                "speed": TAGGER_MODEL_HINTS.get(name, {}).get("speed", "Unknown"),
                "memory": TAGGER_MODEL_HINTS.get(name, {}).get("memory", "Unknown"),
                "best_for": TAGGER_MODEL_HINTS.get(name, {}).get("best_for", "General use"),
                "recommended": TAGGER_MODEL_HINTS.get(name, {}).get("recommended", False),
                "safe_mode_note": TAGGER_MODEL_HINTS.get(name, {}).get("safe_mode_note", "Switch to CPU only when troubleshooting runtime issues."),
                "gpu_default": TAGGER_MODEL_HINTS.get(name, {}).get("gpu_default", True),
                "gpu_confirmation_required": TAGGER_MODEL_HINTS.get(name, {}).get("gpu_confirmation_required", False),
                "gpu_locked": TAGGER_MODEL_HINTS.get(name, {}).get("gpu_locked", False),
                "runtime_note": TAGGER_MODEL_HINTS.get(name, {}).get("runtime_note", ""),
                "quality_score": TAGGER_MODEL_HINTS.get(name, {}).get("quality_score", 3),
                "speed_score": TAGGER_MODEL_HINTS.get(name, {}).get("speed_score", 3),
                "stability_score": TAGGER_MODEL_HINTS.get(name, {}).get("stability_score", 3),
                "runtime_backend": config.get("runtime_backend", "wd14"),
                "captioner_only": bool(config.get("captioner_only", False)),
                "smart_tag_role": "natural_language" if config.get("runtime_backend") == "toriigate" else "booru",
                "prepare_model_id": (
                    "toriigate" if config.get("runtime_backend") == "toriigate"
                    else "oppai-oracle" if config.get("runtime_backend") == "oppai-oracle"
                    else "wd14"
                ),
                "runtime_safety_tier": config.get("runtime_safety_tier", "balanced"),
                "minimum_total_ram_gb": config.get("minimum_total_ram_gb"),
                "minimum_available_ram_gb": config.get("minimum_available_ram_gb"),
                "minimum_gpu_vram_mb": config.get("minimum_gpu_vram_mb"),
                "minimum_gpu_available_vram_mb": config.get("minimum_gpu_available_vram_mb"),
                "minimum_cpu_total_ram_gb": config.get("minimum_cpu_total_ram_gb"),
                "minimum_cpu_available_ram_gb": config.get("minimum_cpu_available_ram_gb"),
                "custom_profile_supported": str(config.get("runtime_backend", "wd14")).lower() not in {"toriigate", "oppai-oracle"},
                "custom_metadata_format": config.get("metadata_format", "wd14_csv"),
                "custom_tags_file_hint": ".json metadata" if config.get("metadata_format") == "camie_v2" else "selected_tags.csv",
            }
            for name, config in TAGGER_MODELS.items()
        ]
        return {
            "models": models,
            "default": DEFAULT_TAGGER_MODEL,
        }

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
        return {"checkpoints": checkpoints, "total": len(checkpoints)}

    def export_tags(self) -> Dict[str, Any]:
        """Export all image tags as JSON for backup/transfer."""
        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT i.id, i.path, i.filename, i.generator, i.checkpoint,
                       i.ai_caption,
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
                    "ai_caption": row["ai_caption"] or "",
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
                ai_caption = str(img_data.get("ai_caption") or "").strip()
                if not tags and not ai_caption:
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
                    "ai_caption": ai_caption,
                })
                scheduled_image_ids.add(image_id)
                imported += 1

        if batched_updates:
            # User-supplied import data: mark rows 'manual' so later tagger
            # re-runs (pipeline scope) don't wipe what the user brought in.
            db.add_tags_batch(batched_updates, default_source="manual")

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

    def _resolve_custom_profile(self, request: TagRequest) -> str:
        """Resolve the custom ONNX profile selected by the user."""
        raw_profile = (request.custom_profile or request.model_name or "wd14").strip().lower()
        return CUSTOM_PROFILE_ALIASES.get(raw_profile, raw_profile or "wd14")

    def _resolve_model_name(self, request: TagRequest) -> str:
        """Resolve the effective built-in model/profile name for a request."""
        if request.model_path:
            profile = self._resolve_custom_profile(request)
            return CUSTOM_PROFILE_MODEL_NAMES.get(profile, profile)
        return (request.model_name or DEFAULT_TAGGER_MODEL).strip()

    def _validate_tag_request(self, request: TagRequest) -> None:
        """Reject unsafe or invalid tagger combinations before background work starts."""
        if request.model_path:
            custom_profile = self._resolve_custom_profile(request)
            if custom_profile not in CUSTOM_ONNX_PROFILE_NAMES:
                if custom_profile == "toriigate-0.5":
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "ToriiGate is not an ONNX tagger. Use the built-in ToriiGate entry for auto-download, "
                            "or add a dedicated local ToriiGate directory profile instead of the Custom ONNX path."
                        ),
                    )
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported custom tagger profile: {custom_profile}",
                )
            normalized_model_path = normalize_user_path(request.model_path)
            model_ext = os.path.splitext(normalized_model_path)[1].lower()
            if model_ext != ".onnx":
                raise HTTPException(
                    status_code=400,
                    detail="Custom ONNX tagger model must be an .onnx file.",
                )
            is_valid_model_path, model_path_error = validate_file_path(
                normalized_model_path,
                allowed_extensions={".onnx"},
            )
            if not is_valid_model_path:
                raise HTTPException(
                    status_code=400,
                    detail=f"Custom ONNX tagger model path is invalid: {model_path_error}.",
                )
            request.model_path = normalized_model_path

        if request.tags_path and not request.model_path:
            raise HTTPException(
                status_code=400,
                detail="Custom tags/metadata path requires a Custom ONNX model_path.",
            )

        if request.tags_path:
            normalized_tags_path = normalize_user_path(request.tags_path)
            tags_ext = os.path.splitext(normalized_tags_path)[1].lower()
            custom_profile = self._resolve_custom_profile(request)
            allowed_tags_exts = {".json"} if custom_profile == "camie-tagger-v2" else {".csv"}
            if tags_ext not in allowed_tags_exts:
                allowed_text = " or ".join(sorted(allowed_tags_exts))
                raise HTTPException(
                    status_code=400,
                    detail=f"Custom tags/metadata file for {custom_profile} must be {allowed_text}.",
                )
            if request.model_path:
                is_valid_tags_path, tags_path_error = validate_file_path(
                    normalized_tags_path,
                    allowed_extensions=allowed_tags_exts,
                )
                if not is_valid_tags_path:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Custom tags/metadata path for {custom_profile} is invalid: {tags_path_error}.",
                    )
                request.tags_path = normalized_tags_path

        model_name = self._resolve_model_name(request)
        if model_name not in TAGGER_MODELS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown tagger model: {model_name}",
            )

        model_config = TAGGER_MODELS.get(model_name, {})
        if model_config.get("disabled"):
            raise HTTPException(
                status_code=409,
                detail=model_config.get("disabled_reason") or f"Model {model_name} is not available in the current build.",
            )
        if model_config.get("captioner_only"):
            # Owner decision (2026-07-06): ToriiGate is a captioner, not a
            # tagger. Measured as a gallery tagger it emitted 5-7 tags/image
            # with non-danbooru words and invented anatomy. Caption with it
            # via Smart Tag's natural-language stage instead.
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{model_name} is a captioner, not a tagger. "
                    "Use Smart Tag (natural-language mode) for captions."
                ),
            )
        if not request.model_path:
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
                else "Custom ONNX model on CPU. Switch GPU back on when you want acceleration."
            )

        if runtime_backend == "toriigate":
            if effective_use_gpu:
                fetch_batch_size = 1
                session_refresh_interval = 0
                startup_notice = (
                    "ToriiGate runs through the multimodal caption backend. "
                    "GPU is strongly recommended, and runtime chunk size is fixed to 1 to limit VRAM usage."
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
            custom_start_cap = CUSTOM_ONNX_GPU_START_CHUNK_MAX if effective_use_gpu else CUSTOM_ONNX_CPU_START_CHUNK_MAX
            fetch_batch_size = min(fetch_batch_size, custom_start_cap)
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
                    # 409 Conflict, matching the smart-tag and VLM-batch busy
                    # responses (400 stays reserved for invalid requests).
                    raise HTTPException(status_code=409, detail="Tagging already in progress")
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
        id_chunks = None
        total = None
        if request.selection_token:
            id_chunks = iter_selection_token_id_chunks(request.selection_token)
            total = count_selection_token_ids(request.selection_token)
        result = export_tags_batch_request(request, id_chunks=id_chunks, total=total)
        error_count = int(result.get("error_count", 0) or 0)
        exported = int(result.get("exported", 0) or 0)
        skipped = int(result.get("skipped", 0) or 0)
        status = self._resolve_export_status(exported, skipped, error_count)
        return {
            "status": status,
            "exported": exported,
            "errors": error_count,
            "error_count": error_count,
            "error_messages": result.get("error_messages", []),
            "skipped": skipped,
            "total": result.get("total", len(request.image_ids or [])),
            "content_mode": result.get("content_mode", request.content_mode),
            "overwrite_policy": result.get("overwrite_policy", request.overwrite_policy),
            "output_mode": result.get("output_mode", getattr(request, "output_mode", "folder")),
            "nl_sidecars_written": result.get("nl_sidecars_written", 0),
            "validation": result.get("validation"),
        }

    @staticmethod
    def _resolve_export_status(exported: int, skipped: int, error_count: int) -> str:
        """Map export counters to the ok / partial / error status contract."""
        if error_count > 0:
            return "partial" if exported > 0 or skipped > 0 else "error"
        if skipped > 0:
            return "partial"
        return "ok"

    @staticmethod
    def _build_default_export_progress_state() -> Dict[str, Any]:
        """Idle progress payload for the background batch tag-export job. The
        terminal 'done' payload embeds the full ``export_tags_batch`` result under
        ``result`` so the frontend's existing mapping works unchanged."""
        return {
            "status": "idle",
            "step": "idle",
            "current": 0,
            "total": 0,
            "message": "",
            "operation": "export",
            "result": None,
            "started_at": None,
            "updated_at": None,
        }

    def get_export_progress(self) -> Dict[str, Any]:
        with self._export_lock:
            return self._export_progress.copy()

    def reset_export_progress(self) -> Dict[str, Any]:
        with self._export_lock:
            if self._export_progress["status"] == "running":
                return {"status": "running", "message": "Cannot reset a running job"}
            self._export_progress = self._build_default_export_progress_state()
            return {"status": self._export_progress["status"], "message": "Nothing to reset"}

    def _set_export_progress_if_current(self, run_id: int, state: Dict[str, Any]) -> bool:
        with self._export_lock:
            if run_id != self._export_run_id:
                return False
            self._export_progress = state
            return True

    def start_export_tags_batch_job(self, request: BatchTagExportRequest, background_tasks: Any) -> Dict[str, Any]:
        """v3.3.2 Phase-1: run ``export_tags_batch`` as a background job so large
        exports don't freeze the request. The export pipeline is monolithic, so
        progress is coarse (running -> done) with no mid-run cancel; the terminal
        payload embeds the full export result under ``result`` for the frontend.
        """
        with self._export_lock:
            if self._export_progress["status"] == "running":
                raise HTTPException(status_code=409, detail="An export is already in progress")

        if request.selection_token:
            total = count_selection_token_ids(request.selection_token)
        else:
            total = len(request.image_ids or [])

        with self._export_lock:
            self._export_run_id += 1
            run_id = self._export_run_id
            self._export_progress = {
                **self._build_default_export_progress_state(),
                "status": "running",
                "step": "exporting",
                "current": 0,
                "total": total,
                "message": f"Exporting tags for {total} images...",
                "started_at": time.time(),
                "updated_at": time.time(),
            }

        def run_export():
            try:
                result = self.export_tags_batch(request)
                self._set_export_progress_if_current(
                    run_id,
                    {
                        **self._build_default_export_progress_state(),
                        "status": "done",
                        "step": "done",
                        "current": total,
                        "total": total,
                        "message": f"Export complete: {int(result.get('exported', 0) or 0)} files.",
                        "operation": "export",
                        "result": result,
                        "started_at": self._export_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )
            except Exception as e:
                logger.error("Export job failed: %s", e)
                self._set_export_progress_if_current(
                    run_id,
                    {
                        **self._build_default_export_progress_state(),
                        "status": "error",
                        "step": "error",
                        "current": 0,
                        "total": total,
                        "message": "Export failed due to an internal error",
                        "operation": "export",
                        "result": {
                            "status": "error",
                            "exported": 0,
                            "errors": 1,
                            "error_count": 1,
                            "error_messages": [str(e)],
                            "skipped": 0,
                            "total": total,
                        },
                        "started_at": self._export_progress.get("started_at"),
                        "updated_at": time.time(),
                    },
                )

        background_tasks.add_task(run_export)
        return {
            "status": "started",
            "message": f"Exporting {total} images in background",
            "total": total,
            "operation": "export",
        }

    def start_export_bulk_job(self, request: BatchTagExportRequest, background_tasks: Any) -> Dict[str, Any]:
        """Debt-22: same-name sidecar export as a durable-id background job.

        Unlike the Phase-1 ``start_export_tags_batch_job`` (coarse progress, no
        mid-run cancel), this streams per-image progress and stops cooperatively
        when cancelled via the shared BulkJobService. Token selections are
        snapshotted server-side before the export reads them; the single-call
        ``export_tags_batch_request`` keeps its filename de-dup intact.
        """
        bulk_jobs = get_bulk_job_service()
        if request.selection_token:
            total = count_selection_token_ids(request.selection_token)
        else:
            total = len(request.image_ids or [])
        job_id = bulk_jobs.create_job(
            JOB_KIND_EXPORT_SIDECARS,
            total=total,
            message=f"Exporting {total} images...",
        )

        def worker(handle) -> None:
            id_chunks = (
                iter_selection_token_id_chunks(request.selection_token, snapshot=True)
                if request.selection_token
                else None
            )

            def on_progress(update: Dict[str, Any]) -> None:
                handle.set_progress(
                    processed=int(update.get("processed") or 0),
                    total=int(update.get("total") or total),
                )

            result = export_tags_batch_request(
                request,
                id_chunks=id_chunks,
                total=total,
                progress_callback=on_progress,
                cancel_check=lambda: handle.cancelled,
            )
            error_count = int(result.get("error_count", 0) or 0)
            exported = int(result.get("exported", 0) or 0)
            skipped = int(result.get("skipped", 0) or 0)
            handle.record_errors(error_count, result.get("error_messages") or [])
            handle.set_result({
                "status": self._resolve_export_status(exported, skipped, error_count),
                "exported": exported,
                "skipped": skipped,
                "errors": error_count,
                "error_count": error_count,
                "error_messages": result.get("error_messages", []),
                "total": result.get("total", total),
                "content_mode": result.get("content_mode", request.content_mode),
                "overwrite_policy": result.get("overwrite_policy", request.overwrite_policy),
                "output_mode": result.get("output_mode", getattr(request, "output_mode", "folder")),
                "nl_sidecars_written": result.get("nl_sidecars_written", 0),
                "validation": result.get("validation"),
            })

        background_tasks.add_task(bulk_jobs.run_job, job_id, worker)
        envelope = bulk_jobs.get_job(job_id) or {}
        envelope["operation"] = "export"
        return envelope

    def export_tags_combined(self, request: CombinedTagExportRequest) -> Dict[str, Any]:
        """Render selected captions into one server-side downloadable file."""
        id_chunks = None
        total = None
        if request.selection_token:
            id_chunks = iter_selection_token_id_chunks(request.selection_token)
            total = count_selection_token_ids(request.selection_token)
        return export_tags_combined_request(request, id_chunks=id_chunks, total=total)

    def export_preview(self, request: ExportPreviewRequest) -> Dict[str, Any]:
        """Render export captions for the live preview modal."""
        return render_export_preview(request)

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
