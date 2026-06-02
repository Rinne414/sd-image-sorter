"""
Tag endpoints for SD Image Sorter.
Handles tag retrieval, tagging operations, import/export.

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional, Dict, Any, Callable

from fastapi import APIRouter, Depends, Query, BackgroundTasks
from fastapi.responses import FileResponse

from services.service_provider import ServiceProvider
from services.state_compat import MutableStateProxy
from services.tagging_service import (
    TaggingService,
    TagRequest,
    TagImportRequest,
    BatchTagExportRequest,
    CombinedTagExportRequest,
    ExportPreviewRequest,
)
from services.tag_export_service import combined_export_path


router = APIRouter(prefix="/api", tags=["tags"])

# Service instance - will be set via dependency injection
tag_progress: Any = None


def _bind_tagging_compat_state(service: TaggingService) -> None:
    """Keep legacy router-level progress handles pointed at the service-owned state."""
    global tag_progress
    tag_progress = service.get_progress_proxy()


def _bind_lazy_tagging_compat_state() -> None:
    """Expose legacy router-level progress without creating TaggingService at import time."""
    global tag_progress
    tag_progress = MutableStateProxy(
        lambda: get_tagging_service().get_progress(),
        lambda state: get_tagging_service().set_progress(state),
    )


_tagging_service_provider = ServiceProvider(TaggingService, on_set=_bind_tagging_compat_state)


def get_tagging_service() -> TaggingService:
    """Dependency injection for TaggingService."""
    return _tagging_service_provider.get()


def set_tagging_service(service: Optional[TaggingService]) -> None:
    """Set or clear the tagging service instance."""
    _tagging_service_provider.set(service)
    if service is None:
        _bind_lazy_tagging_compat_state()


def set_tagger_getter(tagger_getter: "Callable[..., Any]") -> None:
    """Set the tagger getter function from main module."""
    service = get_tagging_service()
    service.set_tagger_getter(tagger_getter)


def get_tag_progress_state() -> Dict[str, Any]:
    """Get the current tag progress state (for backwards compatibility)."""
    return get_tagging_service().get_progress()


def set_tag_progress_state(state: Dict[str, Any]) -> None:
    """Set the tag progress state (for backwards compatibility)."""
    get_tagging_service().set_progress(state)


_bind_lazy_tagging_compat_state()


@router.get(
    "/tags",
    summary="Get all tags",
    description="Retrieve all unique tags from the database with their occurrence counts.",
    responses={
        200: {
            "description": "List of tags with counts",
            "content": {
                "application/json": {
                    "example": {
                        "tags": [
                            {"tag": "1girl", "count": 1523},
                            {"tag": "solo", "count": 1204},
                            {"tag": "long_hair", "count": 892}
                        ]
                    }
                }
            }
        }
    }
)
def get_all_tags(
    limit: Optional[int] = Query(default=None, ge=1, description="Optional display limit; omitted returns all tags"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get all unique tags with occurrence counts."""
    return service.get_all_tags(limit)


@router.get(
    "/generators",
    summary="Get all generators",
    description="Retrieve all detected generators (ComfyUI, NAI, WebUI, Forge) with image counts.",
    responses={
        200: {
            "description": "List of generators with counts",
            "content": {
                "application/json": {
                    "example": {
                        "generators": [
                            {"generator": "comfyui", "count": 500},
                            {"generator": "nai", "count": 300},
                            {"generator": "webui", "count": 200}
                        ]
                    }
                }
            }
        }
    }
)
def get_generators(
    service: TaggingService = Depends(get_tagging_service),
):
    """Get all generators with image counts."""
    return service.get_generators()


