"""
Unified model inventory + preparation endpoints.

These endpoints back the frontend model manager so users can inspect which
runtime/model assets are ready and trigger first-run downloads explicitly.
"""
from __future__ import annotations

import json
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from model_health import get_model_health
from config import TAGGER_MODELS, get_wd14_model_dir, get_yolo_model_dir


router = APIRouter(prefix="/api/models", tags=["models"])

PRIVACY_YOLO_PAGE_URL = "https://civitai.red/models/1736285/and-or-dickvaginatitsanuscum-yolov8-segment-model"
PRIVACY_YOLO_API_URL = "https://civitai.red/api/v1/models/1736285"
# Pinned direct-download URL (version 1965032) used when the Civitai API
# blocks us or returns no downloadUrl. Keeps first-run YOLO prep resilient.
PRIVACY_YOLO_DIRECT_URL = (
    "https://civitai.red/api/download/models/1965032?type=Archive&format=Other"
)
SAM3_MODELSCOPE_URL = "https://modelscope.cn/models/facebook/sam3/files"

# Civitai rejects requests with the default urllib User-Agent (Python-urllib/x.y)
# with HTTP 403. Supplying a realistic browser UA restores metadata + download access.
_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36 sd-image-sorter/3.0.5"
    ),
    "Accept": "application/json, */*;q=0.8",
}


class ExternalAuthRequiredError(RuntimeError):
    """Raised when a model download is blocked by an external auth wall."""

    def __init__(self, payload: Dict[str, Any], status_code: int = 409):
        super().__init__(payload.get("message") or payload.get("error") or "External authentication required")
        self.payload = payload
        self.status_code = status_code


class ModelPreparationFailedError(RuntimeError):
    """Raised when a model cannot be prepared automatically for a non-auth reason."""

    def __init__(self, payload: Dict[str, Any], status_code: int = 502):
        super().__init__(payload.get("message") or payload.get("error") or "Model preparation failed")
        self.payload = payload
        self.status_code = status_code


def _urlopen_with_ua(url: str, timeout: int = 30):
    """Wrap urllib.request.urlopen with a browser-style User-Agent header.

    Some CDNs (notably Civitai) reject the default Python-urllib UA with 403.
    """
    req = urllib.request.Request(url, headers=_DOWNLOAD_HEADERS)
    return urllib.request.urlopen(req, timeout=timeout)


def _build_civitai_auth_error(target_dir: Path) -> Dict[str, Any]:
    target_dir_resolved = str(target_dir.resolve())
    return {
        "error": "Civitai login required for the Privacy YOLO download.",
        "type": "CivitaiLoginRequired",
        "message": (
            "Privacy YOLO cannot be downloaded automatically because Civitai now requires a signed-in browser session."
        ),
        "provider": "Civitai",
        "model_id": "censor-legacy",
        "manual_steps": [
            f"Open {PRIVACY_YOLO_PAGE_URL} in a browser and sign in to Civitai.",
            "Download the Privacy YOLO archive (.zip) from the model page.",
            f"Extract the archive into {target_dir_resolved}.",
            "Restart SD Image Sorter or reopen the Models panel so the files are detected.",
        ],
        "target_dir": target_dir_resolved,
        "external_url": PRIVACY_YOLO_PAGE_URL,
    }


