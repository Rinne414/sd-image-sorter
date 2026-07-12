"""Character-purity (CCIP) analysis service.

Competitive roadmap #9, v1: given a Dataset Maker selection of gallery image
ids, embed every image with CCIP (``backend/ccip.py``), run the learned
pairwise comparator, pick the MEDOID (minimum total difference — the "most
typical" image of the set) and rank every image by its difference to that
medoid. Images above the threshold are flagged as suspected character
outliers.

ADVISORY ONLY by design: the job never deletes, moves, or edits anything —
it returns a ranked report the UI renders for human review. Known model
caveats the UI must surface: multi-character images confuse CCIP, and
chibi/style variance legitimately raises distances (hence medoid anchoring,
an adjustable threshold, and no automatic actions).

Job-store idiom mirrors ``dataset_export_service`` (module-level progress
dict + run-id-guarded worker thread + cooperative cancel event) so the
frontend can reuse the same start/progress/cancel polling pattern.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from typing import Any, Dict, Iterable, Iterator, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

import ccip
import database as db

logger = logging.getLogger(__name__)

_DB_CHUNK_SIZE = 500
_ACTIVE_STATUSES = {"starting", "running", "cancelling"}


class CharacterPurityRequest(BaseModel):
    """Request body for ``POST /api/dataset/character-purity``."""

    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(default_factory=list)
    # None -> the CCIP variant's published threshold (0.178 for pruned-24).
    threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class CharacterPurityStartResponse(BaseModel):
    status: str
    job_id: str
    total: int
    message: str


def _get_ccip() -> Any:
    """Indirection point so tests can stub the ONNX-backed singleton."""
    return ccip.get_ccip()


def _iter_unique_image_ids(values: Iterable[Any]) -> Iterator[int]:
    seen: set[int] = set()
    for raw in values or []:
        try:
            image_id = int(raw)
        except (TypeError, ValueError):
            continue
        if image_id <= 0 or image_id in seen:
            continue
        seen.add(image_id)
        yield image_id


# ------------------------------ model status ------------------------------

_PREPARE_LOCK = threading.Lock()
_PREPARE_THREAD: Optional[threading.Thread] = None
_PREPARE_STATE: Dict[str, Any] = {"active": False, "error": None}


def get_character_purity_status() -> Dict[str, Any]:
    """Model availability for the health card (v1 status endpoint).

    Chosen over a full Model Center registry entry: the model inventory in
    ``services/model_service.py`` couples every entry to ``model_health``
    aggregation, prepare_model branches, i18n message keys and the
    recommended-bundle sync test. A dataset-scoped status endpoint keeps the
    v1 surface small; registry promotion can come later without breaking
    this contract.
    """
    instance = _get_ccip()
    missing = instance.missing_files()
    with _PREPARE_LOCK:
        prepare_state = dict(_PREPARE_STATE)
    return {
        "available": not missing,
        "model_dir": str(instance.model_dir),
        "missing_files": missing,
        "default_threshold": ccip.DEFAULT_THRESHOLD,
        "preparing": bool(prepare_state.get("active")),
        "prepare_error": prepare_state.get("error"),
        "download": ccip.get_download_progress(),
    }


def prepare_character_purity() -> Dict[str, Any]:
    """Start a background download of the CCIP model files (~150 MB)."""
    global _PREPARE_THREAD
    instance = _get_ccip()
    if instance.is_available():
        return {"status": "ready", "model_dir": str(instance.model_dir)}

    with _PREPARE_LOCK:
        if _PREPARE_STATE.get("active"):
            raise HTTPException(
                status_code=409, detail="CCIP model download already in progress"
            )
        _PREPARE_STATE.update({"active": True, "error": None})

        def worker() -> None:
            error: Optional[str] = None
            try:
                instance.download_models()
            except Exception as exc:  # noqa: BLE001 - surfaced via the status endpoint
                logger.exception("CCIP model download failed")
                error = str(exc)
            with _PREPARE_LOCK:
                _PREPARE_STATE.update({"active": False, "error": error})

        _PREPARE_THREAD = threading.Thread(
            target=worker, name="ccip-prepare", daemon=True
        )
        _PREPARE_THREAD.start()
    return {"status": "started", "model_dir": str(instance.model_dir)}


# ------------------------------ analysis job ------------------------------

_JOB_LOCK = threading.Lock()
_JOB_RUN_ID = 0
_JOB_THREAD: Optional[threading.Thread] = None
_JOB_CANCEL_EVENT: Optional[threading.Event] = None
_IDLE_PROGRESS: Dict[str, Any] = {
    "status": "idle",
    "job_id": None,
    "step": "idle",
    "current": 0,
    "total": 0,
    "extracted": 0,
    "failed": 0,
    "result": None,
    "message": "No character-purity analysis is running.",
    "started_at": None,
    "updated_at": None,
}
_JOB_PROGRESS: Dict[str, Any] = {**_IDLE_PROGRESS, "updated_at": time.time()}


def _copy_progress(progress: Dict[str, Any]) -> Dict[str, Any]:
    snapshot = dict(progress)
    result = progress.get("result")
    if isinstance(result, dict):
        snapshot["result"] = {
            **result,
            "items": [dict(item) for item in result.get("items") or []],
        }
    return snapshot


def get_character_purity_progress(job_id: Optional[str] = None) -> Dict[str, Any]:
    with _JOB_LOCK:
        if job_id and _JOB_PROGRESS.get("job_id") not in {None, job_id}:
            raise HTTPException(
                status_code=404, detail="Character-purity job not found"
            )
        return _copy_progress(_JOB_PROGRESS)


def cancel_character_purity(job_id: Optional[str] = None) -> Dict[str, Any]:
    global _JOB_PROGRESS
    with _JOB_LOCK:
        if job_id and _JOB_PROGRESS.get("job_id") != job_id:
            raise HTTPException(
                status_code=404, detail="Character-purity job not found"
            )
        status = str(_JOB_PROGRESS.get("status") or "idle")
        if status not in _ACTIVE_STATUSES:
            return {
                "status": status,
                "job_id": _JOB_PROGRESS.get("job_id"),
                "message": "No character-purity job is running.",
            }
        if _JOB_CANCEL_EVENT is not None:
            _JOB_CANCEL_EVENT.set()
        _JOB_PROGRESS = {
            **_JOB_PROGRESS,
            "status": "cancelling",
            "step": "cancelling",
            "message": "Cancelling character-purity analysis...",
            "updated_at": time.time(),
        }
        return {
            "status": "cancelling",
            "job_id": _JOB_PROGRESS.get("job_id"),
            "message": "Character-purity cancellation requested.",
        }


def _set_progress_if_current(run_id: int, updates: Dict[str, Any]) -> bool:
    global _JOB_PROGRESS
    with _JOB_LOCK:
        if run_id != _JOB_RUN_ID:
            return False
        _JOB_PROGRESS = {**_JOB_PROGRESS, **updates, "updated_at": time.time()}
        return True


def _clear_worker_if_current(run_id: int, cancel_event: threading.Event) -> None:
    global _JOB_CANCEL_EVENT
    with _JOB_LOCK:
        if run_id == _JOB_RUN_ID and _JOB_CANCEL_EVENT is cancel_event:
            _JOB_CANCEL_EVENT = None


def _reset_job_state_for_tests() -> None:
    """Restore the idle module state between tests (never used in prod)."""
    global _JOB_PROGRESS, _JOB_RUN_ID, _JOB_CANCEL_EVENT, _JOB_THREAD
    with _JOB_LOCK:
        _JOB_RUN_ID += 1
        _JOB_CANCEL_EVENT = None
        _JOB_THREAD = None
        _JOB_PROGRESS = {**_IDLE_PROGRESS, "updated_at": time.time()}
    with _PREPARE_LOCK:
        _PREPARE_STATE.update({"active": False, "error": None})


def _resolve_image_paths(image_ids: List[int]) -> Dict[str, Any]:
    """Map ids -> readable paths; missing rows / dead paths count as failed."""
    ordered_ids: List[int] = []
    paths: List[str] = []
    failed_ids: List[int] = []
    for start in range(0, len(image_ids), _DB_CHUNK_SIZE):
        chunk = image_ids[start : start + _DB_CHUNK_SIZE]
        records = db.get_images_by_ids(chunk) or {}
        for image_id in chunk:
            record = records.get(image_id)
            path = str((record or {}).get("path") or "")
            if not record or not path or not os.path.exists(path):
                failed_ids.append(image_id)
                continue
            ordered_ids.append(image_id)
            paths.append(path)
    return {"ids": ordered_ids, "paths": paths, "failed_ids": failed_ids}


def _build_result(
    extracted_ids: List[int],
    analysis: Dict[str, Any],
    *,
    failed: int,
) -> Dict[str, Any]:
    distances = analysis["distances"]
    outlier_flags = analysis["outlier_flags"]
    items = [
        {
            "image_id": int(image_id),
            "distance": round(float(distance), 6),
            "outlier": bool(outlier),
        }
        for image_id, distance, outlier in zip(extracted_ids, distances, outlier_flags)
    ]
    # Worst-first ranking so the UI leads with the most suspicious images.
    items.sort(key=lambda item: item["distance"], reverse=True)
    return {
        "medoid_image_id": int(extracted_ids[analysis["medoid_index"]]),
        "items": items,
        "threshold": float(analysis["threshold"]),
        "extracted": len(extracted_ids),
        "failed": int(failed),
    }


def start_character_purity(
    request: CharacterPurityRequest,
) -> CharacterPurityStartResponse:
    """Start a cancellable character-purity worker and return immediately."""
    global _JOB_RUN_ID, _JOB_THREAD, _JOB_CANCEL_EVENT, _JOB_PROGRESS

    if not request.image_ids:
        raise HTTPException(
            status_code=400, detail="image_ids is required. / 请先选择图片。"
        )
    image_ids = list(_iter_unique_image_ids(request.image_ids))
    if len(image_ids) < 2:
        raise HTTPException(
            status_code=400,
            detail="Character purity needs at least 2 gallery images. / 角色纯度分析至少需要 2 张图库图片。",
        )
    instance = _get_ccip()
    if not instance.is_available():
        raise HTTPException(
            status_code=400,
            detail=(
                "CCIP model files are not downloaded yet — prepare the model first. "
                "/ CCIP 模型尚未下载，请先在角色纯度卡片中下载模型。"
            ),
        )
    threshold = (
        float(request.threshold)
        if request.threshold is not None
        else ccip.DEFAULT_THRESHOLD
    )

    with _JOB_LOCK:
        if str(_JOB_PROGRESS.get("status") or "idle") in _ACTIVE_STATUSES:
            raise HTTPException(
                status_code=409, detail="Character-purity analysis already in progress"
            )
        _JOB_RUN_ID += 1
        run_id = _JOB_RUN_ID
        job_id = uuid.uuid4().hex
        cancel_event = threading.Event()
        started_at = time.time()
        _JOB_CANCEL_EVENT = cancel_event
        _JOB_PROGRESS = {
            "status": "starting",
            "job_id": job_id,
            "step": "starting",
            "current": 0,
            "total": len(image_ids),
            "extracted": 0,
            "failed": 0,
            "result": None,
            "message": f"Starting character-purity analysis for {len(image_ids)} images...",
            "started_at": started_at,
            "updated_at": started_at,
        }

    def worker() -> None:
        try:
            resolved = _resolve_image_paths(image_ids)
            failed = len(resolved["failed_ids"])
            _set_progress_if_current(
                run_id,
                {
                    "status": "running",
                    "step": "extracting",
                    "failed": failed,
                    "message": f"Extracting CCIP embeddings for {len(resolved['paths'])} images...",
                },
            )

            def on_progress(done: int, total: int) -> None:
                _set_progress_if_current(
                    run_id,
                    {
                        "status": "cancelling" if cancel_event.is_set() else "running",
                        "step": "extracting",
                        "current": done,
                        "total": len(image_ids),
                        "message": f"Embedding image {done}/{total}...",
                    },
                )

            features, failed_indices = instance.extract_features(
                resolved["paths"],
                progress_callback=on_progress,
                cancel_event=cancel_event,
            )
            failed += len(failed_indices)
            failed_index_set = set(failed_indices)
            extracted_ids = [
                image_id
                for index, image_id in enumerate(resolved["ids"])
                if index not in failed_index_set
            ]

            if len(extracted_ids) < 2:
                _set_progress_if_current(
                    run_id,
                    {
                        "status": "failed",
                        "step": "failed",
                        "failed": failed,
                        "message": (
                            "Fewer than 2 images could be embedded — nothing to compare. "
                            "/ 可分析的图片不足 2 张，无法比较。"
                        ),
                    },
                )
                return

            _set_progress_if_current(
                run_id,
                {
                    "status": "cancelling" if cancel_event.is_set() else "running",
                    "step": "comparing",
                    "message": f"Comparing {len(extracted_ids)} embeddings...",
                },
            )
            if cancel_event.is_set():
                raise ccip.CCIPCancelled()
            diffs = instance.pairwise_diff(features)
            analysis = ccip.medoid_from_diffs(diffs, threshold=threshold)
            result = _build_result(extracted_ids, analysis, failed=failed)
            outliers = sum(1 for item in result["items"] if item["outlier"])
            _set_progress_if_current(
                run_id,
                {
                    "status": "done",
                    "step": "done",
                    "current": len(image_ids),
                    "extracted": result["extracted"],
                    "failed": result["failed"],
                    "result": result,
                    "message": (
                        f"Character-purity analysis finished: {result['extracted']} analyzed, "
                        f"{outliers} suspected outliers, {result['failed']} failed."
                    ),
                },
            )
        except ccip.CCIPCancelled:
            _set_progress_if_current(
                run_id,
                {
                    "status": "cancelled",
                    "step": "cancelled",
                    "message": "Character-purity analysis cancelled.",
                },
            )
        except Exception as exc:  # noqa: BLE001 - defensive worker guard
            logger.exception("Character-purity background job failed")
            _set_progress_if_current(
                run_id,
                {
                    "status": "failed",
                    "step": "failed",
                    "message": f"Character-purity analysis failed: {exc}",
                },
            )
        finally:
            _clear_worker_if_current(run_id, cancel_event)

    thread = threading.Thread(
        target=worker, name=f"character-purity-{job_id[:8]}", daemon=True
    )
    with _JOB_LOCK:
        if run_id == _JOB_RUN_ID:
            _JOB_THREAD = thread
    thread.start()

    return CharacterPurityStartResponse(
        status="started",
        job_id=job_id,
        total=len(image_ids),
        message=f"Character-purity analysis started for {len(image_ids)} images.",
    )
