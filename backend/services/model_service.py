"""Service layer for model inventory and first-run model preparation."""
from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import os
import platform
import shutil
import tempfile
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

from app_info import APP_VERSION
from config import TAGGER_MODELS, get_artist_model_dir, get_sam3_model_dir, get_toriigate_model_dir, get_wd14_model_dir, get_yolo_model_dir
from model_health import get_model_health, get_sam3_checkpoint_path
from optional_dependencies import DependencyInstallResult, ensure_group, ensure_group_with_soft_deps


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PRIVACY_YOLO_PAGE_URL = "https://civitai.red/models/1736285/and-or-dickvaginatitsanuscum-yolov8-segment-model"
PRIVACY_YOLO_API_URL = "https://civitai.red/api/v1/models/1736285"
PRIVACY_YOLO_DIRECT_URL = (
    "https://civitai.red/api/download/models/1965032?type=Archive&format=Other"
)
SAM3_MODELSCOPE_URL = "https://modelscope.cn/models/facebook/sam3/files"
ARTIST_LSNET_RUNTIME_REVISION = "416d945e65b81ced93f1e762349d790ca92106b1"
ARTIST_LSNET_RUNTIME_ZIP_URL = (
    f"https://github.com/spawner1145/comfyui-lsnet/archive/{ARTIST_LSNET_RUNTIME_REVISION}.zip"
)

_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        f"Chrome/124.0.0.0 Safari/537.36 sd-image-sorter/{APP_VERSION}"
    ),
    "Accept": "application/json, */*;q=0.8",
}
_MAX_PRIVACY_YOLO_ZIP_ENTRIES = 512
_MAX_PRIVACY_YOLO_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_MAX_ARTIST_RUNTIME_ZIP_ENTRIES = 1024
_MAX_ARTIST_RUNTIME_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
_model_logger = logging.getLogger(__name__)
_download_progress = {"active": False, "url": "", "downloaded": 0, "total": 0, "filename": ""}
_download_progress_lock = threading.Lock()


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


def _with_dependency_result(result: Dict[str, Any], install_result: DependencyInstallResult) -> Dict[str, Any]:
    if not install_result.installed_packages:
        return result
    return {
        **result,
        "installed_packages": list(install_result.installed_packages),
        "restart_recommended": install_result.restart_recommended,
    }


def _repair_wd14_onnxruntime_if_possible() -> Dict[str, Any]:
    if platform.system() != "Windows":
        return {"attempted": False, "ok": True, "reason": "non_windows"}

    try:
        from repair_onnxruntime import repair_windows_onnxruntime

        result = repair_windows_onnxruntime(stream_pip=True)
        providers = [str(provider) for provider in (result.get("providers_after_repair") or [])]
        has_gpu_provider = "CUDAExecutionProvider" in providers or "DmlExecutionProvider" in providers
        vendor = str(result.get("gpu_vendor_primary") or "").lower()
        gpu_expected = vendor in {"nvidia", "amd", "intel"}
        return {
            "attempted": True,
            "ok": bool(has_gpu_provider or not gpu_expected),
            "repaired": bool(result.get("repaired")),
            "actions": list(result.get("actions") or []),
            "providers_after_repair": providers,
            "gpu_vendor_primary": result.get("gpu_vendor_primary"),
            "target_runtime": result.get("target_runtime"),
        }
    except Exception as exc:
        _model_logger.warning("WD14 ONNX Runtime GPU repair failed: %s", exc)
        return {"attempted": True, "ok": False, "error": str(exc)}


def _dependency_restart_result(model_id: str, install_result: DependencyInstallResult) -> Optional[Dict[str, Any]]:
    if not install_result.installed_packages:
        return None
    packages = ", ".join(install_result.installed_packages)
    return {
        "status": "needs_restart",
        "model_id": model_id,
        "message": (
            f"Installed Python packages for this feature: {packages}. "
            "Restart SD Image Sorter, then click Prepare again if model files still need downloading."
        ),
        "installed_packages": list(install_result.installed_packages),
        "restart_recommended": True,
    }