def _build_privacy_yolo_prepare_error(target_dir: Path, reason: str) -> Dict[str, Any]:
    target_dir_resolved = str(target_dir.resolve())
    return {
        "error": "Privacy YOLO preparation failed.",
        "type": "ModelPreparationFailed",
        "message": (
            "Privacy YOLO could not be prepared automatically because the download or archive verification failed."
        ),
        "provider": "Civitai",
        "model_id": "censor-legacy",
        "reason": reason,
        "manual_steps": [
            f"Open {PRIVACY_YOLO_PAGE_URL} in a browser and sign in to Civitai.",
            "Download the Privacy YOLO archive (.zip) from the model page.",
            f"Extract the archive into {target_dir_resolved}.",
            "Restart SD Image Sorter or reopen the Models panel so the files are detected.",
        ],
        "target_dir": target_dir_resolved,
        "external_url": PRIVACY_YOLO_PAGE_URL,
    }


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

    # Aesthetic predictor status
    aesthetic_available = False
    aesthetic_message = "Aesthetic predictor dependencies are not installed"
    aesthetic_head_path = str(Path(__file__).parent.parent.parent / "models" / "aesthetic" / "sa_0_4_vit_l_14_linear.pth")
    aesthetic_head_exists = Path(aesthetic_head_path).exists()
    try:
        from aesthetic import is_available
        aesthetic_available = is_available()
        if aesthetic_available:
            aesthetic_message = "Aesthetic predictor is ready (CLIP + linear head)."
        elif aesthetic_head_exists:
            aesthetic_message = "Linear head downloaded but CLIP dependencies missing (torch/open_clip)."
    except ImportError:
        pass

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
            "available": health["clip"]["available"] or health["clip"].get("runtime_loaded", False),
            **with_status(
                is_ready=bool(health["clip"]["available"] or health["clip"].get("runtime_loaded", False)),
                is_downloaded=bool(health["clip"]["model_path"] or health["clip"].get("runtime_loaded", False)),
            ),
            "message": health["clip"]["message"] if not health["clip"].get("runtime_loaded") or health["clip"]["available"] else "CLIP model is loaded and ready.",
            "path": health["clip"]["model_path"],
            "download_supported": True,
        },
        {
            "id": "aesthetic",
            "name": "Aesthetic Predictor",
            "group": "Scoring",
            "available": aesthetic_available,
            **with_status(is_ready=aesthetic_available, is_downloaded=aesthetic_head_exists),
            "message": aesthetic_message,
            "path": aesthetic_head_path if aesthetic_head_exists else None,
            "download_supported": True,
            "note": "Uses CLIP ViT-L/14 + LAION linear head (~3KB). CLIP model (~400MB) downloads on first use via open_clip.",
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

    # Prefer the Civitai API for the latest version; on any failure (403, 5xx,
    # missing downloadUrl, network hiccup) fall back to the pinned direct URL
    # so first-run YOLO prep still succeeds.
    download_url: Optional[str] = None
    try:
        with _urlopen_with_ua(PRIVACY_YOLO_API_URL, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        versions = payload.get("modelVersions") or []
        if versions:
            download_url = versions[0].get("downloadUrl") or None
    except Exception:
        download_url = None
    if not download_url:
        download_url = PRIVACY_YOLO_DIRECT_URL

    civitai_auth_error = _build_civitai_auth_error(target_dir)

    with tempfile.TemporaryDirectory(prefix="privacy-yolo-") as tmp_dir:
        zip_path = Path(tmp_dir) / "privacy-yolo.zip"
        response_content_type = ""
        try:
            src_ctx = _urlopen_with_ua(download_url, timeout=300)
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ExternalAuthRequiredError(civitai_auth_error) from exc
            raise ModelPreparationFailedError(
                _build_privacy_yolo_prepare_error(
                    target_dir,
                    f"Civitai returned HTTP {exc.code} while downloading the archive.",
                )
            ) from exc
        except urllib.error.URLError as exc:
            raise ModelPreparationFailedError(
                _build_privacy_yolo_prepare_error(
                    target_dir,
                    f"Download request failed: {exc.reason or exc}",
                )
            ) from exc

        try:
            with src_ctx as src, open(zip_path, "wb") as dst:
                response_content_type = (src.headers.get("Content-Type") or "").lower()
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)
        except OSError as exc:
            raise ModelPreparationFailedError(
                _build_privacy_yolo_prepare_error(
                    target_dir,
                    f"Failed to store the downloaded archive locally: {exc}",
                )
            ) from exc

        # Civitai may also return HTTP 200 + an HTML login page instead of the
        # zip. Detect this and surface the same actionable guidance.
        if "text/html" in response_content_type or not zipfile.is_zipfile(zip_path):
            if "text/html" in response_content_type:
                raise ExternalAuthRequiredError(civitai_auth_error)
            raise ModelPreparationFailedError(
                _build_privacy_yolo_prepare_error(
                    target_dir,
                    "Downloaded file was not a valid zip archive.",
                )
            )

        try:
            with zipfile.ZipFile(zip_path, "r") as archive:
                for member in archive.namelist():
                    member_path = (target_dir / member).resolve()
                    if not str(member_path).startswith(str(target_dir.resolve())):
                        raise ModelPreparationFailedError(
                            _build_privacy_yolo_prepare_error(
                                target_dir,
                                f"Archive contained an unsafe path: {member}",
                            )
                        )
                archive.extractall(target_dir)
        except zipfile.BadZipFile as exc:
            raise ModelPreparationFailedError(
                _build_privacy_yolo_prepare_error(
                    target_dir,
                    f"Downloaded archive could not be opened as a zip file: {exc}",
                )
            ) from exc
        except OSError as exc:
            raise ModelPreparationFailedError(
                _build_privacy_yolo_prepare_error(
                    target_dir,
                    f"Failed to extract the Privacy YOLO archive: {exc}",
                )
            ) from exc

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

        if model_id == "aesthetic":
            from aesthetic import _ensure_loaded, _get_models_dir, is_available
            import urllib.request as _urllib

            head_path = _get_models_dir() / "sa_0_4_vit_l_14_linear.pth"
            if not head_path.exists():
                url = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_l_14_linear.pth"
                _urllib.urlretrieve(url, str(head_path))

            if is_available():
                _ensure_loaded()
                return {
                    "status": "ok",
                    "model_id": model_id,
                    "message": "Aesthetic predictor is ready.",
                    "paths": {"head_path": str(head_path)},
                }
            return {
                "status": "ok",
                "model_id": model_id,
                "message": "Linear head downloaded. CLIP model will download on first scoring run.",
                "paths": {"head_path": str(head_path)},
            }

        raise HTTPException(status_code=400, detail=f"Model '{request.model_id}' cannot be prepared from the UI yet.")
    except ExternalAuthRequiredError as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.payload)
    except ModelPreparationFailedError as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.payload)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
