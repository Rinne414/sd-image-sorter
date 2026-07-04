"""Publish-set workbench endpoints (v3.5.0 Tier 1 — Pixiv set publishing).

Thin wrapper over ``services.publish_service``: censored-variant pairing and
the sequential-name export. Ordering lives entirely in the frontend
workbench; the request body's item order IS the publish order.
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import publish_service

router = APIRouter(prefix="/api", tags=["publish"])


class CensorPairsRequest(BaseModel):
    image_ids: List[int] = Field(default_factory=list, description="Library image ids, in set order")
    censor_suffix: Optional[str] = Field(
        default=None,
        description="Censored-filename suffix (default '_censored'); sanitized to [A-Za-z0-9_-]",
    )


class PublishExportItem(BaseModel):
    image_id: int
    use_censored: bool = False


class PublishExportRequest(BaseModel):
    items: List[PublishExportItem] = Field(default_factory=list, description="Ordered set; position = publish index")
    output_folder: str
    name_prefix: str = ""
    start_index: int = Field(default=1, ge=0)
    pad_width: int = Field(default=2, ge=publish_service.MIN_PAD_WIDTH, le=publish_service.MAX_PAD_WIDTH)
    caption_text: str = ""
    censor_suffix: Optional[str] = None
    overwrite: bool = False


@router.post(
    "/publish/censor-pairs",
    summary="Resolve censored variants for a set of library images",
    description="""
For each image, looks for the censor editor's `{stem}{suffix}.{png|jpg|jpeg|webp}`
output — first next to the original on disk, then anywhere in the library by
exact filename (newest indexed copy wins). Response preserves request order
and includes the original's display metadata for the workbench list.
    """,
)
def resolve_censor_pairs(request: CensorPairsRequest):
    """Pair originals with their censored variants for the publish workbench."""
    return publish_service.find_censor_pairs(request.image_ids, request.censor_suffix)


@router.post(
    "/publish/export",
    summary="Export an ordered publish set with sequential names",
    description="""
Copies each item into `output_folder` as `{name_prefix}{NN}.{ext}` (numbering
is positional: `start_index` + position, zero-padded to `pad_width`), keeping
the source file's extension. Items with `use_censored: true` FAIL rather than
silently exporting the uncensored original when no censored variant exists.
Existing files are skipped unless `overwrite` is set. A non-empty
`caption_text` is written to `caption.txt` in the same folder.
    """,
)
def export_publish_set(request: PublishExportRequest):
    """Copy the ordered set into the output folder; report per-item results."""
    try:
        return publish_service.export_set(
            items=[item.model_dump() for item in request.items],
            output_folder=request.output_folder,
            name_prefix=request.name_prefix,
            start_index=request.start_index,
            pad_width=request.pad_width,
            caption_text=request.caption_text,
            censor_suffix=request.censor_suffix,
            overwrite=request.overwrite,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
