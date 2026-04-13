"""
Unified model inventory + preparation endpoints.

These endpoints back the frontend model manager so users can inspect which
runtime/model assets are ready and trigger first-run downloads explicitly.
"""
from __future__ import annotations

import json
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from model_health import get_model_health
from config import TAGGER_MODELS, get_wd14_model_dir, get_yolo_model_dir


router = APIRouter(prefix="/api/models", tags=["models"])

PRIVACY_YOLO_PAGE_URL = "https://civitai.com/models/1736285/and-or-dickvaginatitsanuscum-yolov8-segment-model"
PRIVACY_YOLO_API_URL = "https://civitai.com/api/v1/models/1736285"
SAM3_MODELSCOPE_URL = "https://modelscope.cn/models/facebook/sam3/files"


class PrepareModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1)
    source: Optional[str] = None
    variant: Optional[str] = None


def _build_model_inventory() -> List[Dict[str, Any]]:
    health = get_model_health()
    censor = health["censor"]
    artist = health["artist"]
    installed_wd14 = [item["name"] for item in health["wd14"]["installed_models"] if item["available"]]
    wd14_primary_path = None
    if installed_wd14:
        first_variant = installed_wd14[0]
        wd14_primary_path = str((Path(get_wd14_model_dir()) / first_variant / TAGGER_MODELS[first_variant]["model_file"]).resolve())

    def with_status(*, is_ready: bool, is_downloaded: bool) -> Dict[str, str]:
        if is_ready:
            return {"status": "ready", "status_label": "Ready"}
        if is_downloaded:
            return {"status": "downloaded", "status_label": "Downloaded"}
        return {"status": "missing", "status_label": "Missing"}

    return [
        {
            "id": "wd14",
            "name": "WD14 Tagger",
            "group": "Tagging",
            "available": bool(installed_wd14),
            **with_status(is_ready=bool(installed_wd14), is_downloaded=bool(installed_wd14)),
            "message": (
                f"{len(installed_wd14)} WD14 variant(s) are ready."
                if installed_wd14
                else "WD14 model files are missing and can be downloaded on demand."
            ),
            "path": health["wd14"]["model_path"] or wd14_primary_path,
            "download_supported": True,
            "variants": [item["name"] for item in health["wd14"]["installed_models"]],
            "installed_variants": installed_wd14,
        },
        {
            "id": "clip",
            "name": "CLIP Similarity",
            "group": "Search",
            "available": health["clip"]["available"],
            **with_status(is_ready=bool(health["clip"]["available"]), is_downloaded=bool(health["clip"]["model_path"])),
            "message": health["clip"]["message"],
            "path": health["clip"]["model_path"],
            "download_supported": True,
        },
        {
            "id": "artist",
            "name": "Artist ID / Kaloscope",
            "group": "Artist ID",
            "available": artist["available"],
            **with_status(
                is_ready=bool(artist["available"]),
                is_downloaded=bool(artist["checkpoint_path"] or artist["runtime_path"]),
            ),
            "message": artist["message"],
            "path": artist["checkpoint_path"],
            "download_supported": True,
            "sources": ["auto", "huggingface", "modelscope"],
            "runtime_path": artist["runtime_path"],
        },
        {
            "id": "censor-legacy",
            "name": "Privacy YOLO",
            "group": "Censor",
            "available": censor["legacy"]["available"],
            **with_status(
                is_ready=bool(censor["legacy"]["available"]),
                is_downloaded=bool(censor["legacy"]["default_model_path"]),
            ),
            "message": censor["legacy"]["message"],
            "path": censor["legacy"]["default_model_path"],
            "download_supported": True,
            "external_links": [
                {
                    "label": "Civitai",
                    "url": PRIVACY_YOLO_PAGE_URL,
                }
            ],
        },
        {
            "id": "censor-nudenet",
            "name": "NudeNet v3",
            "group": "Censor",
            "available": censor["nudenet"]["available"],
            **with_status(
                is_ready=bool(censor["nudenet"]["available"]),
                is_downloaded=bool(censor["nudenet"]["model_downloaded"] or censor["nudenet"]["available"]),
            ),
            "message": censor["nudenet"]["message"],
            "path": censor["nudenet"]["model_path"],
            "download_supported": True,
        },
        {
            "id": "sam3",
            "name": "SAM 3",
            "group": "Censor",
            "available": censor["sam3"]["available"],
            **with_status(
                is_ready=bool(censor["sam3"]["available"]),
                is_downloaded=bool(censor["sam3"]["checkpoint_path"]),
            ),
            "message": censor["sam3"]["message"],
            "path": censor["sam3"]["checkpoint_path"],
            "download_supported": True,
            "external_links": [
                {
                    "label": "ModelScope",
                    "url": SAM3_MODELSCOPE_URL,
                }
            ],
        },
    ]