_ALLOWED_DOWNLOAD_SCHEMES = ("https", "http")


def _resolve_allowed_download_schemes() -> tuple[str, ...]:
    """Return the schemes urlopen_with_ua should accept on this run.

    Production stays restricted to ``https``/``http``. The Playwright
    end-to-end suite stages model fixtures as local files and points the
    backend at them via ``file://`` URLs in environment variables. Setting
    ``SD_IMAGE_SORTER_TEST_ALLOW_FILE_DOWNLOADS=1`` opts into accepting
    ``file://`` so those fixture-driven flows can run without a real CDN.
    The flag is intentionally namespaced as ``_TEST_`` so operators do not
    enable it in production by accident.
    """
    if os.environ.get("SD_IMAGE_SORTER_TEST_ALLOW_FILE_DOWNLOADS", "").strip().lower() in {"1", "true", "yes", "on"}:
        return _ALLOWED_DOWNLOAD_SCHEMES + ("file",)
    return _ALLOWED_DOWNLOAD_SCHEMES


def urlopen_with_ua(url: str, timeout: int = 30):
    """Open a URL with a browser-style User-Agent for CDNs that reject urllib.

    Hardened against env-var-supplied ``file://`` / ``ftp://`` URLs that could
    coerce ``urlopen`` into reading local files or talking to unintended
    services. Scheme is restricted to ``https`` (preferred) or ``http``,
    plus ``file`` only when the explicit test flag opts in.
    """
    from urllib.parse import urlparse

    scheme = (urlparse(url).scheme or "").lower()
    allowed_schemes = _resolve_allowed_download_schemes()
    if scheme not in allowed_schemes:
        raise ValueError(
            f"Refusing to download from scheme {scheme!r}; "
            f"only {allowed_schemes} are allowed."
        )
    req = urllib.request.Request(url, headers=_DOWNLOAD_HEADERS)
    return urllib.request.urlopen(req, timeout=timeout)


def get_download_progress() -> dict:
    with _download_progress_lock:
        return dict(_download_progress)


def _set_download_progress(**updates: Any) -> None:
    with _download_progress_lock:
        _download_progress.update(updates)


