"""Style map API: style-vector extraction jobs (slice S1).

The map itself (projection, near-duplicate merging) arrives in a later slice;
this router only starts, watches, pauses, resumes and cancels the job that
fills ``image_style_vectors``. Database access stays in StyleVectorService.
DB-backed endpoints are plain ``def`` (aesthetic router precedent) so their
SQLite work runs in the threadpool instead of on the event loop.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Query, Response, UploadFile
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic import ValidationError as PydanticValidationError

from artist_identifier import ARTIST_THRESHOLD_DEFAULT
from exceptions import ValidationError
from routers.artists import ArtistModelConfig, resolve_local_artist_model
from services.service_provider import ServiceProvider
from services.style_map_axes import AXES_LAYOUTS
from services.style_map_colors import MAP_ID_PATTERN, STYLE_MAP_COLOR_FIELDS
from services.style_map_locate import MAX_RESULTS
from services.style_map_query import DEFAULT_K, MAX_K, read_capped_upload
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
_COLOR_BY_PATTERN = "^(" + "|".join(STYLE_MAP_COLOR_FIELDS) + ")$"
_MAP_ID_DOC = (
    "The `map_id` a points answer carried: names that cached map directly "
    "(no filter query; `not_started` once it is evicted or belongs to another "
    "library). Without it the map is located from the filter again."
)
_style_map_service_provider = ServiceProvider(StyleMapService)
get_style_map_service = _style_map_service_provider.get
set_style_map_service = _style_map_service_provider.set


def _model_path_from_query(
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    model_source: str = Query(
        "huggingface",
        pattern="^(huggingface|modelscope|local)$",
        description="The user's Style Finder model setting",
    ),
    model_path: Optional[str] = Query(
        None,
        max_length=4096,
        description="Local checkpoint (.pth/.pt/.onnx); required and must exist when "
        "model_source is local, ignored otherwise",
    ),
) -> Optional[str]:
    """The Style Finder model settings as query parameters (the page shares
    them with the Style Finder), validated the way its own requests are: a
    local checkpoint names its own vector version, so every map route reads
    the vectors of the weights the user actually runs.

    Only the kaloscope space has weights to name (the CLIP map reads
    ``images.embedding`` and must not go down with a moved checkpoint), and
    only a local source carries a path: anything else is dropped unread, so
    the routes are no existence oracle for arbitrary files."""
    if space != "kaloscope" or model_source != "local":
        return None
    try:
        config = ArtistModelConfig(model_source="local", model_path=model_path)
    except PydanticValidationError as exc:
        raise ValidationError(
            "; ".join(str(err.get("msg", "")) for err in exc.errors())
            or "Invalid model settings",
            field="model_path",
        ) from exc
    # A sync dependency runs in the threadpool: the file check belongs here,
    # not in the validator (SEC1f).
    try:
        return resolve_local_artist_model(config.model_path)
    except ValueError as exc:
        raise ValidationError(str(exc), field="model_path") from exc


class StartVectorsRequest(ArtistModelConfig):
    """Model selection is the Style Finder contract (source, local path, use_gpu)."""

    space: str = Field("kaloscope", pattern=_SPACE_PATTERN)
    image_ids: Optional[List[int]] = Field(
        default=None,
        min_length=1,
        max_length=STYLE_VECTOR_BATCH_IMAGE_LIMIT,
        description="Restrict the job to these images; omit to cover the whole library.",
    )

    selection_token: Optional[str] = Field(
        default=None,
        max_length=65536,
        description=(
            "Restrict the job to the current Gallery filter (a token from "
            "POST /api/images/selection-token); exclusive with image_ids."
        ),
    )

    @field_validator("image_ids")
    @classmethod
    def positive_image_ids(cls, value):
        if value is not None and any(int(image_id) <= 0 for image_id in value):
            raise ValueError("image_ids must be positive")
        return value

    with_artist: bool = Field(
        default=True,
        description=(
            "Also store the Style Finder's artist prediction from the same "
            "forward pass (same model, threshold and row format as identify)."
        ),
    )

    # Same field as IdentifyBatchRequest.threshold: the Style Finder page's
    # slider, so the index tiers (and stores) the artist the way that page does.
    threshold: float = Field(
        ARTIST_THRESHOLD_DEFAULT,
        ge=0.0,
        le=1.0,
        description=(
            "Confidence floor for the stored artist prediction; send the Style "
            "Finder page's threshold so both entrances write the same rows."
        ),
    )

    @model_validator(mode="after")
    def one_scope_only(self):
        if self.image_ids is not None and self.selection_token:
            raise ValueError("Give either image_ids or selection_token, not both")
        return self


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
    # A def handler runs in the threadpool: resolve the local checkpoint here
    # (the validator stays pure, SEC1f), before anything is queued.
    model_path = request.model_path
    if model_path is not None:
        try:
            model_path = resolve_local_artist_model(model_path)
        except ValueError as exc:
            raise ValidationError(str(exc), field="model_path") from exc
    return service.start_extraction(
        background_tasks,
        space=request.space,
        image_ids=request.image_ids,
        use_gpu=request.use_gpu,
        model_source=request.model_source,
        model_path=model_path,
        selection_token=request.selection_token,
        with_artist=request.with_artist,
        threshold=request.threshold,
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
    description=(
        "Counts follow the user's Style Finder model settings: a local "
        "checkpoint names its own vector version, so `other_version` means "
        "vectors from OTHER weights than the ones the user runs."
    ),
)
def vectors_stats(
    space: str = Query("kaloscope", pattern=_SPACE_PATTERN),
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleVectorService = Depends(get_style_vector_service),
):
    return service.get_stats(space, model_path=model_path)


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
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    # The service caches the serialised payload; hand the bytes through.
    payload = service.points_json(
        space, selection_token=selection_token, refresh=refresh, model_path=model_path
    )
    return Response(content=payload, media_type="application/json")


@router.get(
    "/layout-status",
    summary="State of the optional UMAP layout of the filtered library",
    description=(
        "The `umap` field of GET /api/style-map/points without computing the "
        "map: `unavailable` (umap-learn not installed; the map uses PCA), "
        "`too_few_points`, `not_started`, `queued`, `computing`, `ready` or "
        "`failed`. Poll it while a layout is being fitted."
    ),
)
def style_map_layout_status(
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    selection_token: Optional[str] = Query(None, max_length=65536),
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    return service.layout_status(
        space, selection_token=selection_token, model_path=model_path
    )


@router.get(
    "/regions",
    summary="Regions of the filtered library's map, with representative pictures and labels",
    description=(
        "k-means regions of the map GET /api/style-map/points last returned for "
        "the same space and filter (PCA or, once ready, UMAP coordinates): each "
        "region's centre, size, 1-2 representative pictures, significantly "
        "over-represented WD14 style tags and dominant confident artists. "
        "`not_started` until points has been requested for this map. Cached per "
        "map; recomputed when tags or artist predictions changed since."
    ),
)
def style_map_regions(
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    selection_token: Optional[str] = Query(None, max_length=65536),
    refresh: bool = Query(False, description="Recompute even when cached"),
    map_id: Optional[str] = Query(
        None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC
    ),
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    payload = service.regions_json(
        space,
        selection_token=selection_token,
        refresh=refresh,
        model_path=model_path,
        map_id=map_id,
    )
    return Response(content=payload, media_type="application/json")


@router.get(
    "/colors",
    summary="One colour value per point of the filtered library's map",
    description=(
        "For the representatives of the map GET /api/style-map/points last "
        "returned for the same space and filter, in point order: a category "
        "index into `legend` (`generator`, `folder`, `artist`; the 12 largest "
        "categories, the rest as one `__other__` entry, null without data) or "
        "a number with its `range` (`aesthetic_score`, `aesthetic_waifu`, "
        "`aesthetic_anime`; null when unscored). Read fresh on every call, "
        "never cached with the layout; `not_started` until points ran."
    ),
)
def style_map_colors(
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    selection_token: Optional[str] = Query(None, max_length=65536),
    by: str = Query("generator", pattern=_COLOR_BY_PATTERN),
    map_id: Optional[str] = Query(
        None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC
    ),
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    payload = service.colors_json(
        space,
        selection_token=selection_token,
        by=by,
        model_path=model_path,
        map_id=map_id,
    )
    return Response(content=payload, media_type="application/json")


@router.get(
    "/axes",
    summary="What the two ends of each axis of the map stand for",
    description=(
        "For the map GET /api/style-map/points last returned (named by "
        "`map_id`), on the coordinates the page shows (`layout` pca, or the "
        "ready umap fit): per axis x/y/z and per end (`low`, `high`) three "
        "representative pictures from the outer tenth, up to three WD14 "
        "general tags that separate the outer fifth at one end from the other "
        "(same BH + effect-size rule as /regions; rating, meta and character "
        "tags excluded), a `weak` flag when nothing separates the ends and a "
        "`strength` (largest rate difference). `not_started` when the map is "
        "unknown or evicted, `layout_not_ready` for umap before its fit is "
        "done. Cached per map, layout and label version."
    ),
)
def style_map_axes(
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    selection_token: Optional[str] = Query(None, max_length=65536),
    map_id: Optional[str] = Query(
        None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC
    ),
    layout: str = Query(
        "pca",
        pattern="^(" + "|".join(AXES_LAYOUTS) + ")$",
        description="Coordinates the page shows: pca or umap",
    ),
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    payload = service.axes_json(
        space,
        selection_token=selection_token,
        model_path=model_path,
        map_id=map_id,
        layout=layout,
    )
    return Response(content=payload, media_type="application/json")


class StyleMapCustomAxesRequest(BaseModel):
    space: str = Field("kaloscope", pattern=_MAP_SPACE_PATTERN)
    selection_token: Optional[str] = Field(None, max_length=65536)
    map_id: Optional[str] = Field(None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC)
    layout: str = Field("pca", pattern="^(" + "|".join(AXES_LAYOUTS) + ")$")
    axes: dict = Field(
        ...,
        description='{"x": {"a": [image ids], "b": [image ids]}, "y": null, "z": null}',
    )


@router.post(
    "/custom-axes",
    summary="Re-lay the map along axes defined by example pictures",
    description=(
        "Each defined axis (x, y or z) takes two groups of example pictures, `a` "
        "(low end) and `b` (high end), at least 2 each: the direction is the "
        "mean unit vector of `b` minus that of `a`, zero halfway between the two "
        "groups, scaled like the PCA layout. The other axes keep the layout "
        "`layout` names with the custom ones regressed out. Returns every dot's "
        "new coordinates in points order, per axis leave-one-out agreement "
        "(`agree` of `total`, `separable`), `missing_ids` (outside the current "
        "library or without a vector) and `warnings` (parallel axes). 400 when "
        "a picture is in both ends of an axis or an end has fewer than 2 "
        "examples; `not_started` when the map is unknown or evicted."
    ),
)
def style_map_custom_axes(
    request: StyleMapCustomAxesRequest,
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    payload = service.custom_axes_json(
        request.space,
        selection_token=request.selection_token,
        model_path=model_path,
        map_id=request.map_id,
        layout=request.layout,
        axes=request.axes,
    )
    return Response(content=payload, media_type="application/json")


class StyleMapMembersRequest(BaseModel):
    space: str = Field("kaloscope", pattern=_MAP_SPACE_PATTERN)
    selection_token: Optional[str] = Field(None, max_length=65536)
    map_id: Optional[str] = Field(None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC)
    rep_ids: List[int] = Field(
        ..., description="Points of the map (representatives) to expand"
    )


@router.post(
    "/members",
    summary="Every picture behind the given dots of the map",
    description=(
        "The map draws one representative per near-duplicate group. For the "
        "representatives in `rep_ids` this returns all pictures they stand "
        "for (the representatives included), so a box selection acts on "
        "every picture and not only on the visible dots. An id that is not a "
        "point of the map expands to nothing. `not_started` (no ids) when "
        "the map is not cached in this process or belongs to another library."
    ),
)
def style_map_members(
    body: StyleMapMembersRequest,
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    payload = service.members_json(
        body.space,
        body.rep_ids,
        selection_token=body.selection_token,
        model_path=model_path,
        map_id=body.map_id,
    )
    return Response(content=payload, media_type="application/json")


@router.post(
    "/query",
    summary="Nearest pictures of a dropped picture, placed on the map",
    description=(
        "Rank the current library against one uploaded picture (an image of "
        "at most 50 MB; it is read into memory and never stored) and place "
        "the answer on the map GET /api/style-map/points last returned. "
        "`kaloscope` compares Kaloscope style vectors (the first call loads "
        "the model, about 13 s); `clip` uses the Similar page's search. The "
        "query point sits at the similarity-weighted centre of its three "
        "nearest neighbours on the map; neighbours outside the current "
        "filter are listed with `in_filter: false` and no coordinates. "
        "`not_started` (nothing computed) when the map is not cached."
    ),
)
async def style_map_query(
    file: UploadFile = File(..., description="The picture to look up"),
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    selection_token: Optional[str] = Query(None, max_length=65536),
    map_id: Optional[str] = Query(
        None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC
    ),
    k: int = Query(DEFAULT_K, ge=1, le=MAX_K, description="Neighbours to return"),
    model_source: str = Query("huggingface", pattern="^(huggingface|modelscope|local)$"),
    use_gpu: Optional[bool] = Query(None),
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    data = await read_capped_upload(file)
    payload = await run_in_threadpool(
        service.query_neighbors_json,
        space,
        data,
        selection_token=selection_token,
        map_id=map_id,
        k=k,
        model_path=model_path,
        model_source=model_source,
        use_gpu=use_gpu,
    )
    return Response(content=payload, media_type="application/json")


@router.get(
    "/near",
    summary="Nearest pictures of one library picture, placed on the map",
    description=(
        "Rank the current library against the STORED vector of library "
        "picture `image_id` (Kaloscope style vector or CLIP embedding; no "
        "upload, no model run) and place the answer on the map named by "
        "`map_id`. Same body as POST /api/style-map/query without the "
        "picture itself in `neighbors`, plus `self`: where that picture is "
        "(`in_filter`, `located`, `merged` into another dot, coordinates) and "
        "`query` set to its own dot when it has one. `no_vector` when the "
        "picture has no vector in this space, `not_started` when the map is "
        "not cached in this process or belongs to another library, 404 for an "
        "unknown picture."
    ),
)
def style_map_near(
    image_id: int = Query(..., ge=1, description="The library picture"),
    space: str = Query("kaloscope", pattern=_MAP_SPACE_PATTERN),
    selection_token: Optional[str] = Query(None, max_length=65536),
    map_id: Optional[str] = Query(
        None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC
    ),
    k: int = Query(DEFAULT_K, ge=1, le=MAX_K, description="Neighbours to return"),
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    payload = service.near_json(
        space,
        image_id,
        selection_token=selection_token,
        map_id=map_id,
        k=k,
        model_path=model_path,
    )
    return Response(content=payload, media_type="application/json")


class StyleMapLocateRequest(BaseModel):
    space: str = Field("kaloscope", pattern=_MAP_SPACE_PATTERN)
    selection_token: Optional[str] = Field(None, max_length=65536)
    map_id: Optional[str] = Field(None, pattern=MAP_ID_PATTERN, description=_MAP_ID_DOC)
    search_token: str = Field(
        ...,
        min_length=1,
        max_length=65536,
        description=(
            "A POST /api/images/selection-token token of the Gallery search "
            "(filename, tags, prompts ...); the Gallery's own grammar"
        ),
    )
    limit: int = Field(MAX_RESULTS, ge=1, le=MAX_RESULTS)


@router.post(
    "/locate",
    summary="Find pictures of the map by a Gallery search",
    description=(
        "The pictures of the map named by `map_id` that match the Gallery "
        "search of `search_token`, newest first, at most 50, each with its dot "
        "(`merged`: the picture is hidden behind another dot and shares its "
        "position). `total` counts every match on the map. `outside_filter` "
        "counts matches the current Gallery filter keeps off the map and "
        "`without_data` matches that have no style data yet, so an empty "
        "answer can say why. `not_started` when the map is not cached in this "
        "process or belongs to another library."
    ),
)
def style_map_locate(
    body: StyleMapLocateRequest,
    model_path: Optional[str] = Depends(_model_path_from_query),
    service: StyleMapService = Depends(get_style_map_service),
):
    payload = service.locate_json(
        body.space,
        body.search_token,
        selection_token=body.selection_token,
        map_id=body.map_id,
        model_path=model_path,
        limit=body.limit,
    )
    return Response(content=payload, media_type="application/json")