def _download_privacy_yolo_bundle() -> Dict[str, str]:
    target_dir = Path(get_yolo_model_dir())
    target_dir.mkdir(parents=True, exist_ok=True)

    with urllib.request.urlopen(PRIVACY_YOLO_API_URL, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    versions = payload.get("modelVersions") or []
    if not versions:
        raise RuntimeError("Civitai returned no model versions for the privacy YOLO package.")

    download_url = versions[0].get("downloadUrl")
    if not download_url:
        raise RuntimeError("Civitai did not provide a downloadable archive URL.")

    with tempfile.TemporaryDirectory(prefix="privacy-yolo-") as tmp_dir:
        zip_path = Path(tmp_dir) / "privacy-yolo.zip"
        urllib.request.urlretrieve(download_url, zip_path)
        with zipfile.ZipFile(zip_path, "r") as archive:
            for member in archive.namelist():
                member_path = (target_dir / member).resolve()
                if not str(member_path).startswith(str(target_dir.resolve())):
                    raise RuntimeError(f"Privacy YOLO archive contains an unsafe path: {member}")
            archive.extractall(target_dir)

    default_path = get_model_health()["censor"]["legacy"]["default_model_path"]
    return {
        "model_dir": str(target_dir.resolve()),
        "default_model_path": default_path or "",
    }


@router.get("/status")
async def get_models_status():
    return {
        "status": "ok",
        "models": _build_model_inventory(),
        "health": get_model_health(),
    }


@router.post("/prepare")
async def prepare_model(request: PrepareModelRequest):
    model_id = request.model_id.strip().lower()

    try:
        if model_id == "wd14":
            from tagger import WD14Tagger, DEFAULT_MODEL

            model_name = request.variant or DEFAULT_MODEL
            tagger = WD14Tagger(model_name=model_name, use_gpu=False)
            model_path, tags_path = tagger._get_model_paths()  # explicit preparation for model manager
            return {
                "status": "ok",
                "model_id": model_id,
                "message": f"WD14 model '{model_name}' is ready.",
                "paths": {"model_path": model_path, "tags_path": tags_path},
            }

        if model_id == "clip":
            from similarity import ensure_clip_model_ready

            model_path = ensure_clip_model_ready()
            return {
                "status": "ok",
                "model_id": model_id,
                "message": "CLIP model is ready.",
                "paths": {"model_path": model_path},
            }

        if model_id == "artist":
            from artist_identifier import prepare_artist_assets

            prepared = prepare_artist_assets(request.source or "auto")
            return {
                "status": "ok",
                "model_id": model_id,
                "message": f"Artist assets are ready via {prepared['source']}.",
                "paths": prepared,
            }

        if model_id == "censor-nudenet":
            from nudenet_detector import get_nudenet_detector
            from model_health import get_model_health as _refresh_health

            detector = get_nudenet_detector()
            detector.load()
            refreshed = _refresh_health()["censor"]["nudenet"]
            return {
                "status": "ok",
                "model_id": model_id,
                "message": "NudeNet runtime is ready.",
                "paths": {"model_path": refreshed["model_path"]},
            }

        if model_id == "censor-legacy":
            downloaded = _download_privacy_yolo_bundle()
            return {
                "status": "ok",
                "model_id": model_id,
                "message": "Privacy YOLO files were downloaded from Civitai.",
                "paths": downloaded,
            }

        if model_id == "sam3":
            from config import get_sam3_model_dir
            from model_health import get_sam3_checkpoint_path

            checkpoint_before = get_sam3_checkpoint_path()
            if checkpoint_before:
                return {
                    "status": "ok",
                    "model_id": model_id,
                    "message": "SAM3 checkpoint files are already present.",
                    "paths": {"checkpoint_path": checkpoint_before},
                }

            try:
                from modelscope import snapshot_download  # type: ignore
            except ImportError as exc:
                raise RuntimeError(
                    "ModelScope SDK is not installed in this build yet. Use the ModelScope link below or install `modelscope` first."
                ) from exc

            cache_dir = Path(get_sam3_model_dir()) / "facebook-sam3-modelscope"
            cache_dir.mkdir(parents=True, exist_ok=True)
            snapshot_download("facebook/sam3", cache_dir=str(cache_dir))
            refreshed_path = get_sam3_checkpoint_path()
            return {
                "status": "ok",
                "model_id": model_id,
                "message": "SAM3 files were downloaded from ModelScope.",
                "paths": {"checkpoint_path": refreshed_path},
            }

        raise HTTPException(status_code=400, detail=f"Model '{request.model_id}' cannot be prepared from the UI yet.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
