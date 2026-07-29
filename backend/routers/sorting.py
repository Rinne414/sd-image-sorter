"""
Sorting endpoints for SD Image Sorter.
Handles scanning, moving, batch operations, and manual sort sessions.

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Body, Depends, BackgroundTasks, File, HTTPException, Query, UploadFile

from services.aesthetic_service import AestheticService
from services.gallery_job_gate import (
    gallery_job_transition,
    get_gallery_job_activity,
)
from services.service_provider import ServiceProvider
from services.state_compat import MutableStateProxy
from services.sorting_models import (
    BatchMoveRequest,
    BrowseFolderRequest,
    FolderConfig,
    LibraryAutoRefreshResponse,
    ManualSortStartRequest,
    MoveRequest,
    SCAN_ACTIVE_STATUSES,
    SCAN_SOURCE_MANUAL,
    SCAN_TERMINAL_STATUSES,
    ScanAcknowledgeRequest,
    ScanAcknowledgeResponse,
    ScanCancelRequest,
    ScanCancelResponse,
    ScanProgressResponse,
    ScanRequest,
    ScanStartResponse,
    ValidatePathRequest,
)
from services.sorting_service import SortingService
from services.tagging_pipeline_service import (
    GalleryMutationActivity,
    TaggingPipelineService,
    get_tagging_pipeline_service,
)
from services.tagging_service import TaggingService


router = APIRouter(prefix="/api", tags=["sorting"])

# Service instance - will be set via dependency injection
scan_progress: Any = None
sort_session: Any = None

def _bind_sorting_compat_state(service: SortingService) -> None:
    """Keep legacy router-level state handles pointed at the service-owned state."""
    global scan_progress, sort_session
    scan_progress = service.get_scan_progress_proxy()
    sort_session = service.get_sort_session_proxy()


def _bind_lazy_sorting_compat_state() -> None:
    """Expose legacy router-level state without creating SortingService at import time."""
    global scan_progress, sort_session
    scan_progress = MutableStateProxy(
        lambda: get_sorting_service().get_scan_progress(),
        lambda state: get_sorting_service().set_scan_progress(state),
    )
    sort_session = MutableStateProxy(
        lambda: get_sorting_service().get_sort_session(),
        lambda state: get_sorting_service().set_sort_session(state),
    )


_sorting_service_provider = ServiceProvider(SortingService, on_set=_bind_sorting_compat_state)


def get_sorting_service() -> SortingService:
    """Dependency injection for SortingService."""
    return _sorting_service_provider.get()


def _get_tagging_service_for_clear() -> TaggingService:
    """Resolve the router-owned Gallery tagging service without an import cycle."""
    from routers.tags import get_tagging_service

    return get_tagging_service()


def _get_aesthetic_service_for_clear() -> AestheticService:
    """Resolve the router-owned Aesthetic service without an import cycle."""
    from routers.aesthetic import get_aesthetic_service

    return get_aesthetic_service()


def _status_probe_http_error(job: str, error: Exception) -> HTTPException:
    error_message = str(error).strip() or error.__class__.__name__
    return HTTPException(
        status_code=503,
        detail={
            "code": "gallery_clear_status_unknown",
            "message": (
                f"Could not verify {job} state, so Gallery was not cleared: "
                f"{error_message}"
            ),
            "job": job,
            "error_type": error.__class__.__name__,
        },
    )


def _require_clear_gallery_jobs_idle(
    sorting_service: SortingService,
    tagging_service: TaggingService,
    pipeline_service: TaggingPipelineService,
    aesthetic_service: AestheticService,
) -> None:
    active_jobs: list[str] = []

    try:
        scan_progress = sorting_service.get_scan_progress()
        scan_status = scan_progress.get("status")
        valid_scan_statuses = {"idle", *SCAN_ACTIVE_STATUSES, *SCAN_TERMINAL_STATUSES}
        if not isinstance(scan_status, str) or scan_status not in valid_scan_statuses:
            raise ValueError(f"unexpected scan status {scan_status!r}")
        scan_worker_active = sorting_service.is_scan_worker_active()
        if not isinstance(scan_worker_active, bool):
            raise TypeError("scan worker activity must be a boolean")
        if scan_status in SCAN_ACTIVE_STATUSES or scan_worker_active:
            active_jobs.append("scan")
    except Exception as exc:
        raise _status_probe_http_error("scan", exc) from exc

    try:
        activity = pipeline_service.get_gallery_mutation_activity(
            legacy_service=tagging_service,
        )
        if not isinstance(activity, GalleryMutationActivity):
            raise TypeError("AI tagging activity must be GalleryMutationActivity")
        if activity.state not in {"idle", "busy", "unknown"}:
            raise ValueError(f"unexpected AI tagging activity {activity.state!r}")
        if not isinstance(activity.jobs, tuple) or not all(
            isinstance(job, str) and job for job in activity.jobs
        ):
            raise TypeError("AI tagging activity jobs must be non-empty strings")
        if not isinstance(activity.detail, str):
            raise TypeError("AI tagging activity detail must be a string")
        if activity.state == "idle" and activity.jobs:
            raise ValueError("idle AI tagging activity must not include jobs")
        if activity.state in {"busy", "unknown"} and not activity.jobs:
            raise ValueError(
                f"{activity.state} AI tagging activity must include jobs"
            )
    except Exception as exc:
        raise _status_probe_http_error("ai_tagging", exc) from exc
    if activity.state == "unknown":
        raise HTTPException(
            status_code=503,
            detail={
                "code": "gallery_clear_status_unknown",
                "message": (
                    "Could not verify AI tagging/caption state, so Gallery "
                    f"was not cleared: {activity.detail}"
                ),
                "job": "ai_tagging",
                "jobs": list(activity.jobs),
            },
        )
    if activity.state == "busy":
        active_jobs.extend(activity.jobs)

    try:
        route_activity = get_gallery_job_activity()
        if not isinstance(route_activity, tuple) or not all(
            isinstance(job, str) and job for job in route_activity
        ):
            raise TypeError("Gallery route activity jobs must be non-empty strings")
        active_jobs.extend(route_activity)
    except Exception as exc:
        raise _status_probe_http_error("gallery_route_activity", exc) from exc

    try:
        aesthetic_progress = aesthetic_service.get_scoring_progress()
        aesthetic_running = aesthetic_progress.get("running")
        if not isinstance(aesthetic_running, bool):
            raise TypeError("aesthetic progress must include boolean running")
        if aesthetic_running:
            active_jobs.append("aesthetic")
    except Exception as exc:
        raise _status_probe_http_error("aesthetic", exc) from exc

    if active_jobs:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "gallery_clear_jobs_active",
                "message": (
                    "Cannot clear Gallery while background image jobs are "
                    "active or queued. Stop or cancel them first."
                ),
                "jobs": list(dict.fromkeys(active_jobs)),
            },
        )


def set_sorting_service(service: Optional[SortingService]) -> None:
    """Set or clear the sorting service instance."""
    _sorting_service_provider.set(service)
    if service is None:
        _bind_lazy_sorting_compat_state()


def load_session_from_disk() -> None:
    """Load persisted session from disk on startup."""
    get_sorting_service().load_session_from_disk()


def get_scan_progress_state() -> Dict[str, Any]:
    """Get the current scan progress (for backwards compatibility)."""
    return get_sorting_service().get_scan_progress()


def set_scan_progress_state(state: Dict[str, Any]) -> None:
    """Set the scan progress state (for backwards compatibility)."""
    get_sorting_service().set_scan_progress(state)


def get_sort_session() -> Dict[str, Any]:
    """Get the current sort session (for backwards compatibility)."""
    return get_sorting_service().get_sort_session()


def set_sort_session(session: Dict[str, Any]) -> None:
    """Set the sort session (for backwards compatibility)."""
    get_sorting_service().set_sort_session(session)


_bind_lazy_sorting_compat_state()


@router.post(
    "/validate-path",
    summary="Validate folder path",
    description="Validate a folder path for inline UI feedback before starting operations.",
    responses={
        200: {
            "description": "Validation result",
            "content": {
                "application/json": {
                    "example": {"valid": True, "error": None}
                }
            }
        }
    }
)
async def validate_path(
    request: ValidatePathRequest,
    service: SortingService = Depends(get_sorting_service),
):
    """Validate a folder path for inline UI feedback."""
    return service.validate_path(request)


@router.get(
    "/system-info",
    summary="Get system hardware info and tagger recommendations",
    description="Detect system hardware (RAM, GPU, VRAM) and return recommended tagger configuration.",
    responses={
        200: {
            "description": "System info and tagger recommendations",
            "content": {
                "application/json": {
                    "example": {
                        "system_info": {
                            "total_ram_gb": 32.0,
                            "gpu_name": "NVIDIA GeForce RTX 3080",
                            "gpu_vram_total_mb": 10240,
                        },
                        "recommendation": {
                            "recommended_batch_size": 4,
                            "recommended_use_gpu": True,
                            "risk_level": "low",
                        }
                    }
                }
            }
        }
    }
)
async def get_system_info_endpoint():
    """Get system hardware info and recommended tagger configuration."""
    service = get_sorting_service()
    return service.get_system_info_payload()


@router.get(
    "/system/ai-jobs",
    summary="Get in-flight AI runtime jobs",
    description="v3.3.0 PERF-2: snapshot of active AI runtime leases (VRAM-exclusive vs CPU-pool) for a status badge.",
)
async def get_ai_jobs_endpoint():
    """Return a snapshot of in-flight AI runtime leases."""
    from ai_runtime_guard import get_ai_jobs_snapshot
    return get_ai_jobs_snapshot()


@router.post(
    "/browse-folder",
    summary="Browse folder contents",
    description="List subdirectories of a given folder path. Empty path lists drive letters (Windows) or root (Linux).",
    responses={
        200: {
            "description": "Folder contents",
            "content": {
                "application/json": {
                    "example": {
                        "current": "C:\\Users",
                        "parent": "C:\\",
                        "subdirs": [
                            {"name": "Public", "path": "C:\\Users\\Public", "has_children": True}
                        ]
                    }
                }
            }
        },
        400: {"description": "Invalid folder path"},
        403: {"description": "Cannot read directory"},
    }
)
async def browse_folder(
    request: BrowseFolderRequest,
    service: SortingService = Depends(get_sorting_service),
):
    """Browse a folder and list its subdirectories."""
    return service.browse_folder(request.path)


@router.post("/resolve-drop")
async def resolve_drop(
    data: Dict[str, Any],
    service: SortingService = Depends(get_sorting_service),
):
    """Resolve dropped filenames or folder name to a filesystem path."""
    folder_name = str(data.get("folder_name") or "").strip()
    filenames = list(data.get("filenames") or [])
    dropped_files = data.get("files") or []
    return service.resolve_drop(folder_name, filenames, dropped_files=dropped_files)


@router.post("/import-files")
async def import_files(
    files: List[UploadFile] = File(...),
    service: SortingService = Depends(get_sorting_service),
):
    """Import uploaded image files directly into the gallery."""
    return await service.import_uploaded_files(files)


@router.post(
    "/scan",
    response_model=ScanStartResponse,
    summary="Start folder scan",
    description="""