def _direct_download_file(url: str, dest: Path, *, timeout: int = 300) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _model_logger.info("Downloading %s → %s", url, dest)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    delay_ms = max(0, int(os.environ.get("SD_IMAGE_SORTER_DOWNLOAD_CHUNK_DELAY_MS", "0") or "0"))
    _set_download_progress(active=True, url=url, downloaded=0, total=0, filename=dest.name)
    try:
        with urlopen_with_ua(url, timeout=timeout) as src, open(tmp, "wb") as dst:
            total = int(src.headers.get("Content-Length") or 0)
            _set_download_progress(total=total)
            downloaded = 0
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
                downloaded += len(chunk)
                _set_download_progress(downloaded=downloaded)
                if delay_ms:
                    time.sleep(delay_ms / 1000)
        tmp.replace(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    finally:
        _set_download_progress(active=False, downloaded=0, total=0)
    return dest


def _safe_extract_single_root_zip(zip_path: Path, target_dir: Path, *, max_entries: int, max_bytes: int) -> Path:
    with tempfile.TemporaryDirectory(prefix=f"{target_dir.name}-extract-") as tmp_dir:
        extract_dir = Path(tmp_dir) / "extract"
        extract_dir.mkdir(parents=True, exist_ok=True)
        extract_root = extract_dir.resolve()
        total_uncompressed_bytes = 0
        with zipfile.ZipFile(zip_path, "r") as archive:
            members = archive.infolist()
            if len(members) > max_entries:
                raise ValueError("Zip contains too many entries to extract safely")
            for member in members:
                normalized_name = str(member.filename or "").replace("\\", "/").strip()
                relative_name = PurePosixPath(normalized_name)
                if (
                    not normalized_name
                    or relative_name.is_absolute()
                    or normalized_name[:2].endswith(":")
                    or ".." in relative_name.parts
                ):
                    raise ValueError(f"Zip contains an unsafe path: {member.filename}")
                member_path = (extract_root / relative_name).resolve()
                try:
                    member_path.relative_to(extract_root)
                except ValueError as exc:
                    raise ValueError(f"Zip contains an unsafe path: {member.filename}") from exc
                if not member.is_dir():
                    total_uncompressed_bytes += member.file_size
                    if total_uncompressed_bytes > max_bytes:
                        raise ValueError("Zip uncompressed size exceeds the safe extraction limit")
            archive.extractall(extract_root)

        extracted_roots = [path for path in extract_dir.iterdir() if path.is_dir()]
        if len(extracted_roots) != 1:
            raise ValueError("Zip must contain exactly one root directory")
        if target_dir.exists():
            shutil.rmtree(target_dir)
        shutil.move(str(extracted_roots[0]), str(target_dir))
    return target_dir


def _artist_runtime_url() -> str:
    return os.environ.get("SD_IMAGE_SORTER_ARTIST_RUNTIME_ZIP_URL") or ARTIST_LSNET_RUNTIME_ZIP_URL


def _artist_resolve_url(repo_id: str, filename: str, *, hf_base: str) -> str:
    return f"{hf_base.rstrip('/')}/{repo_id}/resolve/main/{filename}"


def _artist_checkpoint_url(repo_id: str, filename: str, *, hf_base: str) -> str:
    if filename == "class_mapping.csv":
        configured = os.environ.get("SD_IMAGE_SORTER_ARTIST_CLASS_MAPPING_URL")
    else:
        configured = os.environ.get("SD_IMAGE_SORTER_ARTIST_CHECKPOINT_URL")
    return configured or _artist_resolve_url(repo_id, filename, hf_base=hf_base)


# Files the transformers SAM3 loader needs in the checkpoint directory.
# ``sam3.pt`` is intentionally NOT in this list — it's the legacy 3.45 GB
# pickle from the unmaintained sam3 0.1.3 package; the transformers backend
# loads ``model.safetensors`` directly from this same directory.
_SAM3_DOWNLOAD_FILES = (
    "config.json",
    "model.safetensors",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
)


def _sam3_download_urls() -> List[Tuple[str, str]]:
    """Return ``(filename, url)`` pairs for the full transformers SAM3 checkpoint.

    Honours ``SD_IMAGE_SORTER_SAM3_BASE_URL`` for users who want to point the
    downloader at an alternate ModelScope/HF mirror. Defaults to ModelScope's
    facebook/sam3 so China users do not need HF access.
    """
    configured_base = os.environ.get("SD_IMAGE_SORTER_SAM3_BASE_URL", "").strip().rstrip("/")
    base = configured_base or "https://modelscope.cn/models/facebook/sam3/resolve/master"
    return [(name, f"{base}/{name}") for name in _SAM3_DOWNLOAD_FILES]


def _repair_sam3_runtime_if_possible() -> Dict[str, Any]:
    if platform.system() != "Windows":
        return {"attempted": False, "reason": "non_windows"}
    if os.environ.get("SD_IMAGE_SORTER_SKIP_TORCH_REPAIR", "").strip().lower() in {"1", "true", "yes", "on"}:
        return {"attempted": False, "reason": "disabled"}

    repair_script = Path(__file__).resolve().parents[1] / "repair_torch_runtime.py"
    if not repair_script.exists():
        return {"attempted": False, "reason": "repair_script_missing"}

    _model_logger.info("Checking and repairing SAM3/PyTorch runtime before reporting SAM3 readiness")
    try:
        completed = subprocess.run(
            [sys.executable, str(repair_script), "--auto"],
            cwd=str(repair_script.parent),
            text=True,
            timeout=int(os.environ.get("SD_IMAGE_SORTER_TORCH_REPAIR_TIMEOUT", "3600") or "3600"),
            check=False,
        )
    except Exception as exc:
        _model_logger.warning("SAM3 runtime repair could not be started: %s", exc)
        return {"attempted": True, "ok": False, "error": str(exc)}

    importlib.invalidate_caches()
    # Reset SAM3 module-level singletons so a fresh import picks up the newly
    # installed runtime. We hold ``exclusive_ai_runtime("sam3-load")`` so
    # in-flight SAM3 work elsewhere does not observe a half-reset state.
    try:
        from ai_runtime_guard import exclusive_ai_runtime
    except Exception as exc:  # noqa: BLE001 — only fires if the guard module is unavailable
        _model_logger.warning(
            "ai_runtime_guard unavailable; resetting SAM3 singletons without a lock: %s", exc
        )
        exclusive_ai_runtime = None  # type: ignore[assignment]

    def _reset_sam3_singletons() -> None:
        try:
            import sam3_refiner

            sam3_refiner._sam3_available = None
            sam3_refiner._sam3_model = None
            sam3_refiner._sam3_processor = None
            sam3_refiner._sam3_device = None
        except ImportError as exc:
            _model_logger.warning("Could not import sam3_refiner to reset singletons: %s", exc)
        except AttributeError as exc:
            _model_logger.warning("sam3_refiner singleton attribute layout changed: %s", exc)

    if exclusive_ai_runtime is None:
        _reset_sam3_singletons()
    else:
        with exclusive_ai_runtime("sam3-load"):
            _reset_sam3_singletons()

    if completed.returncode != 0:
        _model_logger.warning("SAM3 runtime repair exited with code %s", completed.returncode)
        return {"attempted": True, "ok": False, "returncode": completed.returncode}
    return {"attempted": True, "ok": True}


def _materialize_existing_file(source: Path, dest: Path) -> bool:
    if not source.exists() or dest.exists():
        return dest.exists()
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, dest)
    except OSError:
        shutil.copy2(source, dest)
    return True


