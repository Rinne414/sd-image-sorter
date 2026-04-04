"""
Sorting endpoints for SD Image Sorter.
Handles scanning, moving, batch operations, and manual sort sessions.

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, BackgroundTasks, Query

from services.sorting_service import (
    SortingService,
    ScanRequest,
    ValidatePathRequest,
    MoveRequest,
    BatchMoveRequest,
    FolderConfig,
)


router = APIRouter(prefix="/api", tags=["sorting"])

# Service instance - will be set via dependency injection
_sorting_service: Optional[SortingService] = None


def get_sorting_service() -> SortingService:
    """Dependency injection for SortingService."""
    global _sorting_service
    if _sorting_service is None:
        _sorting_service = SortingService()
    return _sorting_service


def set_sorting_service(service: SortingService) -> None:
    """Set the sorting service instance."""
    global _sorting_service
    _sorting_service = service


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


# Property for backward compatibility with tests
class _ScanProgressProxy:
    """Proxy object that provides attribute-style access to scan progress."""

    def __getitem__(self, key):
        return get_sorting_service().get_scan_progress()[key]

    def __setitem__(self, key, value):
        progress = get_sorting_service().get_scan_progress()
        progress[key] = value
        get_sorting_service().set_scan_progress(progress)

    def copy(self):
        return get_sorting_service().get_scan_progress().copy()


class _SortSessionProxy:
    """Proxy object that provides attribute-style access to sort session."""

    def __getitem__(self, key):
        return get_sorting_service().get_sort_session()[key]

    def __setitem__(self, key, value):
        session = get_sorting_service().get_sort_session()
        session[key] = value
        get_sorting_service().set_sort_session(session)

    def copy(self):
        return get_sorting_service().get_sort_session().copy()


scan_progress = _ScanProgressProxy()
sort_session = _SortSessionProxy()


# Import BatchTagExportRequest for export endpoint
from services.tagging_service import BatchTagExportRequest


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


@router.post(
    "/scan",
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
            "content": {"application/json": {"example": {"status": "started", "message": "Scan started in background"}}}
        },
        400: {
            "description": "Invalid folder or scan already running",
            "content": {"application/json": {"example": {"detail": "Scan already in progress"}}}
        }
    }
)
async def start_scan(
    request: ScanRequest,
    background_tasks: BackgroundTasks,
    service: SortingService = Depends(get_sorting_service),
):
    """Start scanning a folder for images."""
    return service.start_scan(request, background_tasks)


@router.get("/scan/progress")
async def get_scan_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Get current scan progress."""
    return service.get_scan_progress()


@router.post("/scan/reset")
async def reset_scan_progress(
    service: SortingService = Depends(get_sorting_service),
):
    """Manually reset a stuck scan task back to idle."""
    return service.reset_scan_progress()


@router.post("/move")
async def move_images(
    request: MoveRequest,
    service: SortingService = Depends(get_sorting_service),
):
    """Move specific images to a folder."""
    return service.move_images(request)


@router.post("/batch-move")
async def batch_move_images(
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


@router.post("/sort/start")
async def start_sort_session(
    generators: Optional[str] = Query(default=None, max_length=1000),
    tags: Optional[str] = Query(default=None, max_length=1000),
    ratings: Optional[str] = Query(default=None, max_length=1000),
    checkpoints: Optional[str] = Query(default=None, max_length=1000),
    loras: Optional[str] = Query(default=None, max_length=1000),
    prompts: Optional[str] = Query(default=None, max_length=1000),
    search: Optional[str] = Query(default=None, max_length=1000),
    min_width: Optional[int] = Query(default=None, ge=1, le=100000),
    max_width: Optional[int] = Query(default=None, ge=1, le=100000),
    min_height: Optional[int] = Query(default=None, ge=1, le=100000),
    max_height: Optional[int] = Query(default=None, ge=1, le=100000),
    aspect_ratio: Optional[str] = Query(default=None),
    folders: Optional[str] = Query(default=None, max_length=4096),
    service: SortingService = Depends(get_sorting_service),
):
    """Start a manual sort session."""
    return service.start_sort_session(
        generators=generators,
        tags=tags,
        ratings=ratings,
        checkpoints=checkpoints,
        loras=loras,
        prompts=prompts,
        search=search,
        min_width=min_width,
        max_width=max_width,
        min_height=min_height,
        max_height=max_height,
        aspect_ratio=aspect_ratio,
        folders=folders,
    )


@router.get("/sort/current")
async def get_current_sort_image(
    service: SortingService = Depends(get_sorting_service),
):
    """Get the current image in the sort session."""
    return service.get_current_sort_image()


@router.post("/sort/action")
async def sort_action(
    action: str = Query(..., description="Action: move, skip, undo"),
    folder_key: Optional[str] = Query(default=None, max_length=100),
    service: SortingService = Depends(get_sorting_service),
):
    """Perform a sort action: move (with folder_key), skip, or undo."""
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
async def clear_gallery(
    service: SortingService = Depends(get_sorting_service),
):
    """Clear all image records from the database."""
    return service.clear_gallery()


@router.get("/analytics")
async def get_analytics(
    service: SortingService = Depends(get_sorting_service),
):
    """Get popular tags, checkpoints, and loras."""
    return service.get_analytics()


@router.get("/stats")
async def get_stats(
    service: SortingService = Depends(get_sorting_service),
):
    """Get database statistics."""
    return service.get_stats()