Start scanning a folder for images to add to the database.

The scan runs in the background. Poll `/api/scan/progress` to track status.
Scans recursively by default, extracting metadata from PNG/WebP files.

**Supported metadata formats:**
- ComfyUI: JSON workflow in PNG text chunks
- NovelAI: JSON in Comment text chunk
- WebUI/Forge: parameters text chunk
- WebP: EXIF and XMP metadata
    """,
    responses={
        200: {
            "description": "Scan started",
            "content": {"application/json": {"example": {
                "status": "started",
                "message": "Scan started in background",
                "run_id": 42,
                "source": "manual",
            }}}
        },
        400: {
            "description": "Invalid folder",
        },
        409: {
            "description": "Scan already running or prior manual completion is pending",
            "content": {"application/json": {"example": {
                "error": "Scan already in progress",
                "type": "HTTPException",
                "status_code": 409,
            }}}
        }
    }
)
async def start_scan(
    request: ScanRequest,
    background_tasks: BackgroundTasks,
    service: SortingService = Depends(get_sorting_service),
):
    """Start scanning a folder for images."""
    return service.start_scan(request, background_tasks, SCAN_SOURCE_MANUAL)


@router.get("/scan/progress", response_model=ScanProgressResponse)
async def get_scan_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Get current scan progress."""
    return service.get_scan_progress()