def _copy_existing_tree(source: Path, dest: Path, marker_name: str) -> bool:
    if not (source / marker_name).exists():
        return False
    if (dest / marker_name).exists():
        return True
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(source, dest)
    return True


def _ensure_artist_runtime_direct() -> str:
    target_dir = Path(get_artist_model_dir()) / "comfyui-lsnet-runtime"
    if (target_dir / "lsnet_model").exists():
        return str(target_dir.resolve())

    if os.environ.get("SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY") != "1":
        legacy_dir = PROJECT_ROOT / "models" / "artist" / "comfyui-lsnet-runtime"
        if _copy_existing_tree(legacy_dir, target_dir, "lsnet_model"):
            return str(target_dir.resolve())

    with tempfile.TemporaryDirectory(prefix="kaloscope-runtime-") as tmp_dir:
        zip_path = Path(tmp_dir) / "comfyui-lsnet-runtime.zip"
        _direct_download_file(_artist_runtime_url(), zip_path, timeout=300)
        _safe_extract_single_root_zip(
            zip_path,
            target_dir,
            max_entries=_MAX_ARTIST_RUNTIME_ZIP_ENTRIES,
            max_bytes=_MAX_ARTIST_RUNTIME_UNCOMPRESSED_BYTES,
        )
    if not (target_dir / "lsnet_model").exists():
        raise RuntimeError("Downloaded LSNet runtime did not contain lsnet_model.")
    return str(target_dir.resolve())


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
        aesthetic_runtime_ready = (
            importlib.util.find_spec("torch") is not None
            and importlib.util.find_spec("open_clip") is not None
        )
        aesthetic_available = bool(aesthetic_head_exists and aesthetic_runtime_ready)
        if aesthetic_available:
            aesthetic_message = "Aesthetic predictor is ready (CLIP + linear head)."
        elif aesthetic_head_exists:
            aesthetic_message = "Linear head downloaded but CLIP dependencies missing (torch/open_clip)."

        def with_status(*, is_ready: bool, is_downloaded: bool) -> Dict[str, str]:
            if is_ready:
                return {"status": "ready", "status_label": "Ready"}
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

        # -- ToriiGate --
        toriigate = health.get("toriigate", {})
        toriigate_available = bool(toriigate.get("available"))
        toriigate_dir = toriigate.get("model_dir") or str(Path(get_toriigate_model_dir()) / "toriigate-0.5")

        # -- OppaiOracle --
        oppai_oracle = health.get("oppai_oracle", {})
        oppai_oracle_available = bool(oppai_oracle.get("available"))
        oppai_oracle_dir = oppai_oracle.get("model_dir") or ""

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
        elif not artist.get("checkpoint_path") and not artist.get("has_download_source"):
            artist_message_key = "models.artist.noSource"
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
        sam3_missing_packages = sam3.get("missing_dependency_packages") or sam3.get("missing_dependencies") or []
        sam3_message_params = {"deps": ", ".join(sam3_missing_packages)}
        if sam3["available"]:
            sam3_key = "models.sam3.ready"
        elif sam3["checkpoint_path"] and sam3_missing_packages and sam3.get("torch_version") and sam3.get("torch_cuda_build") is None:
            sam3_key = "models.sam3.missingDepsCpuTorch"
        elif sam3["checkpoint_path"] and sam3_missing_packages:
            sam3_key = "models.sam3.missingDeps"
        elif sam3["checkpoint_path"]:
            if sam3.get("torch_cuda_build") is None:
                sam3_key = "models.sam3.cpuTorch"
            elif not sam3.get("cuda_available"):
                sam3_key = "models.sam3.noCuda"
            else:
                sam3_key = "models.sam3.missing"
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
                "setup_steps": [
                    "Click Prepare / Download to download the selected WD14 model files if missing.",
                    "On Windows, the same action also repairs ONNX GPU packages so CUDA/DirectML can appear.",
                    "Restart SD Image Sorter if the Prepare result says ONNX Runtime was repaired.",
                ],
            },
            {
                "id": "toriigate",
                "name": "ToriiGate 0.5",
                "group": "Tagging",
                "group_key": "models.group.tagging",
                "available": toriigate_available,
                **with_status(
                    is_ready=toriigate_available,
                    is_downloaded=bool(Path(toriigate_dir).joinpath("config.json").exists()),
                ),
                "message": toriigate.get("message") or "ToriiGate files are not downloaded yet. The first run will need a large model download.",
                "message_key": "models.toriigate.ready" if toriigate_available else "models.toriigate.missing",
                "path": toriigate_dir,
                "download_supported": True,
                "setup_steps": [
                    "Click Prepare / Download to install the PyTorch/Transformers runtime if missing.",
                    "Restart SD Image Sorter if the Prepare result says Python packages were installed.",
                    "Click Prepare / Download again to download the ToriiGate model files (~5 GB) if they are not present.",
                ],
            },
            {
                "id": "oppai-oracle",
                "name": "OppaiOracle V1.1",
                "group": "Tagging",
                "group_key": "models.group.tagging",
                "available": oppai_oracle_available,
                **with_status(
                    is_ready=oppai_oracle_available,
                    is_downloaded=oppai_oracle_available,
                ),
                "message": oppai_oracle.get("message") or "OppaiOracle V1.1 (~947 MB ONNX) is not downloaded yet.",
                "message_key": "models.oppaiOracle.ready" if oppai_oracle_available else "models.oppaiOracle.missing",
                "path": oppai_oracle_dir,
                "download_supported": True,
                "setup_steps": [
                    "Click Prepare / Download to fetch the OppaiOracle V1.1 ONNX bundle (~947 MB) from HuggingFace.",
                    "No additional Python packages are required; ONNX Runtime is already installed.",
                    "Once ready, OppaiOracle V1.1 will appear in the tagger model dropdown.",
                ],
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
                "path": clip_health["model_path"] or clip_health.get("expected_path", ""),
                "download_supported": True,
                "setup_steps": [
                    "Click Prepare to install fastembed Python package (restart required after install).",
                    "Click Prepare again after restart to download the CLIP ViT-B/32 ONNX model (~335 MB).",
                    "Manual: place model.onnx + config.json in " + clip_health.get("expected_path", "data/models/clip/Qdrant-clip-ViT-B-32-vision"),
                ],
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
                "path": artist["checkpoint_path"] or artist.get("expected_path", ""),
                "download_supported": bool(artist.get("has_download_source", True)),
                "sources": [
                    s for s in ["auto", "huggingface", "modelscope"]
                    if s == "auto"
                    or (s == "huggingface" and artist.get("huggingface_available"))
                    or (s == "modelscope" and artist.get("modelscope_available"))
                ],
                "runtime_path": artist["runtime_path"],
                "setup_steps": [
                    "Click Prepare to install torch/transformers/timm Python packages (restart required).",
                    "Click Prepare again after restart to download Kaloscope 2.0 model (~2.8 GB).",
                    "Source: HuggingFace (heathcliff01/Kaloscope2.0) or ModelScope (Heathcliff02/Kaloscope-2.0) — pick via the Download Source selector above.",
                    "Manual: put best_checkpoint.pth in " + str(Path(get_artist_model_dir()) / "kaloscope2.0" / "448-90.13"),
                    "Manual: put class_mapping.csv in " + str(Path(get_artist_model_dir()) / "kaloscope2.0"),
                    "Manual: the LSNet runtime (lsnet_model/) goes in " + str(Path(get_artist_model_dir()) / "comfyui-lsnet-runtime"),
                ],
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
                "path": legacy["default_model_path"] or legacy.get("expected_path", ""),
                "download_supported": True,
                "external_links": [
                    {
                        "label": "Civitai",
                        "url": PRIVACY_YOLO_PAGE_URL,
                    }
                ],
                "setup_steps": [
                    "Click Prepare to auto-download the recommended privacy YOLO model.",
                    "If auto-download fails (Civitai login wall), download manually from the Civitai link above.",
                    "Place the .pt file in " + str(Path(get_yolo_model_dir())),
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
                "message_params": sam3_message_params,
                "path": sam3["checkpoint_path"] or sam3.get("expected_path", ""),
                "download_supported": True,
                "setup_steps": [
                    "Click Prepare / Download to install SAM3 Python runtime packages if they are missing.",
                    "Restart SD Image Sorter if the Prepare result says Python packages were installed.",
                    "Click Prepare / Download again to fetch model.safetensors, or place sam3.pt / model.safetensors manually only if the download fails: " + str(Path(get_sam3_model_dir()) / "facebook-sam3-modelscope"),
                ],
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
            runtime_repair = _repair_wd14_onnxruntime_if_possible()

            from tagger import DEFAULT_MODEL, WD14Tagger

            model_name = variant or DEFAULT_MODEL
            tagger = WD14Tagger(model_name=model_name, use_gpu=False)
            model_path, tags_path = tagger._get_model_paths()
            result = {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": f"WD14 model '{model_name}' is ready.",
                "paths": {"model_path": model_path, "tags_path": tags_path},
                "runtime_repair": runtime_repair,
            }
            if runtime_repair.get("attempted") and not runtime_repair.get("ok"):
                result["status"] = "warning"
                result["message"] = (
                    f"WD14 model '{model_name}' is ready, but ONNX GPU runtime repair did not finish. "
                    "Tagging may stay on CPU until the runtime is repaired."
                )
            elif runtime_repair.get("repaired"):
                result["restart_recommended"] = True
                result["message"] = (
                    f"WD14 model '{model_name}' is ready. ONNX GPU runtime was repaired; "
                    "restart the app before using GPU tagging."
                )
            return result


        if normalized_model_id == "toriigate":
            dependency_result = ensure_group("toriigate")
            restart_result = _dependency_restart_result(normalized_model_id, dependency_result)
            if restart_result:
                return restart_result
            from toriigate_tagger import ToriiGateTagger

            model_dir = get_toriigate_model_dir()
            tagger = ToriiGateTagger(model_name="toriigate-0.5", model_dir=model_dir, use_gpu=False)
            resolved_dir = tagger._download_model()
            return _with_dependency_result({
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "ToriiGate runtime and model files are ready.",
                "paths": {"model_dir": resolved_dir},
            }, dependency_result)

        if normalized_model_id == "oppai-oracle":
            # OppaiOracle V1.1 ONNX (~947 MB) is downloaded by the dedicated
            # OppaiOracleTagger class. No extra Python dependencies are needed
            # beyond what WD14 / ONNX Runtime already require, so we do not
            # ensure_group() here — the tagger uses huggingface_hub which is
            # already part of the lightweight core.
            from oppai_oracle_tagger import OppaiOracleTagger, DEFAULT_MODEL as OPPAI_DEFAULT
            from config import get_oppai_oracle_model_dir

            target_variant = (variant or OPPAI_DEFAULT).strip() or OPPAI_DEFAULT
            tagger = OppaiOracleTagger(
                model_name=target_variant,
                model_dir=get_oppai_oracle_model_dir(),
                use_gpu=False,
            )
            model_path, tags_path = tagger._get_model_paths()
            return {
                "status": "ok",
                "model_id": normalized_model_id,
                "message": f"OppaiOracle '{target_variant}' is ready.",
                "paths": {"model_path": model_path, "tags_path": tags_path},
            }

        if normalized_model_id == "clip":
            dependency_result = ensure_group("clip")
            restart_result = _dependency_restart_result(normalized_model_id, dependency_result)
            if restart_result:
                return restart_result
            from similarity import ensure_clip_model_ready

            model_path = ensure_clip_model_ready()
            return _with_dependency_result({
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "CLIP model is ready.",
                "paths": {"model_path": model_path},
            }, dependency_result)

        if normalized_model_id == "artist":
            dependency_result = ensure_group_with_soft_deps("artist")
            restart_result = _dependency_restart_result(normalized_model_id, dependency_result)
            if restart_result:
                return restart_result
            from artist_identifier import prepare_artist_assets

            preferred_source = source or "auto"
            prepared = prepare_artist_assets(preferred_source)

            return _with_dependency_result({
                "status": "ok",
                "model_id": normalized_model_id,
                "message": f"Artist checkpoint is ready via {prepared.get('source', preferred_source)}.",
                "paths": {
                    "runtime_path": str(Path(prepared["runtime_path"]).resolve()),
                    "checkpoint_path": str(Path(prepared["checkpoint_path"]).resolve()),
                    "class_mapping_path": str(Path(prepared["class_mapping_path"]).resolve()),
                },
            }, dependency_result)

        if normalized_model_id == "censor-nudenet":
            dependency_result = ensure_group("nudenet")
            restart_result = _dependency_restart_result(normalized_model_id, dependency_result)
            if restart_result:
                return restart_result
            from nudenet_detector import get_nudenet_detector

            detector = get_nudenet_detector()
            detector.load()
            refreshed = get_model_health()["censor"]["nudenet"]
            return _with_dependency_result({
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "NudeNet runtime is ready.",
                "paths": {"model_path": refreshed["model_path"]},
            }, dependency_result)

        if normalized_model_id == "censor-legacy":
            # Keep first launch light, but preserve the existing .pt YOLO path
            # once the user explicitly prepares the legacy censor model.
            dependency_result = ensure_group("yolo")
            restart_result = _dependency_restart_result(normalized_model_id, dependency_result)
            if restart_result:
                return restart_result
            downloaded = self.download_privacy_yolo_bundle()
            return _with_dependency_result({
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "Privacy YOLO files were downloaded from Civitai.",
                "paths": downloaded,
            }, dependency_result)

        if normalized_model_id == "sam3":
            dependency_result = DependencyInstallResult(installed_packages=())
            if platform.system() != "Darwin":
                dependency_result = ensure_group("sam3")
            restart_result = _dependency_restart_result(normalized_model_id, dependency_result)
            if restart_result:
                return restart_result

            def sam3_prepare_result(checkpoint_path: Optional[str]) -> Dict[str, Any]:
                health = get_model_health()["censor"]["sam3"]
                is_ready = bool(health.get("available"))
                return {
                    "status": "ok" if is_ready else "needs_runtime",
                    "model_id": normalized_model_id,
                    "ready": is_ready,
                    "message": health.get("message") or (
                        "SAM3 is ready." if is_ready else "SAM3 checkpoint is installed, but runtime setup is incomplete."
                    ),
                    "paths": {"checkpoint_path": checkpoint_path},
                    "missing_dependencies": health.get("missing_dependencies") or [],
                    "missing_dependency_packages": health.get("missing_dependency_packages") or [],
                    "cuda_available": health.get("cuda_available"),
                    "torch_cuda_build": health.get("torch_cuda_build"),
                }

            checkpoint_before = get_sam3_checkpoint_path()
            if checkpoint_before:
                result = sam3_prepare_result(checkpoint_before)
                if not result.get("ready"):
                    result["runtime_repair"] = _repair_sam3_runtime_if_possible()
                    result = {**sam3_prepare_result(checkpoint_before), "runtime_repair": result["runtime_repair"]}
                return _with_dependency_result(result, dependency_result)

            sam3_dir = Path(get_sam3_model_dir()) / "facebook-sam3-modelscope"
            sam3_dir.mkdir(parents=True, exist_ok=True)
            # Idempotent file-by-file fetch: skip files already on disk so users
            # who already have the giant model.safetensors don't redownload it
            # just to backfill the small config / tokenizer files.
            errors: List[str] = []
            for filename, url in _sam3_download_urls():
                dest = sam3_dir / filename
                if dest.exists() and dest.stat().st_size > 0:
                    continue
                try:
                    _direct_download_file(url, dest, timeout=900)
                except Exception as exc:
                    errors.append(f"{filename}: {exc}")
                    _model_logger.warning(
                        "SAM3 file download failed: %s -> %s: %s", url, dest, exc
                    )

            refreshed_path = get_sam3_checkpoint_path()
            if not refreshed_path:
                detail = "; ".join(errors) if errors else "no completed downloads"
                raise RuntimeError(
                    f"Could not assemble SAM3 checkpoint ({detail}). "
                    f"You can manually download files from {SAM3_MODELSCOPE_URL} and place them in {sam3_dir}"
                )
            result = sam3_prepare_result(refreshed_path)
            if not result.get("ready"):
                result["runtime_repair"] = _repair_sam3_runtime_if_possible()
                result = {**sam3_prepare_result(refreshed_path), "runtime_repair": result["runtime_repair"]}
            return _with_dependency_result(result, dependency_result)

        if normalized_model_id == "aesthetic":
            dependency_result = ensure_group("aesthetic")
            # If ensure_group() actually installed torch / open_clip, the
            # cached "torch is missing" answer in aesthetic.is_available
            # would otherwise stick for the rest of this process. Reset
            # the cache before the next is_available() call below so the
            # post-install flow correctly reports "ready" instead of
            # echoing the pre-install state, and the frontend's next
            # /api/aesthetic/status poll re-runs the import check.
            try:
                from aesthetic import reset_availability_cache
                reset_availability_cache()
            except ImportError:
                # aesthetic.py imports torch lazily inside is_available, so
                # this import should never fail; defend against an aborted
                # partial install just in case.
                pass
            restart_result = _dependency_restart_result(normalized_model_id, dependency_result)
            if restart_result:
                return restart_result
            from aesthetic import _ensure_loaded, _get_models_dir, is_available

            head_path = _get_models_dir() / "sa_0_4_vit_l_14_linear.pth"
            if not head_path.exists():
                url = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_l_14_linear.pth"
                _direct_download_file(url, head_path, timeout=120)

            if is_available():
                _ensure_loaded()
                return _with_dependency_result({
                    "status": "ok",
                    "model_id": normalized_model_id,
                    "message": "Aesthetic predictor is ready.",
                    "paths": {"head_path": str(head_path)},
                }, dependency_result)
            return _with_dependency_result({
                "status": "ok",
                "model_id": normalized_model_id,
                "message": "Linear head downloaded. CLIP model will download on first scoring run.",
                "paths": {"head_path": str(head_path)},
            }, dependency_result)

        raise ValueError(f"Model '{model_id}' cannot be prepared from the UI yet.")


_default_model_service = ModelService()


def get_model_service() -> ModelService:
    return _default_model_service
