"""Video support endpoints: ffmpeg status and install, playback info, converted previews.

The original video itself is served by ``GET /api/image-file/{id}`` (HTTP
Range, so seeking works); thumbnails by ``GET /api/image-thumbnail/{id}``.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import db_videos
from app_security import require_own_page
from services import ffmpeg_install, video_preview, video_tools
from services.video_index import get_video_indexer

router = APIRouter(prefix="/api", tags=["videos"])


def _not_found(message: str, code: str = "video_not_found") -> HTTPException:
    return HTTPException(status_code=404, detail={"code": code, "message": message})


def _video_row(image_id: int) -> Dict[str, Any]:
    row = db_videos.get_video_row(image_id)
    if row is None or row.get("media_type") != "video":
        raise _not_found("Video not found")
    path = str(row["path"])
    if os.path.islink(path) or not os.path.isfile(path):
        raise _not_found("The video file is not on disk", "video_file_missing")
    return row


@router.get(
    "/video-support",
    summary="Video support status",
    description=(
        "Whether ffmpeg/ffprobe were found (and where: installed from the program, "
        "beside the program, or on PATH), the estimated download size of the LGPL "
        "build for this system, install progress, and how many videos are indexed "
        "or still waiting to be read."
    ),
)
def video_support_status() -> Dict[str, Any]:
    tools = video_tools.find_tools(refresh=True)
    tag = ffmpeg_install.platform_tag()
    counts = db_videos.video_counts()
    if tools is not None and counts["pending"]:
        get_video_indexer().kick()
    return {
        "available": tools is not None,
        "source": tools.source if tools else None,
        "can_install": tag is not None,
        "estimated_mb": ffmpeg_install.ESTIMATED_MB.get(tag or "", None),
        "download_from": "github.com/BtbN/FFmpeg-Builds",
        "install": ffmpeg_install.get_installer().status(),
        "indexing": get_video_indexer().is_running(),
        **counts,
    }


@router.post(
    "/video-support/install",
    summary="Install video support",
    description=(
        "Download the LGPL shared ffmpeg build from GitHub (BtbN/FFmpeg-Builds), "
        "verify its SHA256 against the release checksums and unpack it into the "
        "program's data folder. Runs in the background; poll GET /api/video-support."
    ),
)
def install_video_support(request: Request) -> Dict[str, Any]:
    require_own_page(request, "install video support")
    try:
        return ffmpeg_install.get_installer().start()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "video_install_unsupported", "message": str(exc)},
        ) from exc


class WhichAreVideosRequest(BaseModel):
    image_ids: List[int] = Field(default_factory=list)


@router.post(
    "/videos/which",
    summary="Which of these images are videos",
    description=(
        "Picture-only actions (censor, similarity, scoring, captioning) leave videos "
        "out; this says which of the given ids to leave out. Read only."
    ),
)
def which_are_videos(request: WhichAreVideosRequest) -> Dict[str, Any]:
    return {"video_ids": db_videos.video_ids_among(request.image_ids)}


@router.get(
    "/videos/{image_id}/playback",
    summary="How to play a video",
    description=(
        "Codec facts and whether the browser is expected to play the original. "
        "When it cannot, ``converted`` tells whether a playable preview exists "
        "or is being made."
    ),
)
def video_playback(image_id: int) -> Dict[str, Any]:
    row = _video_row(image_id)
    tools = video_tools.find_tools()
    converted = video_preview.get_converter().status(str(row["path"]))
    return {
        "id": image_id,
        "codec": row.get("video_codec"),
        "duration": row.get("duration_seconds"),
        "fps": row.get("video_fps"),
        "has_audio": bool(row.get("video_has_audio")),
        "probe_state": row.get("video_probe_state"),
        "probe_error": row.get("video_probe_error"),
        "plays_in_browser": video_preview.plays_in_browser(row.get("video_codec")),
        "tools_available": tools is not None,
        "converted": converted,
        "converted_url": f"/api/videos/{image_id}/converted",
    }


@router.post(
    "/videos/{image_id}/converted",
    summary="Make a playable preview",
    description=(
        "Convert the video to VP9/Opus WebM for playback in the browser (the "
        "original is not changed). Cached; one conversion runs at a time."
    ),
)
def request_converted_preview(image_id: int, request: Request) -> Dict[str, Any]:
    require_own_page(request, "make a playable preview")
    row = _video_row(image_id)
    if video_tools.find_tools() is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "video_tools_missing",
                "message": "Install video support first",
            },
        )
    return video_preview.get_converter().request(
        str(row["path"]), row.get("duration_seconds")
    )


@router.get(
    "/videos/{image_id}/converted",
    summary="Converted preview file",
    description="The converted WebM preview, with HTTP Range support for seeking.",
)
def get_converted_preview(image_id: int) -> FileResponse:
    row = _video_row(image_id)
    target = video_preview.preview_path_for(str(row["path"]))
    if not target.is_file():
        raise _not_found("No converted preview yet", "video_preview_missing")
    return FileResponse(str(target), media_type="video/webm")
