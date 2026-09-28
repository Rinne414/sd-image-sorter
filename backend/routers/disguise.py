"""Chat-disguise endpoints: make, preview, copy as a file, restore, default cover.

A made disguise is written to an output folder (``<data>/disguise/output``
unless the caller names another), because chat programs need a real file to
paste. The response carries a token; the file and its cover preview are
served by token, so no endpoint accepts an arbitrary path to read back.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import secrets
import threading
from collections import OrderedDict
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import disguise_apng
from app_diagnostics import _open_path_in_file_manager as open_in_file_manager
import disguise_registry
from routers.censor import get_censor_service
from services import disguise_service
from services.disguise_service import CoverSpec, CoverUnavailable, MakeOptions
from utils import file_clipboard
from utils.path_validation import sanitize_filename, validate_folder_path

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/disguise", tags=["disguise"])

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
PREVIEW_SIDE = 512
_RESULT_CACHE_SIZE = 5000
_results: "OrderedDict[str, str]" = OrderedDict()
_results_lock = threading.Lock()


# ----------------------------------------------------------------- helpers


async def _read_upload(upload: UploadFile) -> bytes:
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image file is too large.")
    return data


def _open_image(data: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return image.convert("RGBA")
    except Image.DecompressionBombError as exc:
        raise HTTPException(
            status_code=413, detail="Image is too large to process safely."
        ) from exc
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(
            status_code=400, detail="Upload is not a readable image."
        ) from exc


def _parse_json_list(raw: str, field: str) -> list:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400, detail=f"{field} must be a JSON list."
        ) from exc
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail=f"{field} must be a JSON list.")
    return value


def _output_folder(requested: str) -> Path:
    if not requested.strip():
        folder = disguise_registry.disguise_dir() / "output"
        folder.mkdir(parents=True, exist_ok=True)
        return folder
    is_valid, error = validate_folder_path(requested, allow_create=True)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid output folder")
    folder = Path(requested)
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _free_name(folder: Path, stem: str) -> Path:
    clean = sanitize_filename(stem) or "disguise"
    candidate = folder / f"{clean}.png"
    counter = 2
    while candidate.exists():
        candidate = folder / f"{clean} ({counter}).png"
        counter += 1
    return candidate


def _remember_result(path: Path) -> str:
    token = secrets.token_urlsafe(12)
    with _results_lock:
        _results[token] = str(path)
        while len(_results) > _RESULT_CACHE_SIZE:
            _results.popitem(last=False)
    return token


def _result_path(token: str) -> str:
    with _results_lock:
        path = _results.get(token)
    if not path or not os.path.isfile(path):
        raise HTTPException(
            status_code=404, detail="That disguise image is no longer available."
        )
    return path


def _attachment_header(filename: str) -> str:
    """Headers are latin-1: an ASCII fallback name plus the real name as UTF-8 (RFC 6266)."""
    fallback = (
        filename.encode("ascii", "replace")
        .decode("ascii")
        .replace("?", "_")
        .replace('"', "_")
    )
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


def _preview_data_url(image: Image.Image) -> str:
    preview = image.copy()
    preview.thumbnail((PREVIEW_SIDE, PREVIEW_SIDE), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    preview.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(
        "ascii"
    )


# --------------------------------------------------------------- endpoints


@router.post("/make")
async def make_disguise(
    sources: str = Form(
        ...,
        description='JSON list of {"image_id": n} or {"file_index": n}, in frame order',
    ),
    files: List[UploadFile] = File(default=[]),
    cover_kind: str = Form("default"),
    cover_file: Optional[UploadFile] = File(default=None),
    cover_text: str = Form(""),
    cover_background: str = Form(disguise_service.TEXT_CARD_BACKGROUND),
    cover_foreground: str = Form(disguise_service.TEXT_CARD_FOREGROUND),
    frame_ms: int = Form(
        disguise_service.DEFAULT_FRAME_MS, ge=1, le=disguise_apng.MAX_FRAME_MS
    ),
    max_side: int = Form(disguise_service.DEFAULT_MAX_SIDE, ge=0),
    scrub: bool = Form(True),
    canvas_background: str = Form("#ffffff"),
    detect_model_type: str = Form("nudenet"),
    detect_model_path: str = Form(""),
    detect_confidence: float = Form(0.5, ge=0.0, le=1.0),
    detect_targets: str = Form(""),
    output_folder: str = Form(""),
    output_name: str = Form(""),
    censor_service=Depends(get_censor_service),
):
    """Make one disguise. Several sources become one animation, in order.

    When the requested cover cannot be made (nothing detected, no default
    cover saved, ...) the answer is ``status: "needs_cover"`` with a reason,
    not an error: in a batch that item waits for the user to pick a cover.
    """
    if cover_kind not in disguise_service.COVER_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"cover_kind must be one of {', '.join(disguise_service.COVER_KINDS)}",
        )
    source_list = _parse_json_list(sources, "sources")
    if not source_list:
        raise HTTPException(status_code=400, detail="Add at least one picture.")

    uploads = [await _read_upload(upload) for upload in files]
    pictures: list[Image.Image] = []
    stems: list[str] = []
    first_image_id: Optional[int] = None
    for position, source in enumerate(source_list):
        if not isinstance(source, dict):
            raise HTTPException(
                status_code=400, detail="Each source must be an object."
            )
        if "image_id" in source:
            image_id = int(source["image_id"])
            try:
                image, stem = await run_in_threadpool(
                    disguise_service.load_library_picture, image_id
                )
            except disguise_service.LibraryPictureMissing as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            except Image.DecompressionBombError as exc:
                raise HTTPException(
                    status_code=413, detail="Image is too large to process safely."
                ) from exc
            except (UnidentifiedImageError, OSError) as exc:
                raise HTTPException(
                    status_code=400, detail=f"Image {image_id} is not readable."
                ) from exc
            if position == 0:
                first_image_id = image_id
        elif "file_index" in source:
            index = int(source["file_index"])
            if not 0 <= index < len(uploads):
                raise HTTPException(
                    status_code=400, detail=f"file_index {index} has no uploaded file."
                )
            image = _open_image(uploads[index])
            stem = Path(files[index].filename or "picture").stem
        else:
            raise HTTPException(
                status_code=400, detail="A source needs image_id or file_index."
            )
        pictures.append(image)
        stems.append(stem)

    cover_upload = (
        _open_image(await _read_upload(cover_file)) if cover_file is not None else None
    )
    spec = CoverSpec(
        kind=cover_kind,
        upload=cover_upload,
        text=cover_text,
        background=cover_background,
        foreground=cover_foreground,
    )
    options = MakeOptions(
        frame_ms=frame_ms,
        max_side=max_side,
        scrub=scrub,
        canvas_background=canvas_background,
    )
    detector = None
    if cover_kind == "mosaic" and first_image_id is not None:
        detector = disguise_service.censor_detector(
            censor_service,
            first_image_id,
            detect_model_type,
            detect_model_path,
            detect_confidence,
            _parse_json_list(detect_targets, "detect_targets"),
        )

    try:
        made = await run_in_threadpool(
            disguise_service.make_disguise, pictures, spec, options, detector
        )
    except CoverUnavailable as exc:
        return {"status": "needs_cover", "reason": exc.reason}

    folder = _output_folder(output_folder)
    default_stem = stems[0] if len(stems) == 1 else f"{stems[0]}_{len(stems)}p"
    target = _free_name(folder, output_name.strip() or default_stem)
    await run_in_threadpool(target.write_bytes, made.data)
    token = _remember_result(target)
    return {
        "status": "ok",
        "token": token,
        "file_url": f"/api/disguise/result/{token}",
        "output_path": str(target),
        "file_name": target.name,
        "cover_preview": _preview_data_url(made.cover),
        "width": made.width,
        "height": made.height,
        "real_frames": made.real_frames,
        "bytes": len(made.data),
    }


@router.get("/result/{token}")
async def get_result(token: str):
    path = _result_path(token)
    return FileResponse(path, media_type="image/png", filename=os.path.basename(path))


class CopyRequest(BaseModel):
    tokens: List[str] = Field(..., min_length=1)


@router.post("/copy")
async def copy_results(request: CopyRequest):
    """Put the made files on the clipboard as files, ready to paste into a chat."""
    paths = [_result_path(token) for token in request.tokens]
    try:
        await run_in_threadpool(file_clipboard.copy_files, paths)
    except file_clipboard.ClipboardUnsupported as exc:
        raise HTTPException(
            status_code=501,
            detail="Copying files needs Windows; open the output folder instead.",
        ) from exc
    except file_clipboard.ClipboardBusy as exc:
        raise HTTPException(
            status_code=409, detail="Another program is using the clipboard; try again."
        ) from exc
    return {"status": "ok", "copied": len(paths)}


class RevealRequest(BaseModel):
    token: str


@router.post("/reveal")
async def reveal_result(request: RevealRequest):
    """Show a made disguise in the OS file manager, selected, ready to drag into a chat."""
    path = _result_path(request.token)
    if not await run_in_threadpool(open_in_file_manager, Path(path)):
        raise HTTPException(status_code=501, detail="No file manager is available on this computer.")
    return {"status": "ok"}


@router.post("/restore")
async def restore_upload(file: UploadFile = File(...)):
    """Return the real picture(s) of an uploaded disguise: PNG, or APNG for a pack."""
    data = await _read_upload(file)
    if disguise_apng.probe_disguise(data) is None:
        raise HTTPException(
            status_code=400, detail="This picture is not a disguise image."
        )
    try:
        frames = await run_in_threadpool(disguise_apng.extract_real_frames, data)
    except disguise_apng.DisguiseReadError as exc:
        raise HTTPException(
            status_code=400, detail="The hidden picture is damaged and cannot be read."
        ) from exc
    stem = Path(file.filename or "picture").stem
    return Response(
        content=disguise_apng.encode_restored(frames),
        media_type="image/png",
        headers={
            "Content-Disposition": _attachment_header(
                f"{sanitize_filename(stem)}_real.png"
            )
        },
    )


@router.get("/default-cover/info")
async def get_default_cover_info():
    """Whether a default cover is saved (a 404 image request would log a browser error)."""
    path = disguise_service.default_cover_path()
    if not path.is_file():
        return {"exists": False}
    return {"exists": True, "version": int(path.stat().st_mtime_ns)}


@router.get("/default-cover")
async def get_default_cover():
    path = disguise_service.default_cover_path()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No default cover saved.")
    return FileResponse(
        str(path), media_type="image/png", headers={"Cache-Control": "no-store"}
    )


@router.put("/default-cover")
async def put_default_cover(file: UploadFile = File(...)):
    image = _open_image(await _read_upload(file))
    await run_in_threadpool(disguise_service.save_default_cover, image)
    return {"status": "ok", "width": image.width, "height": image.height}


@router.delete("/default-cover")
async def delete_default_cover():
    removed = await run_in_threadpool(disguise_service.clear_default_cover)
    return {"status": "ok", "removed": removed}
