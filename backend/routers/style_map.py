"""Style map API: style-vector extraction jobs (slice S1).

The map itself (projection, near-duplicate merging) arrives in a later slice;
this router only starts, watches, pauses, resumes and cancels the job that
fills ``image_style_vectors``. Database access stays in StyleVectorService.
DB-backed endpoints are plain ``def`` (aesthetic router precedent) so their
SQLite work runs in the threadpool instead of on the event loop.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Response
from pydantic import BaseModel, Field, field_validator

from routers.artists import ArtistModelConfig
from services.service_provider import ServiceProvider
from services.style_map_service import STYLE_MAP_SPACES, StyleMapService
from services.style_vector_service import STYLE_VECTOR_SPACES, StyleVectorService

router = APIRouter(prefix="/api/style-map", tags=["style-map"])

# Same ceiling as /api/artists/identify-batch: the worker walks ids one at a
# time, so only the request payload itself is bounded here.
STYLE_VECTOR_BATCH_IMAGE_LIMIT = 5_000_000
_SPACE_PATTERN = "^(" + "|".join(STYLE_VECTOR_SPACES) + ")$"

_style_vector_service_provider = ServiceProvider(StyleVectorService)
get_style_vector_service = _style_vector_service_provider.get
set_style_vector_service = _style_vector_service_provider.set

_MAP_SPACE_PATTERN = "^(" + "|".join(STYLE_MAP_SPACES) + ")$"
_style_map_service_provider = ServiceProvider(StyleMapService)
get_style_map_service = _style_map_service_provider.get
set_style_map_service = _style_map_service_provider.set


class StartVectorsRequest(ArtistModelConfig):
    """Model selection is the Style Finder contract (source, local path, use_gpu)."""

    space: str = Field("kaloscope", pattern=_SPACE_PATTERN)
    image_ids: Optional[List[int]] = Field(
        default=None,
        min_length=1,
        max_length=STYLE_VECTOR_BATCH_IMAGE_LIMIT,
        description="Restrict the job to these images; omit to cover the whole library.",
    )

    @field_validator("image_ids")
    @classmethod
    def positive_image_ids(cls, value):
        if value is not None and any(int(image_id) <= 0 for image_id in value):
            raise ValueError("image_ids must be positive")
        return value


class StyleVectorProgress(BaseModel):
    running: bool
    paused: bool = False
    space: Optional[str] = None
    total: int = 0
    processed: int = 0
    written: int = 0
    kept: int = 0
    errors: int = 0
    step: Optional[str] = None
    message: Optional[str] = None
    current_item: Optional[str] = None
    started_at: Optional[float] = None
    updated_at: Optional[float] = None
    recent_issues: List[str] = Field(default_factory=list)


@router.post(
    "/vectors/start",
    summary="Start style-vector extraction",
    description=(
        "Extract the style vector of every image in the current library that has "
        "none yet (or whose vector came from other weights or other pixels). Runs "
        "in the background; poll /vectors/progress. 409 when a job is running."
    ),
)
def start_vectors(
    request: StartVectorsRequest,
    background_tasks: BackgroundTasks,
    service: StyleVectorService = Depends(get_style_vector_service),
):
    # OperationInProgressError -> 409 and ValidationError -> 400 through the
    # app-wide SDImageSorterError handler.
    return service.start_extraction(
        background_tasks,
        space=request.space,
        image_ids=request.image_ids,
        use_gpu=request.use_gpu,
        model_source=request.model_source,
        model_path=request.model_path,
    )


@router.get("/vectors/progress", response_model=StyleVectorProgress)
async def vectors_progress(
    service: StyleVectorService = Depends(get_style_vector_service),
):
    return StyleVectorProgress(**service.get_progress())


@router.post("/vectors/pause")
async def pause_vectors(
    service: StyleVectorService = Depends(get_style_vector_service),
):
    return {"status": "paused" if service.request_pause() else "not_running"}


@router.post("/vectors/resume")
async def resume_vectors(
    service: StyleVectorService = Depends(get_style_vector_service),
):
    return {"status": "resumed" if service.request_resume() else "not_running"}


@router.post("/vectors/cancel")
async def cancel_vectors(
    service: StyleVectorService = Depends(get_style_vector_service),
):
    return {"status": "cancelled" if service.request_cancel() else "not_running"}


@router.get(
    "/vectors/stats",
    summary="How many images of the current library have a style vector",
)
def vectors_stats(
    space: str = Query("kaloscope", pattern=_SPACE_PATTERN),
    service: StyleVectorService = Depends(get_style_vector_service),
):
    return service.get_stats(space)


@router.get(
    "/points",
    summary="3-D map coordinates of the filtered library",
    description=(
        "One point per picture of the current Gallery filter (a selection token "
        "from POST /api/images/selection-token; omit it for the whole library). "
        "Near-duplicates (cosine > 0.95) merge into one point, pictures whose "
        "vector cannot be placed are listed in `unlocatable`, and the layout is "
        "PCA to three axes scaled to [-1, 1]. Cached per filter and data version."
    ),
)
def style_map_points(
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    selection_token: Optional[str] = Query(None, max_length=65536),
    refresh: bool = Query(
        False, description="Recompute even when a cached layout exists"
    ),
    service: StyleMapService = Depends(get_style_map_service),
):
    # The service caches the serialised payload; hand the bytes through.
    payload = service.points_json(
        space, selection_token=selection_token, refresh=refresh
    )
    return Response(content=payload, media_type="application/json")
