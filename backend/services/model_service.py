"""Service layer for model inventory and first-run model preparation."""
from __future__ import annotations

import json
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional

from config import TAGGER_MODELS, get_sam3_model_dir, get_wd14_model_dir, get_yolo_model_dir
from model_health import get_model_health, get_sam3_checkpoint_path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PRIVACY_YOLO_PAGE_URL = "https://civitai.red/models/1736285/and-or-dickvaginatitsanuscum-yolov8-segment-model"
PRIVACY_YOLO_API_URL = "https://civitai.red/api/v1/models/1736285"
PRIVACY_YOLO_DIRECT_URL = (
    "https://civitai.red/api/download/models/1965032?type=Archive&format=Other"
)
SAM3_MODELSCOPE_URL = "https://modelscope.cn/models/facebook/sam3/files"

_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36 sd-image-sorter/3.1.0"
    ),
    "Accept": "application/json, */*;q=0.8",
}
_MAX_PRIVACY_YOLO_ZIP_ENTRIES = 512
_MAX_PRIVACY_YOLO_UNCOMPRESSED_BYTES = 512 * 1024 * 1024


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


def urlopen_with_ua(url: str, timeout: int = 30):
    """Open a URL with a browser-style User-Agent for CDNs that reject urllib."""
    req = urllib.request.Request(url, headers=_DOWNLOAD_HEADERS)
    return urllib.request.urlopen(req, timeout=timeout)


def build_civitai_auth_error(target_dir: Path) -> Dict[str, Any]:
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


def build_privacy_yolo_prepare_error(target_dir: Path, reason: str) -> Dict[str, Any]:
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


