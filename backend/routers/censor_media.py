"""Auto-censor for moving pictures: list a folder's GIFs / videos, run a job, follow it.

Folders, not uploads: a video can be hundreds of MB, and the files are
already on this computer. Jobs run one at a time in the background; the
page polls a job for per-file progress.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from censor_transforms import MASK_STYLES
from services import media_censor_service as media
from services.media_censor_service import FrameSettings, MediaCensorJobs
from utils.path_validation import ALLOWED_MODEL_EXTENSIONS, validate_folder_path

router = APIRouter(prefix="/api/censor/media", tags=["censor"])

_jobs: Optional[MediaCensorJobs] = None
# The routes are plain ``def`` and run on threadpool workers: two first
# requests arriving together must not build two job registries.
_jobs_lock = threading.Lock()


def get_jobs() -> MediaCensorJobs:
    global _jobs
    if _jobs is None:
        with _jobs_lock:
            if _jobs is None:
                from services import video_censor

                _jobs = MediaCensorJobs(video_censor=video_censor.censor_video)
    return _jobs


def _folder(path: str, *, create: bool = False) -> Path:
    is_valid, error = validate_folder_path(path, allow_create=create)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid folder")
    folder = Path(path)
    if create:
        folder.mkdir(parents=True, exist_ok=True)
    return folder


class ListRequest(BaseModel):
    folder: str = Field(..., min_length=1)


@router.post("/list")
async def list_media(request: ListRequest):
    """GIFs and videos directly in the folder, and whether videos can be processed."""
    from services import video_censor

    listed = media.list_media(_folder(request.folder))
    return {**listed, "video_ready": video_censor.is_available()}


class StartRequest(BaseModel):
    folder: str = Field(..., min_length=1)
    output_folder: str = ""
    include_videos: bool = True
    model_type: str = Field("nudenet", pattern="^(nudenet|legacy|both)$")
    model_path: str = ""
    confidence: float = Field(0.5, ge=0.0, le=1.0)
    target_classes: Optional[List[str]] = None
    face_guard: bool = True
    shape: str = Field("precise", pattern="^(precise|box|ellipse|fit)$")
    expand_percent: float = Field(0.0, ge=0.0, le=100.0)
    style: str = "mosaic"
    block_size: int = Field(0, ge=0)
    detect_every: int = Field(media.DEFAULT_DETECT_EVERY, ge=1, le=60)
    hold: int = Field(media.DEFAULT_HOLD, ge=0, le=600)


@router.post("/start")
def start_job(request: StartRequest):
    """Censor every GIF (and, with ffmpeg ready, every video) in the folder."""
    if request.style not in MASK_STYLES:
        raise HTTPException(
            status_code=400, detail=f"style must be one of {', '.join(MASK_STYLES)}"
        )
    # The legacy YOLO file, when named, follows the detect rule: the program's
    # models folders or a trusted model folder only (a .pt is a full pickle).
    model_path = request.model_path.strip()
    if model_path:
        import model_roots

        try:
            model_path = model_roots.resolve_model_file(model_path, ALLOWED_MODEL_EXTENSIONS)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    source = _folder(request.folder)
    output = _folder(request.output_folder or str(source / "censored"), create=True)
    listed = media.list_media(source)
    sources = listed["gifs"] + (listed["videos"] if request.include_videos else [])
    if not sources:
        raise HTTPException(
            status_code=400, detail="This folder has no GIFs or videos."
        )
    settings = FrameSettings(
        model_type=request.model_type,
        model_path=model_path,
        confidence=request.confidence,
        target_classes=request.target_classes,
        face_guard=request.face_guard,
        shape=request.shape,
        expand_percent=request.expand_percent,
        style=request.style,
        block_size=request.block_size,
        detect_every=request.detect_every,
        hold=request.hold,
    )
    job = get_jobs().start(sources, str(output), settings)
    return {"job_id": job.id, "output_folder": str(output), **job.snapshot()}


@router.get("/jobs/{job_id}")
async def job_progress(job_id: str):
    job = get_jobs().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    return job.snapshot()


@router.post("/jobs/{job_id}/reveal/{index}")
async def reveal_output(job_id: str, index: int):
    """Show one finished output in the OS file manager, selected."""
    from app_diagnostics import _open_path_in_file_manager

    job = get_jobs().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    files = job.snapshot()["files"]
    if not 0 <= index < len(files) or not files[index]["output"]:
        raise HTTPException(status_code=404, detail="That file has no output yet.")
    if not _open_path_in_file_manager(Path(files[index]["output"])):
        raise HTTPException(status_code=501, detail="No file manager is available on this computer.")
    return {"status": "ok"}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    if not get_jobs().cancel(job_id):
        raise HTTPException(status_code=404, detail="Unknown job.")
    return {"status": "ok"}
