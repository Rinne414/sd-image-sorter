"""
Tag endpoints for SD Image Sorter.
Handles tag retrieval, tagging operations, import/export.

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional, List, Dict, Any, Callable

from fastapi import APIRouter, Depends, Query, BackgroundTasks

from services.tagging_service import (
    TaggingService,
    TagRequest,
    TagImportRequest,
    BatchTagExportRequest,
)


router = APIRouter(prefix="/api", tags=["tags"])

# Service instance - will be set via dependency injection
_tagging_service: Optional[TaggingService] = None
tag_progress: Any = None


def _bind_tagging_compat_state(service: TaggingService) -> None:
    """Keep legacy router-level progress handles pointed at the service-owned state."""
    global tag_progress
    tag_progress = service.get_progress_proxy()


def get_tagging_service() -> TaggingService:
    """Dependency injection for TaggingService."""
    global _tagging_service
    if _tagging_service is None:
        _tagging_service = TaggingService()
        _bind_tagging_compat_state(_tagging_service)
    return _tagging_service


def set_tagging_service(service: TaggingService) -> None:
    """Set the tagging service instance."""
    global _tagging_service
    _tagging_service = service
    _bind_tagging_compat_state(service)


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


if tag_progress is None:
    _bind_tagging_compat_state(get_tagging_service())


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
async def get_all_tags(
    limit: int = Query(default=500, ge=1, le=100000, description="Maximum tags to return"),
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
async def get_generators(
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
async def get_tags_library(
    sort_by: str = Query(default="frequency", description="Sort order: 'frequency' or 'alphabetical'"),
    limit: int = Query(default=1000, ge=1, le=100000, description="Maximum tags to return"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get tags library with frequency and sorting options."""
    return service.get_tags_library(sort_by, limit)


@router.get("/prompts/library")
async def get_prompts_library(
    limit: int = Query(default=500, ge=1, le=100000, description="Maximum prompt tokens to return"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get unique prompt tokens from images with frequency counts."""
    return service.get_prompts_library(limit)


@router.get(
    "/loras/library",
    summary="Get LoRAs library",
    description="""
Get unique LoRAs from images with frequency counts.

LoRA names are extracted from both:
- The `loras` JSON array in the database
- `<lora:name:weight>` patterns in prompts

Names are normalized by stripping weight notation and file extensions.
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
async def get_loras_library(
    limit: int = Query(default=500, ge=1, le=100000, description="Maximum LoRAs to return"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get unique LoRAs from images with frequency counts."""
    return service.get_loras_library(limit)


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


@router.post("/tags/fix-ratings")
async def fix_rating_tags(
    service: TaggingService = Depends(get_tagging_service),
):
    """Clean up duplicate rating tags in existing database."""
    return service.fix_rating_tags()