@router.post("/scan/acknowledge", response_model=ScanAcknowledgeResponse)
async def acknowledge_scan_terminal(
    request: ScanAcknowledgeRequest,
    service: SortingService = Depends(get_sorting_service),
):
    """Clear the exact manual terminal scan result observed by the client."""
    return service.acknowledge_scan_terminal(request)


@router.post("/scan/cancel", response_model=ScanCancelResponse)
async def cancel_scan(
    request: ScanCancelRequest,
    service: SortingService = Depends(get_sorting_service),
):
    """Request cancellation of the current scan task."""
    return service.cancel_scan(request)


@router.post("/scan/reset")
async def reset_scan_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Manually reset a stuck scan task back to idle."""
    return service.reset_scan_progress()


@router.delete(
    "/library-roots/{root_id}",
    summary="Unregister a library root",
    description="v3.3.2 Library Navigation: remove a registered library root. Indexed images stay in the gallery — only the source registration is removed.",
)
async def remove_library_root(
    root_id: int,
    service: SortingService = Depends(get_sorting_service),
):
    """Unregister a library root (does not delete its images)."""
    return service.remove_library_root(root_id)


@router.post(
    "/library-roots/{root_id}/rescan",
    response_model=ScanStartResponse,
    summary="Rescan a library root",
    description="v3.3.2 Library Navigation: quick-import re-scan of a registered root to pick up new or changed files. Runs in the background; poll /api/scan/progress.",
)
async def rescan_library_root(
    root_id: int,
    background_tasks: BackgroundTasks,
    service: SortingService = Depends(get_sorting_service),
):
    """Re-scan a registered library root for new files."""
    return service.rescan_library_root(root_id, background_tasks)


@router.post(
    "/library/auto-refresh",
    response_model=LibraryAutoRefreshResponse,
    response_model_exclude_none=True,
    summary="Idle auto-refresh of library roots",
    description="v3.3.2 Library Navigation: quick-import re-scan of the stalest enabled root to surface newly added files. No-op while a scan is running or when no roots are enabled; never runs AI tagging (GPU safety).",
)
async def auto_refresh_library(
    background_tasks: BackgroundTasks,
    service: SortingService = Depends(get_sorting_service),
):
    """Idle-triggered background refresh of enabled library roots."""
    return service.auto_refresh_library(background_tasks)


@router.post("/move")
def move_images(
    request: MoveRequest,
    service: SortingService = Depends(get_sorting_service),
):
    """Move or copy specific images to a folder (synchronous; returns per-id
    results). The gallery UI uses ``/api/move/start`` for progress; this stays
    for programmatic callers and tests."""
    return service.move_images(request)


@router.post("/move/start")
def start_move_job(
    request: MoveRequest,
    background_tasks: BackgroundTasks,
    service: SortingService = Depends(get_sorting_service),
):
    """v3.3.0 USR-1: start a background move/copy job with progress polling."""
    return service.start_move_job(request, background_tasks)


@router.get("/move/progress")
async def get_move_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Get current gallery move/copy job progress."""
    return service.get_move_progress()


