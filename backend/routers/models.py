"""
Unified model inventory + preparation endpoints.

These endpoints back the frontend model manager so users can inspect which
runtime/model assets are ready and trigger first-run downloads explicitly.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from model_health import get_model_health


router = APIRouter(prefix="/api/models", tags=["models"])


class PrepareModelRequest(BaseModel):
    model_id: str = Field(..., min_length=1)
    source: Optional[str] = None
    variant: Optional[str] = None


def _build_model_inventory() -> List[Dict[str, Any]]:
    health = get_model_health()
    censor = health["censor"]
    artist = health["artist"]

    return [
        {
            "id": "wd14",
            "name": "WD14 Tagger",
            "group": "Tagging",
            "available": health["wd14"]["available"],
            "message": "Default WD14 model ready." if health["wd14"]["available"] else "WD14 model files are missing and can be downloaded on demand.",
            "path": health["wd14"]["model_path"],
            "download_supported": True,
            "variants": [item["name"] for item in health["wd14"]["installed_models"]],
        },
        {
            "id": "clip",
            "name": "CLIP Similarity",
            "group": "Search",
            "available": health["clip"]["available"],
            "message": health["clip"]["message"],
            "path": health["clip"]["model_path"],
            "download_supported": True,
        },
        {
            "id": "artist",
            "name": "Artist ID / Kaloscope",
            "group": "Artist ID",
            "available": artist["available"],
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
            "message": censor["legacy"]["message"],
            "path": censor["legacy"]["default_model_path"],
            "download_supported": False,
        },
        {
            "id": "censor-nudenet",
            "name": "NudeNet v3",
            "group": "Censor",
            "available": censor["nudenet"]["available"],
            "message": censor["nudenet"]["message"],
            "path": censor["nudenet"]["model_path"],
            "download_supported": True,
        },
        {
            "id": "sam3",
            "name": "SAM 3",
            "group": "Censor",
            "available": censor["sam3"]["available"],
            "message": censor["sam3"]["message"],
            "path": censor["sam3"]["checkpoint_path"],
            "download_supported": False,
        },
    ]


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

        raise HTTPException(status_code=400, detail=f"Model '{request.model_id}' cannot be prepared from the UI yet.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