@router.get(
    "/tags/library",
    summary="Get tags library",
    description="Get tags library with frequency counts and sorting options.",
    responses={
        200: {
            "description": "Tags library with sorting",
            "content": {
                "application/json": {
                    "example": {
                        "tags": [
                            {"tag": "1girl", "count": 1523},
                            {"tag": "solo", "count": 1204}
                        ],
                        "total": 5678,
                        "sort": "frequency"
                    }
                }
            }
        }
    }
)
def get_tags_library(
    sort_by: str = Query(default="frequency", description="Sort order: 'frequency' or 'alphabetical'"),
    limit: Optional[int] = Query(default=None, ge=1, description="Optional display limit; omitted returns all matching tags"),
    q: Optional[str] = Query(default=None, description="Search all tags with normalized substring matching"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get tags library with frequency and sorting options."""
    return service.get_tags_library(sort_by=sort_by, limit=limit, search_query=q)


@router.get("/prompts/library")
def get_prompts_library(
    limit: Optional[int] = Query(default=None, ge=1, description="Optional display limit; omitted returns all matching prompt tokens"),
    q: Optional[str] = Query(default=None, description="Search all prompt tokens with normalized substring matching"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get unique prompt tokens from images with frequency counts."""
    return service.get_prompts_library(limit=limit, search_query=q)


@router.get(
    "/loras/library",
    summary="Get LoRAs library",
    description="""
Get unique LoRAs from the normalized `image_loras` index with frequency counts.

The index is maintained from both the `loras` JSON array and `<lora:name:weight>` prompt patterns during scan/reparse. Names are normalized by stripping weight notation and file extensions.
    """,
    responses={
        200: {
            "description": "LoRAs library",
            "content": {
                "application/json": {
                    "example": {
                        "loras": [
                            {"lora": "detail_tweaker", "count": 234},
                            {"lora": "add_detail", "count": 189}
                        ],
                        "total": 45
                    }
                }
            }
        }
    }
)
def get_loras_library(
    limit: Optional[int] = Query(default=None, ge=1, description="Optional display limit; omitted returns all matching LoRAs"),
    q: Optional[str] = Query(default=None, description="Search all LoRAs with normalized substring matching"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get unique LoRAs from images with frequency counts."""
    return service.get_loras_library(limit=limit, search_query=q)


@router.get("/tags/export")
async def export_tags(
    service: TaggingService = Depends(get_tagging_service),
):
    """Export all image tags as JSON for backup/transfer."""
    return service.export_tags()


@router.post("/tags/import")
async def import_tags(
    request: TagImportRequest,
    service: TaggingService = Depends(get_tagging_service),
):
    """Import tags from exported JSON data."""
    return service.import_tags(request)


@router.post("/tag/start")
@router.post("/tag")
async def start_tagging(
    request: TagRequest,
    background_tasks: BackgroundTasks,
    service: TaggingService = Depends(get_tagging_service),
):
    """Start tagging images with WD14 tagger."""
    return service.start_tagging(request, background_tasks)


@router.get("/tagger/models")
async def get_tagger_models(
    service: TaggingService = Depends(get_tagging_service),
):
    """Get available WD14 tagger models."""
    return service.get_tagger_models()


@router.get("/tag/progress")
async def get_tag_progress(
    service: TaggingService = Depends(get_tagging_service),
):
    """Get current tagging progress."""
    return service.get_progress()


@router.post("/tag/cancel")
async def cancel_tagging(
    service: TaggingService = Depends(get_tagging_service),
):
    """Request cancellation of the current tagging task."""
    return service.cancel_tagging()


@router.post("/tag/reset")
async def reset_tag_progress(
    service: TaggingService = Depends(get_tagging_service),
):
    """Manually reset a stuck tagging task back to idle."""
    return service.reset_progress()


@router.post("/tags/export-batch")
async def export_tags_batch(
    request: BatchTagExportRequest,
    service: TaggingService = Depends(get_tagging_service),
):
    """Export tags for each image to individual .txt files."""
    return service.export_tags_batch(request)


@router.post("/tags/export-combined")
async def export_tags_combined(
    request: CombinedTagExportRequest,
    service: TaggingService = Depends(get_tagging_service),
):
    """Render selected captions into one server-side downloadable text file."""
    return service.export_tags_combined(request)


@router.get("/tags/export-combined/download/{token}")
async def download_combined_export(token: str):
    """Download a server-rendered combined export without building a JS Blob."""
    path = combined_export_path(token)
    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        filename=f"sd-image-sorter-combined-{token[:8]}.txt",
    )


@router.post("/tags/fix-ratings")
async def fix_rating_tags(
    service: TaggingService = Depends(get_tagging_service),
):
    """Clean up duplicate rating tags in existing database."""
    return service.fix_rating_tags()



# === v3.2.1: Export Template Engine endpoints ===


@router.post("/tags/export-preview")
async def export_preview(
    request: ExportPreviewRequest,
    service: TaggingService = Depends(get_tagging_service),
):
    """Render export captions for a small set of images using the template engine.

    Used by the export modal's live preview to show what the final captions
    will look like before committing to a batch export.
    """
    return service.export_preview(request)


@router.get("/tags/export-presets")
async def export_presets():
    """Return list of LoRA training presets for the export modal."""
    from services.export_template_engine import list_presets, TEMPLATE_VARIABLES
    return {
        "presets": list_presets(),
        "variables": TEMPLATE_VARIABLES,
    }