class ModelService:
    """Owns model health aggregation, downloads, and preparation side effects."""

    def get_status(self) -> Dict[str, Any]:
        return {
            "status": "ok",
            "models": self.build_model_inventory(),
            "health": get_model_health(),
        }

    def build_model_inventory(self) -> List[Dict[str, Any]]:
        health = get_model_health()
        censor = health["censor"]
        artist = health["artist"]
        installed_wd14 = [item["name"] for item in health["wd14"]["installed_models"] if item["available"]]
        wd14_primary_path = None
        if installed_wd14:
            first_variant = installed_wd14[0]
            wd14_primary_path = str(
                (Path(get_wd14_model_dir()) / first_variant / TAGGER_MODELS[first_variant]["model_file"]).resolve()
            )

        aesthetic_available = False
        aesthetic_message = "Aesthetic predictor dependencies are not installed"
        aesthetic_head_path = str(PROJECT_ROOT / "models" / "aesthetic" / "sa_0_4_vit_l_14_linear.pth")
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

        # -- WD14 --
        if installed_wd14:
            wd14_message_key = "models.wd14.readyCount"
            wd14_message = f"{len(installed_wd14)} WD14 variant(s) are ready."
            wd14_message_params = {"count": len(installed_wd14)}
        else:
            wd14_message_key = "models.wd14.missing"
            wd14_message = "WD14 model files are missing and can be downloaded on demand."
            wd14_message_params = {}

        # -- CLIP --
        clip_health = health["clip"]
        clip_runtime_loaded = clip_health.get("runtime_loaded", False)
        clip_available = clip_health["available"] or clip_runtime_loaded
        if clip_runtime_loaded and not clip_health["available"]:
            clip_message_key = "models.clip.loaded"
            clip_message = "CLIP model is loaded and ready."
        elif clip_health["available"]:
            clip_message_key = "models.clip.ready"
            clip_message = clip_health["message"]
        elif clip_health["model_path"]:
            clip_message_key = "models.clip.missingRuntime"
            clip_message = clip_health["message"]
        else:
            clip_message_key = "models.clip.missingModel"
            clip_message = clip_health["message"]

        # -- Aesthetic --
        if aesthetic_available:
            aesthetic_msg_key = "models.aesthetic.ready"
        elif aesthetic_head_exists:
            aesthetic_msg_key = "models.aesthetic.headOnly"
        else:
            aesthetic_msg_key = "models.aesthetic.missing"

        # -- Artist --
        if artist["available"]:
            artist_message_key = "models.artist.ready"
        else:
            artist_message_key = "models.artist.missing"

        # -- Censor Legacy --
        legacy = censor["legacy"]
        privacy_yolo_files = [f for f in legacy.get("files", []) if f.get("recommended_for_censor")]
        general_yolo_files = [f for f in legacy.get("files", []) if not f.get("recommended_for_censor")]
        if legacy["available"] and privacy_yolo_files:
            if general_yolo_files:
                censor_legacy_key = "models.censorLegacy.readyPrivacyWithGeneral"
            else:
                censor_legacy_key = "models.censorLegacy.readyPrivacy"
        elif legacy["available"]:
            censor_legacy_key = "models.censorLegacy.readyNonPrivacy"
        else:
            censor_legacy_key = "models.censorLegacy.missing"

        # -- NudeNet --
        nudenet = censor["nudenet"]
        if nudenet["available"] and nudenet.get("model_downloaded"):
            nudenet_key = "models.censorNudenet.ready"
        elif nudenet["available"]:
            nudenet_key = "models.censorNudenet.installed"
        else:
            nudenet_key = "models.censorNudenet.missing"

        # -- SAM3 --
        sam3 = censor["sam3"]
        if sam3["available"]:
            sam3_key = "models.sam3.ready"
        elif sam3["checkpoint_path"] and not sam3.get("missing_dependencies"):
            if sam3.get("torch_cuda_build") is None:
                sam3_key = "models.sam3.cpuTorch"
            else:
                sam3_key = "models.sam3.noCuda"
        else:
            sam3_key = "models.sam3.missing"

        return [
            {
                "id": "wd14",
                "name": "WD14 Tagger",
                "group": "Tagging",
                "group_key": "models.group.tagging",
                "available": bool(installed_wd14),
                **with_status(is_ready=bool(installed_wd14), is_downloaded=bool(installed_wd14)),
                "message": wd14_message,
                "message_key": wd14_message_key,
                "message_params": wd14_message_params,
                "path": health["wd14"]["model_path"] or wd14_primary_path,
                "download_supported": True,
                "variants": [item["name"] for item in health["wd14"]["installed_models"]],
                "installed_variants": installed_wd14,
            },
            {
                "id": "clip",
                "name": "CLIP Similarity",
                "group": "Search",
                "group_key": "models.group.search",
                "available": clip_available,
                **with_status(
                    is_ready=bool(clip_available),
                    is_downloaded=bool(clip_health["model_path"] or clip_runtime_loaded),
                ),
                "message": clip_message,
                "message_key": clip_message_key,
                "path": clip_health["model_path"],
                "download_supported": True,
            },
            {
                "id": "aesthetic",
                "name": "Aesthetic Predictor",
                "group": "Scoring",
                "group_key": "models.group.scoring",
                "available": aesthetic_available,
                **with_status(is_ready=aesthetic_available, is_downloaded=aesthetic_head_exists),
                "message": aesthetic_message,
                "message_key": aesthetic_msg_key,
                "path": aesthetic_head_path if aesthetic_head_exists else None,
                "download_supported": True,
                "note": "Uses CLIP ViT-L/14 + LAION linear head (~3KB). CLIP model (~400MB) downloads on first use via open_clip.",
            },
            {
                "id": "artist",
                "name": "Artist ID / Kaloscope",
                "group": "Artist ID",
                "group_key": "models.group.artistId",
                "available": artist["available"],
                **with_status(
                    is_ready=bool(artist["available"]),
                    is_downloaded=bool(artist["checkpoint_path"] or artist["runtime_path"]),
                ),
                "message": artist["message"],
                "message_key": artist_message_key,
                "path": artist["checkpoint_path"],
                "download_supported": True,
                "sources": ["auto", "huggingface", "modelscope"],
                "runtime_path": artist["runtime_path"],
            },
            {
                "id": "censor-legacy",
                "name": "Privacy YOLO",
                "group": "Censor",
                "group_key": "models.group.censor",
                "available": legacy["available"],
                **with_status(
                    is_ready=bool(legacy["available"]),
                    is_downloaded=bool(legacy["default_model_path"]),
                ),
                "message": legacy["message"],
                "message_key": censor_legacy_key,
                "path": legacy["default_model_path"],
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
                "group_key": "models.group.censor",
                "available": nudenet["available"],
                **with_status(
                    is_ready=bool(nudenet["available"]),
                    is_downloaded=bool(nudenet["model_downloaded"] or nudenet["available"]),
                ),
                "message": nudenet["message"],
                "message_key": nudenet_key,
                "path": nudenet["model_path"],
                "download_supported": True,
            },
            {
                "id": "sam3",
                "name": "SAM 3",
                "group": "Censor",
                "group_key": "models.group.censor",
                "available": sam3["available"],
                **with_status(
                    is_ready=bool(sam3["available"]),
                    is_downloaded=bool(sam3["checkpoint_path"]),
                ),
                "message": sam3["message"],
                "message_key": sam3_key,
                "path": sam3["checkpoint_path"],
                "download_supported": True,
                "external_links": [
                    {
                        "label": "ModelScope",
                        "url": SAM3_MODELSCOPE_URL,
                    }
                ],
            },
        ]

    def download_privacy_yolo_bundle(self) -> Dict[str, str]:
        target_dir = Path(get_yolo_model_dir())
        target_dir.mkdir(parents=True, exist_ok=True)

        download_url: Optional[str] = None
        try:
            with urlopen_with_ua(PRIVACY_YOLO_API_URL, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            versions = payload.get("modelVersions") or []
            if versions:
                download_url = versions[0].get("downloadUrl") or None
        except Exception:
            download_url = None
        if not download_url:
            download_url = PRIVACY_YOLO_DIRECT_URL

        civitai_auth_error = build_civitai_auth_error(target_dir)

        with tempfile.TemporaryDirectory(prefix="privacy-yolo-") as tmp_dir:
            zip_path = Path(tmp_dir) / "privacy-yolo.zip"
            response_content_type = ""
            try:
                src_ctx = urlopen_with_ua(download_url, timeout=300)
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403):
                    raise ExternalAuthRequiredError(civitai_auth_error) from exc
                raise ModelPreparationFailedError(
                    build_privacy_yolo_prepare_error(
                        target_dir,
                        f"Civitai returned HTTP {exc.code} while downloading the archive.",
                    )
                ) from exc
            except urllib.error.URLError as exc:
                raise ModelPreparationFailedError(
                    build_privacy_yolo_prepare_error(
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
                    build_privacy_yolo_prepare_error(
                        target_dir,
                        f"Failed to store the downloaded archive locally: {exc}",
                    )
                ) from exc

            if "text/html" in response_content_type or not zipfile.is_zipfile(zip_path):
                if "text/html" in response_content_type:
                    raise ExternalAuthRequiredError(civitai_auth_error)
                raise ModelPreparationFailedError(
                    build_privacy_yolo_prepare_error(
                        target_dir,
                        "Downloaded file was not a valid zip archive.",
                    )
                )

            try:
                target_root = target_dir.resolve()
                with zipfile.ZipFile(zip_path, "r") as archive:
                    total_uncompressed_bytes = 0
                    members = archive.infolist()
                    if len(members) > _MAX_PRIVACY_YOLO_ZIP_ENTRIES:
                        raise ModelPreparationFailedError(
                            build_privacy_yolo_prepare_error(
                                target_dir,
                                "Archive contained too many files to extract safely.",
                            )
                        )
                    for member in members:
                        normalized_name = str(member.filename or "").replace("\\", "/").strip()
                        relative_name = PurePosixPath(normalized_name)
                        if (
                            not normalized_name
                            or relative_name.is_absolute()
                            or normalized_name[:2].endswith(":")
                            or ".." in relative_name.parts
                        ):
                            raise ModelPreparationFailedError(
                                build_privacy_yolo_prepare_error(
                                    target_dir,
                                    f"Archive contained an unsafe path: {member.filename}",
                                )
                            )
                        member_path = (target_root / relative_name).resolve()
                        try:
                            member_path.relative_to(target_root)
                        except ValueError as exc:
                            raise ModelPreparationFailedError(
                                build_privacy_yolo_prepare_error(
                                    target_dir,
                                    f"Archive contained an unsafe path: {member.filename}",
                                )
                            ) from exc
                        if not member.is_dir():
                            total_uncompressed_bytes += member.file_size
                            if total_uncompressed_bytes > _MAX_PRIVACY_YOLO_UNCOMPRESSED_BYTES:
                                raise ModelPreparationFailedError(
                                    build_privacy_yolo_prepare_error(
                                        target_dir,
                                        "Archive uncompressed size exceeded the safe extraction limit.",
                                    )
                                )
                    archive.extractall(target_root)
            except zipfile.BadZipFile as exc:
                raise ModelPreparationFailedError(
                    build_privacy_yolo_prepare_error(
                        target_dir,
                        f"Downloaded archive could not be opened as a zip file: {exc}",
                    )
                ) from exc
            except OSError as exc:
                raise ModelPreparationFailedError(
                    build_privacy_yolo_prepare_error(
                        target_dir,
                        f"Failed to extract the Privacy YOLO archive: {exc}",
                    )
                ) from exc

        default_path = get_model_health()["censor"]["legacy"]["default_model_path"]
        return {
            "model_dir": str(target_dir.resolve()),
            "default_model_path": default_path or "",
        }

    def prepare_model(self, model_id: str, *, source: Optional[str] = None, variant: Optional[str] = None) -> Dict[str, Any]:
        normalized_model_id = model_id.strip().lower()

        if normalized_model_id == "wd14":
            from tagger import DEFAULT_MODEL, WD14Tagger

            model_name = variant or DEFAULT_MODEL
            tagger = WD14Tagger(model_name=model_name, use_gpu=False)
            model_path, tags_path = tagger._get_model_paths()
            return {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": f"WD14 model '{model_name}' is ready.",
                "paths": {"model_path": model_path, "tags_path": tags_path},
            }

        if normalized_model_id == "clip":
            from similarity import ensure_clip_model_ready

            model_path = ensure_clip_model_ready()
            return {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "CLIP model is ready.",
                "paths": {"model_path": model_path},
            }

        if normalized_model_id == "artist":
            from artist_identifier import prepare_artist_assets

            prepared = prepare_artist_assets(source or "auto")
            return {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": f"Artist assets are ready via {prepared['source']}.",
                "paths": prepared,
            }

        if normalized_model_id == "censor-nudenet":
            from nudenet_detector import get_nudenet_detector

            detector = get_nudenet_detector()
            detector.load()
            refreshed = get_model_health()["censor"]["nudenet"]
            return {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "NudeNet runtime is ready.",
                "paths": {"model_path": refreshed["model_path"]},
            }

        if normalized_model_id == "censor-legacy":
            downloaded = self.download_privacy_yolo_bundle()
            return {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "Privacy YOLO files were downloaded from Civitai.",
                "paths": downloaded,
            }

        if normalized_model_id == "sam3":
            checkpoint_before = get_sam3_checkpoint_path()
            if checkpoint_before:
                return {
                    "status": "ok",
                    "model_id": normalized_model_id,
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
                "model_id": normalized_model_id,
                "message": "SAM3 files were downloaded from ModelScope.",
                "paths": {"checkpoint_path": refreshed_path},
            }

        if normalized_model_id == "aesthetic":
            from aesthetic import _ensure_loaded, _get_models_dir, is_available

            head_path = _get_models_dir() / "sa_0_4_vit_l_14_linear.pth"
            if not head_path.exists():
                url = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_l_14_linear.pth"
                urllib.request.urlretrieve(url, str(head_path))

            if is_available():
                _ensure_loaded()
                return {
                    "status": "ok",
                    "model_id": normalized_model_id,
                    "message": "Aesthetic predictor is ready.",
                    "paths": {"head_path": str(head_path)},
                }
            return {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "Linear head downloaded. CLIP model will download on first scoring run.",
                "paths": {"head_path": str(head_path)},
            }

        raise ValueError(f"Model '{model_id}' cannot be prepared from the UI yet.")


_default_model_service = ModelService()


def get_model_service() -> ModelService:
    return _default_model_service
