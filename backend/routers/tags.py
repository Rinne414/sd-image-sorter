"""
Tag endpoints for SD Image Sorter.
Handles tag retrieval, tagging operations, import/export.

Refactored to use Service Layer pattern with dependency injection.
"""
from typing import Optional, List, Dict, Any, Callable

from fastapi import APIRouter, Depends, Query, BackgroundTasks

from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS
from services.tagging_service import (
    TaggingService,
    TagRequest,
    TagImportRequest,
    BatchTagExportRequest,
)


router = APIRouter(prefix="/api", tags=["tags"])

TAGGER_MODEL_HINTS = {
    "wd-eva02-large-tagger-v3": {
        "summary": "Most accurate overall. In this app it runs in protected CPU Safe Mode so Max Quality stays stable.",
        "speed": "Slow",
        "memory": "High",
        "best_for": "Max Quality / final library cleanup",
        "safe_mode_note": "GPU is locked off for this model inside the app. Quality stays high; runtime is tuned to avoid crashes.",
        "gpu_default": False,
        "gpu_confirmation_required": False,
        "gpu_locked": True,
        "runtime_note": "Protected CPU Safe Mode. Highest quality, safer runtime.",
        "quality_score": 5,
        "speed_score": 2,
        "stability_score": 4,
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
}

# Service instance - will be set via dependency injection
_tagging_service: Optional[TaggingService] = None


def get_tagging_service() -> TaggingService:
    """Dependency injection for TaggingService."""
    global _tagging_service
    if _tagging_service is None:
        _tagging_service = TaggingService()
    return _tagging_service


def set_tagging_service(service: TaggingService) -> None:
    """Set the tagging service instance."""
    global _tagging_service
    _tagging_service = service


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


# Property for backward compatibility with tests
class _TagProgressProxy:
    """Proxy object that provides attribute-style access to tag progress."""

    def __getitem__(self, key):
        return get_tagging_service().get_progress()[key]

    def __setitem__(self, key, value):
        progress = get_tagging_service().get_progress()
        progress[key] = value
        get_tagging_service().set_progress(progress)

    def copy(self):
        return get_tagging_service().get_progress().copy()


tag_progress = _TagProgressProxy()


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
    limit: int = Query(default=500, ge=1, le=10000, description="Maximum tags to return"),
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
    limit: int = Query(default=1000, ge=1, le=10000, description="Maximum tags to return"),
    service: TaggingService = Depends(get_tagging_service),
):
    """Get tags library with frequency and sorting options."""
    return service.get_tags_library(sort_by, limit)


@router.get("/prompts/library")
async def get_prompts_library(
    limit: int = Query(default=500, ge=1, le=10000, description="Maximum prompt tokens to return"),
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
    limit: int = Query(default=500, ge=1, le=10000, description="Maximum LoRAs to return"),
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
async def get_tagger_models():
    """Get available WD14 tagger models."""
    models = [
        {
            "name": name,
            "path": config["repo_id"],
            "description": TAGGER_MODEL_HINTS.get(name, {}).get("summary", f"{name} model"),
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
        }
        for name, config in TAGGER_MODELS.items()
    ]
    return {
        "models": models,
        "default": DEFAULT_TAGGER_MODEL,
    }


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