@router.post("/move/reset")
async def reset_move_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Reset a stuck move job."""
    return service.reset_move_progress()


@router.post("/move/cancel")
async def cancel_move(
    service: SortingService = Depends(get_sorting_service),
):
    """Request cooperative cancellation of the active move job."""
    return service.cancel_move()


@router.post("/batch-move")
def batch_move_images(
    request: BatchMoveRequest,
    background_tasks: BackgroundTasks,
    service: SortingService = Depends(get_sorting_service),
):
    """Move all images matching filters to a folder."""
    return service.batch_move_images(request, background_tasks)


@router.get("/batch-move/progress")
async def get_batch_move_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Get current batch move progress."""
    return service.get_batch_move_progress()


@router.post("/batch-move/reset")
async def reset_batch_move_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Reset a stuck batch move task."""
    return service.reset_batch_move_progress()


@router.post("/batch-move/cancel")
async def cancel_batch_move(
    service: SortingService = Depends(get_sorting_service),
):
    """Request cooperative cancellation of the active batch-move task."""
    return service.cancel_batch_move()



@router.post("/sort/start")
async def start_sort_session(
    request: Optional[ManualSortStartRequest] = Body(default=None),
    generators: Optional[str] = Query(default=None),
    tags: Optional[str] = Query(default=None),
    tag_mode: str = Query(default="and", pattern="^(and|or)$"),
    ratings: Optional[str] = Query(default=None),
    checkpoints: Optional[str] = Query(default=None),
    loras: Optional[str] = Query(default=None),
    prompts: Optional[str] = Query(default=None),
    prompt_match_mode: str = Query(default="exact", pattern="^(exact|contains)$"),
    artist: Optional[str] = Query(default=None, max_length=500),
    search: Optional[str] = Query(default=None, max_length=1000),
    min_width: Optional[int] = Query(default=None, ge=1, le=100000),
    max_width: Optional[int] = Query(default=None, ge=1, le=100000),
    min_height: Optional[int] = Query(default=None, ge=1, le=100000),
    max_height: Optional[int] = Query(default=None, ge=1, le=100000),
    aspect_ratio: Optional[str] = Query(default=None),
    min_aesthetic: Optional[float] = Query(default=None, ge=0, le=10),
    max_aesthetic: Optional[float] = Query(default=None, ge=0, le=10),
    exclude_tags: Optional[str] = Query(default=None),
    exclude_generators: Optional[str] = Query(default=None),
    exclude_ratings: Optional[str] = Query(default=None),
    exclude_checkpoints: Optional[str] = Query(default=None),
    exclude_loras: Optional[str] = Query(default=None),
    folders: Optional[str] = Query(default=None, max_length=4096),
    operation_mode: str = Query(default="move", max_length=16),
    replace_existing: bool = Query(default=False),
    mode: str = Query(default="slot", max_length=16),
    service: SortingService = Depends(get_sorting_service),
):
    """Start a manual sort session."""
    if request is not None:
        return service.start_sort_session(
            generators=request.generators,
            tags=request.tags,
            tag_mode=request.tag_mode,
            ratings=request.ratings,
            checkpoints=request.checkpoints,
            loras=request.loras,
            prompts=request.prompts,
            prompt_match_mode=request.prompt_match_mode,
            artist=request.artist,
            search=request.search,
            min_width=request.min_width,
            max_width=request.max_width,
            min_height=request.min_height,
            max_height=request.max_height,
            aspect_ratio=request.aspect_ratio,
            min_aesthetic=request.min_aesthetic,
            max_aesthetic=request.max_aesthetic,
            folders=request.folders,
            operation_mode=request.operation_mode,
            replace_existing=request.replace_existing,
            exclude_tags=request.exclude_tags,
            exclude_generators=request.exclude_generators,
            exclude_ratings=request.exclude_ratings,
            exclude_checkpoints=request.exclude_checkpoints,
            exclude_loras=request.exclude_loras,
            collection_slots=request.collection_slots,
            mode=request.mode,
            # v3.3.x gallery-scope parity (Finding: filter→scope dropped
            # collection/folder/rating/exclude/brightness scopes on this path)
            min_user_rating=request.min_user_rating,
            brightness_min=request.brightness_min,
            brightness_max=request.brightness_max,
            color_temperature=request.color_temperature,
            brightness_distribution=request.brightness_distribution,
            exclude_prompts=request.exclude_prompts,
            exclude_colors=request.exclude_colors,
            collection_id=request.collection_id,
            scope=request.scope,
            folder=request.folder,
            has_metadata=request.has_metadata,
        )

    return service.start_sort_session(
        generators=generators,
        tags=tags,
        tag_mode=tag_mode,
        ratings=ratings,
        checkpoints=checkpoints,
        loras=loras,
        prompts=prompts,
        prompt_match_mode=prompt_match_mode,
        artist=artist,
        search=search,
        min_width=min_width,
        max_width=max_width,
        min_height=min_height,
        max_height=max_height,
        aspect_ratio=aspect_ratio,
        min_aesthetic=min_aesthetic,
        max_aesthetic=max_aesthetic,
        folders=folders,
        operation_mode=operation_mode,
        replace_existing=replace_existing,
        exclude_tags=exclude_tags,
        exclude_generators=exclude_generators,
        exclude_ratings=exclude_ratings,
        exclude_checkpoints=exclude_checkpoints,
        exclude_loras=exclude_loras,
        mode=mode,
    )


@router.get("/sort/current")
async def get_current_sort_image(
    service: SortingService = Depends(get_sorting_service),
):
    """Get the current image in the sort session."""
    return service.get_current_sort_image()


@router.post("/sort/action")
def sort_action(
    action: str = Query(..., description="Action: move, skip, undo, redo, collect"),
    folder_key: Optional[str] = Query(default=None, max_length=100),
    service: SortingService = Depends(get_sorting_service),
):
    """Perform a sort action: move/collect (with folder_key), skip, undo, or redo.

    v3.3.1: ``collect`` adds the current image to the collection mapped to
    ``folder_key`` by reference (no file move) and advances the cursor.
    """
    return service.sort_action(action, folder_key)


@router.post("/sort/set-folders")
async def set_sort_folders(
    config: FolderConfig,
    service: SortingService = Depends(get_sorting_service),
):
    """Set folder destinations for sort keys."""
    return service.set_sort_folders(config)


@router.get("/sort/folders")
async def get_sort_folders(
    service: SortingService = Depends(get_sorting_service),
):
    """Get current folder configuration."""
    return service.get_sort_folders()


@router.delete("/sort/session")
async def clear_sort_session(
    service: SortingService = Depends(get_sorting_service),
):
    """Clear the current sort session."""
    return service.clear_sort_session()


@router.delete("/clear-gallery")
def clear_gallery(
    service: SortingService = Depends(get_sorting_service),
    tagging_service: TaggingService = Depends(_get_tagging_service_for_clear),
    pipeline_service: TaggingPipelineService = Depends(get_tagging_pipeline_service),
    aesthetic_service: AestheticService = Depends(_get_aesthetic_service_for_clear),
) -> Dict[str, str]:
    """Clear all image records from the database."""
    with gallery_job_transition():
        _require_clear_gallery_jobs_idle(
            service,
            tagging_service,
            pipeline_service,
            aesthetic_service,
        )
        return service.clear_gallery()


@router.get("/analytics")
def get_analytics(
    facet: Optional[str] = Query(default=None, description="Optional facet to fetch: checkpoints, loras, or tags"),
    q: Optional[str] = Query(default=None, description="Search all values in the selected facet"),
    limit: Optional[int] = Query(default=None, ge=1, description="Optional display limit; omitted returns all matching values"),
    service: SortingService = Depends(get_sorting_service),
):
    """Get popular tags, checkpoints, and loras."""
    return service.get_analytics(facet=facet, search_query=q, limit=limit)


@router.get("/stats")
def get_stats(
    service: SortingService = Depends(get_sorting_service),
):
    """Get database statistics."""
    return service.get_stats()


@router.get("/library-health")
def get_library_health(
    sample_limit: int = Query(default=8, ge=1, le=25, description="Maximum number of sample rows per library-health section"),
    service: SortingService = Depends(get_sorting_service),
):
    """Get read-only library quality, metadata, duplicate-name, and archive-readiness signals.

    v3.2.2: this route is intentionally synchronous (``def`` not
    ``async def``) so FastAPI offloads it to the thread pool. The
    underlying report does heavy SQL aggregations and was blocking
    the event loop when called from the home page + diagnostics
    panel + gallery simultaneously. The service layer also now
    caches the report for 60 seconds via
    ``invalidate_library_health_cache``.
    """
    return service.get_library_health(sample_limit=sample_limit)
