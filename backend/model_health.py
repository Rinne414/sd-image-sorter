"""
Unified model discovery and readiness helpers for SD Image Sorter.

This module keeps model path detection in one place so the backend, startup
scripts, and frontend diagnostics can all report the same truth.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

_BACKEND_DIR = str(Path(__file__).resolve().parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from config import (
    ARTIST_HF_MODEL_ID,
    ARTIST_KALOSCOPE_CHECKPOINT,
    ARTIST_KALOSCOPE_CLASS_MAPPING,
    ARTIST_LSNET_CODE_PATH,
    CLIP_MODEL_NAME,
    DEFAULT_TAGGER_MODEL,
    TAGGER_MODELS,
    get_artist_model_dir,
    get_clip_model_dir,
    get_nudenet_model_dir,
    get_toriigate_model_dir,
    get_oppai_oracle_model_dir,
    get_sam3_model_dir,
    get_wd14_model_dir,
    get_yolo_model_dir,
)
from hardware_monitor import get_system_info, recommend_tagger_config
from ai_runtime_guard import exclusive_ai_runtime

from censor import canonicalize_class_name as _canonicalize_yolo_class_name


def _clip_model_loaded() -> bool:
    """Check whether the FastEmbed CLIP model singleton is already loaded in memory."""
    try:
        from similarity import _embed_model
        return _embed_model is not None
    except Exception:
        return False


def _module_available(module_name: str) -> bool:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            importlib.import_module(module_name)
        return True
    except Exception:
        return False


def _module_installed(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _probe_loaded_torch_runtime() -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "torch_version": None,
        "torch_cuda_build": None,
        "torch_cuda_available": False,
        "torch_probe_error": None,
        "torch_probe_source": "current-process",
    }
    try:
        torch = sys.modules.get("torch")
        if torch is None:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                torch = importlib.import_module("torch")
        result["torch_version"] = getattr(torch, "__version__", None)
        result["torch_cuda_build"] = getattr(getattr(torch, "version", None), "cuda", None)
        result["torch_cuda_available"] = bool(torch.cuda.is_available())
    except Exception as exc:
        result["torch_probe_error"] = str(exc)
    return result


def _probe_torch_runtime() -> Dict[str, Any]:
    if "torch" in sys.modules:
        return _probe_loaded_torch_runtime()

    code = r'''
import json
from importlib import metadata
result = {
    "torch_version": None,
    "torch_cuda_build": None,
    "torch_cuda_available": False,
    "torch_probe_error": None,
    "torch_probe_source": "subprocess",
}
try:
    result["torch_version"] = metadata.version("torch")
except Exception:
    pass
try:
    import torch
    result["torch_version"] = getattr(torch, "__version__", result["torch_version"])
    result["torch_cuda_build"] = getattr(getattr(torch, "version", None), "cuda", None)
    result["torch_cuda_available"] = bool(torch.cuda.is_available())
except Exception as exc:
    result["torch_probe_error"] = str(exc)
print(json.dumps(result))
'''.strip()
    try:
        completed = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
    except Exception as exc:
        return {
            "torch_version": None,
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": str(exc),
            "torch_probe_source": "subprocess",
        }

    if completed.returncode != 0:
        return {
            "torch_version": None,
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": (completed.stderr or completed.stdout or f"exit {completed.returncode}").strip(),
            "torch_probe_source": "subprocess",
        }

    try:
        parsed = json.loads((completed.stdout or "{}").strip().splitlines()[-1])
    except Exception as exc:
        return {
            "torch_version": None,
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": f"Could not parse torch probe output: {exc}",
            "torch_probe_source": "subprocess",
        }

    return {
        "torch_version": parsed.get("torch_version"),
        "torch_cuda_build": parsed.get("torch_cuda_build"),
        "torch_cuda_available": bool(parsed.get("torch_cuda_available")),
        "torch_probe_error": parsed.get("torch_probe_error"),
        "torch_probe_source": parsed.get("torch_probe_source") or "subprocess",
    }


SAM3_REQUIRED_MODULES = (
    ("torch", "torch"),
    ("transformers", "transformers"),
    ("safetensors", "safetensors"),
    ("cv2", "opencv-python"),
)

SAM3_IMPORT_TO_PACKAGE = dict(SAM3_REQUIRED_MODULES)


def _sam3_missing_dependency_packages(missing_imports: Iterable[str]) -> List[str]:
    packages: List[str] = []
    for module_name in missing_imports:
        package_name = SAM3_IMPORT_TO_PACKAGE.get(module_name, module_name)
        if package_name not in packages:
            packages.append(package_name)
    return packages


def _sam3_supported_on_platform() -> bool:
    return sys.platform != "darwin"


def _format_sam3_readiness_message(
    *,
    checkpoint_path: Optional[str],
    missing_packages: List[str],
    cuda_available: bool,
    uses_cpu_only_torch: bool,
    supported_on_platform: bool = True,
) -> str:
    if not supported_on_platform:
        return "SAM3 Pro masks are currently disabled on macOS because this app treats SAM3 as a CUDA-only feature."

    if not checkpoint_path:
        if missing_packages:
            return "SAM3 checkpoint is missing, and runtime packages are not installed: " + ", ".join(missing_packages) + "."
        return (
            "SAM3 checkpoint is missing. Download it via Prepare or drop a transformers SAM3 directory "
            "(config.json + model.safetensors + tokenizer files) under models/sam3/facebook-sam3-modelscope."
        )

    problems: List[str] = []
    if missing_packages:
        problems.append("missing Python packages: " + ", ".join(missing_packages))
    if uses_cpu_only_torch:
        problems.append("this app's Python has CPU-only PyTorch; SAM3 needs a CUDA-enabled Torch build")
    elif not cuda_available:
        problems.append("CUDA is not available to this app's Python right now")

    if problems:
        return "SAM3 checkpoint is installed, but SAM3 is not ready: " + "; ".join(problems) + "."
    return "SAM3 checkpoint and runtime dependencies are ready."


def _list_model_files(directory: Path, extensions: Iterable[str]) -> List[Dict[str, Any]]:
    if not directory.exists():
        return []

    allowed = {ext.lower() for ext in extensions}
    files = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in allowed:
            continue
        files.append(
            {
                "name": path.name,
                "path": str(path.resolve()),
                "size_mb": round(path.stat().st_size / (1024 * 1024), 1),
            }
        )
    return files


def _parse_class_mapping(raw_names: Any) -> List[str]:
    if isinstance(raw_names, str):
        try:
            raw_names = json.loads(raw_names)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(raw_names, dict):
        ordered = []
        for key in sorted(raw_names.keys(), key=lambda item: int(item) if str(item).isdigit() else str(item)):
            ordered.append(str(raw_names[key]))
        return ordered
    if isinstance(raw_names, list):
        return [str(item) for item in raw_names]
    return []


def _load_yolo_class_names(model_path: Path) -> List[str]:
    candidates = []
    if model_path.suffix.lower() == ".onnx":
        candidates.append(model_path)
    else:
        onnx_candidate = model_path.with_suffix(".onnx")
        if onnx_candidate.exists():
            candidates.append(onnx_candidate)

    for candidate in candidates:
        try:
            from runtime_env import prepare_onnxruntime_environment

            prepare_onnxruntime_environment()
            import onnxruntime as ort

            with exclusive_ai_runtime("model-health-onnx-metadata"):
                session = ort.InferenceSession(str(candidate), providers=["CPUExecutionProvider"])
                metadata = session.get_modelmeta().custom_metadata_map or {}
            raw_names = metadata.get("names")
            if not raw_names:
                continue
            return _parse_class_mapping(raw_names)
        except Exception:
            continue

    if model_path.suffix.lower() in {".pt", ".pth"} and _module_installed("ultralytics"):
        try:
            from ultralytics import YOLO

            with exclusive_ai_runtime("model-health-ultralytics-metadata"):
                return _parse_class_mapping(getattr(YOLO(str(model_path)), "names", {}))
        except Exception:
            return []

    return []


def _infer_yolo_model_profile(class_names: List[str], filename: str) -> Dict[str, Any]:
    canonical = [_canonicalize_yolo_class_name(name) for name in class_names]
    canonical_set = {name.replace(" ", "") for name in canonical}
    privacy_keywords = {"anus", "cum", "dick", "breasts", "pussy"}
    filename_lower = filename.lower()

    if privacy_keywords.intersection(canonical_set):
        return {
            "id": "privacy-censor",
            "label": "Privacy-part detector",
            "recommended_for_censor": True,
            "message": "Specialized for privacy-part detection and censor workflows.",
        }

    if "wenaka" in filename_lower:
        return {
            "id": "privacy-censor",
            "label": "Privacy-part detector",
            "recommended_for_censor": True,
            "message": "Wenaka is treated as a privacy-part detector even when ONNX metadata is incomplete.",
        }

    if "yolo26" in filename_lower or "yolov8" in filename_lower:
        return {
            "id": "general-object",
            "label": "General object segmentation",
            "recommended_for_censor": False,
            "message": "This is a general COCO-style object model. It is useful for compatibility tests, not for privacy-part censoring.",
        }

    return {
        "id": "unknown",
        "label": "Unknown model type",
        "recommended_for_censor": False,
        "message": "Model classes could not be identified automatically.",
    }


def _build_yolo_capabilities(profile_id: str, filename: str, class_names: List[str]) -> Dict[str, Any]:
    filename_lower = filename.lower()
    class_count = len(class_names)
    supports_mask_output = "seg" in filename_lower

    if profile_id == "privacy-censor":
        return {
            "class_scope": "fixed-privacy",
            "class_scope_label": f"{class_count or 5} built-in privacy classes",
            "input_mode_label": "Fixed privacy-part labels",
            "output_mode_label": "Privacy-part segmentation masks" if supports_mask_output else "Fast box-first censoring",
            "supports_text_prompt": False,
            "supports_mask_output": supports_mask_output,
            "recommended_user_level": "normal",
            "best_for": "Quick privacy-part censoring",
            "plain_english": (
                "Best for normal users who want quick privacy-part auto-detection. "
                + (
                    "When the runtime preserves segmentation outputs, auto-censor can use the model masks directly. "
                    if supports_mask_output
                    else ""
                )
                + "This route does not understand arbitrary text prompts."
            ),
        }

    if profile_id == "general-object":
        model_family = "YOLO26" if "yolo26" in filename_lower else "YOLOv8"
        return {
            "class_scope": "fixed-coco",
            "class_scope_label": f"{class_count or 80} built-in object classes",
            "input_mode_label": "Fixed built-in object classes",
            "output_mode_label": "General object segmentation tests",
            "supports_text_prompt": False,
            "supports_mask_output": True,
            "recommended_user_level": "pro",
            "best_for": "Advanced compatibility checks and non-privacy object tests",
            "plain_english": (
                f"The current local {model_family} file is a fixed-class COCO model. "
                "It is useful for general segmentation tests, but it is not an open-text prompt detector."
            ),
        }

    return {
        "class_scope": "unknown",
        "class_scope_label": "Unknown class scope",
        "input_mode_label": "Unknown",
        "output_mode_label": "Unknown",
        "supports_text_prompt": False,
        "supports_mask_output": False,
        "recommended_user_level": "pro",
        "best_for": "Manual inspection required",
        "plain_english": "The app could not determine what this model is good at automatically.",
    }


def _describe_yolo_model(model_path: Path) -> Dict[str, Any]:
    class_names = _load_yolo_class_names(model_path)
    profile = _infer_yolo_model_profile(class_names, model_path.name)
    canonical_names = [_canonicalize_yolo_class_name(name) for name in class_names]
    preview = canonical_names[:8]
    capabilities = _build_yolo_capabilities(profile["id"], model_path.name, canonical_names)

    return {
        "name": model_path.name,
        "path": str(model_path.resolve()),
        "size_mb": round(model_path.stat().st_size / (1024 * 1024), 1),
        "format": model_path.suffix.lower().lstrip("."),
        "class_count": len(class_names),
        "classes_preview": preview,
        "profile": profile["id"],
        "profile_label": profile["label"],
        "recommended_for_censor": profile["recommended_for_censor"],
        "message": profile["message"],
        "capabilities": capabilities,
    }


def _list_yolo_model_files(directory: Path) -> List[Dict[str, Any]]:
    if not directory.exists():
        return []

    files = []
    for path in sorted(directory.glob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".onnx", ".pt", ".pth", ".safetensors"}:
            continue
        files.append(_describe_yolo_model(path))
    return files


def get_clip_local_model_path() -> Optional[str]:
    """Return the local FastEmbed-compatible CLIP model directory if present.

    Checks the canonical slug path first, then falls back to scanning
    subdirectories of the clip model dir for any ``model.onnx`` file
    (covers FastEmbed cache layout differences across versions).
    """
    clip_root = Path(get_clip_model_dir())

    # 1) Canonical slug path (most common)
    repo_slug = CLIP_MODEL_NAME.replace("/", "-").replace("\\", "-")
    candidate = clip_root / repo_slug
    if (candidate / "model.onnx").exists():
        return str(candidate.resolve())

    # 2) Scan one or two levels deep for model.onnx inside clip_root
    #    FastEmbed may use slightly different directory naming across versions.
    for depth_pattern in ("*/model.onnx", "*/*/model.onnx"):
        matches = sorted(clip_root.glob(depth_pattern))
        for match in matches:
            model_dir = match.parent
            # Skip obvious temp/cache directories
            if model_dir.name.startswith(".") or model_dir.name == "tmp":
                continue
            return str(model_dir.resolve())

    return None


def get_default_legacy_model_path() -> Optional[str]:
    """Return the best local legacy YOLO model path for censor detection."""
    yolo_root = Path(get_yolo_model_dir())
    preferred_names = [
        "wenaka_yolov8s-seg.onnx",
        "wenaka_yolov8s-seg.pt",
        "yolo26s-seg.onnx",
        "yolo26s-seg.pt",
        "yolov8s-seg.onnx",
        "yolov8s-seg.pt",
    ]

    for name in preferred_names:
        candidate = yolo_root / name
        if candidate.exists():
            return str(candidate.resolve())

    for suffix in (".onnx", ".pt", ".pth"):
        matches = sorted(path for path in yolo_root.glob(f"*{suffix}") if path.is_file())
        if matches:
            return str(matches[0].resolve())
    return None


def get_sam3_checkpoint_path() -> Optional[str]:
    """Return the directory containing a complete transformers SAM3 checkpoint.

    The transformers ``Sam3Model.from_pretrained`` loader needs a directory
    holding ``config.json`` + ``model.safetensors`` + tokenizer files, so
    this returns the directory path (not a single weight file path).
    """
    sam3_root = Path(get_sam3_model_dir())
    candidate_dirs = [
        sam3_root / "facebook-sam3-modelscope",
        sam3_root / "facebook-sam3",
        sam3_root,
    ]
    for candidate in candidate_dirs:
        if (candidate / "config.json").exists() and (candidate / "model.safetensors").exists():
            return str(candidate.resolve())
    return None


def _resolve_artist_runtime_path() -> Optional[str]:
    """Locate an LSNet runtime checkout on disk.

    Mirrors ``artist_identifier._resolve_lsnet_runtime_path`` so the
    ``/api/artists/diagnostics`` endpoint and the actual identifier agree
    on whether the runtime is available. Older installs commonly have the
    runtime under ``<repo>/models/artist/comfyui-lsnet-runtime/`` (legacy
    path); that location must be probed here too, otherwise the
    diagnostics permanently reports ``available: false`` even though the
    identifier loads and runs successfully.
    """
    candidates: List[Path] = []
    if ARTIST_LSNET_CODE_PATH:
        candidates.append(Path(ARTIST_LSNET_CODE_PATH).expanduser())

    artist_root = Path(get_artist_model_dir())
    project_root = Path(__file__).resolve().parent.parent
    candidates.extend(
        [
            artist_root / "comfyui-lsnet-runtime",
            artist_root / "comfyui-lsnet",
            artist_root / "lsnet-test",
            # Legacy paths (pre-data/models/ migration). Keep parity with
            # artist_identifier._resolve_lsnet_runtime_path so diagnostics
            # don't drift from runtime behaviour.
            project_root / "models" / "artist" / "comfyui-lsnet",
            project_root / "models" / "artist" / "lsnet-test",
            project_root / "models" / "artist" / "comfyui-lsnet-runtime",
            project_root / "third_party" / "comfyui-lsnet",
            project_root / "third_party" / "lsnet-test",
        ]
    )

    for candidate in candidates:
        resolved = candidate.resolve()
        if not resolved.exists():
            continue
        if (resolved / "lsnet_model").exists() or (resolved / "model").exists():
            return str(resolved)
    return None


def get_artist_checkpoint_path() -> Optional[str]:
    artist_root = Path(get_artist_model_dir())
    candidate = artist_root / "kaloscope2.0" / ARTIST_KALOSCOPE_CHECKPOINT
    if candidate.exists():
        return str(candidate.resolve())
    return None


def get_artist_class_mapping_path() -> Optional[str]:
    artist_root = Path(get_artist_model_dir())
    candidate = artist_root / "kaloscope2.0" / ARTIST_KALOSCOPE_CLASS_MAPPING
    if candidate.exists():
        return str(candidate.resolve())
    return None


def get_model_health() -> Dict[str, Any]:
    """Return a machine-readable summary of local model readiness."""
    clip_model_path = get_clip_local_model_path()
    default_tagger_dir = Path(get_wd14_model_dir()) / DEFAULT_TAGGER_MODEL
    default_tagger_model = default_tagger_dir / TAGGER_MODELS[DEFAULT_TAGGER_MODEL]["model_file"]
    default_tagger_tags = default_tagger_dir / TAGGER_MODELS[DEFAULT_TAGGER_MODEL]["tags_file"]
    toriigate_dir = Path(get_toriigate_model_dir()) / "toriigate-0.5"
    oppai_oracle_root = Path(get_oppai_oracle_model_dir()) / "oppai-oracle-v1.1" / "V1.1_onnx"
    oppai_oracle_model = oppai_oracle_root / "model.onnx"
    oppai_oracle_tags = oppai_oracle_root / "selected_tags.csv"
    legacy_model_path = get_default_legacy_model_path()
    nudenet_model = Path(get_nudenet_model_dir()) / "320n.onnx"
    sam3_checkpoint = get_sam3_checkpoint_path()
    artist_runtime_path = _resolve_artist_runtime_path()
    artist_checkpoint = get_artist_checkpoint_path()
    artist_class_mapping = get_artist_class_mapping_path()

    torch_state = _probe_torch_runtime()
    torch_version = torch_state.get("torch_version")
    torch_cuda_build = torch_state.get("torch_cuda_build")
    cuda_available = bool(torch_state.get("torch_cuda_available"))
    uses_cpu_only_torch = bool(torch_version) and torch_cuda_build is None

    sam3_supported = _sam3_supported_on_platform()
    sam3_missing = []
    if sam3_supported:
        for module_name, _package_name in SAM3_REQUIRED_MODULES:
            if module_name == "torch":
                if not torch_version and not _module_installed("torch"):
                    sam3_missing.append(module_name)
            elif not _module_installed(module_name):
                sam3_missing.append(module_name)
    sam3_missing_packages = _sam3_missing_dependency_packages(sam3_missing)

    artist_missing = []
    if not torch_version and not _module_installed("torch"):
        artist_missing.append("torch")
    if not _module_installed("timm"):
        artist_missing.append("timm")
    artist_triton_available = _module_installed("triton")
    artist_hf_available = _module_installed("huggingface_hub")
    artist_ms_available = _module_installed("modelscope")
    artist_has_any_source = True

    yolo_files = _list_yolo_model_files(Path(get_yolo_model_dir()))
    yolo_names = {file_info["name"].lower() for file_info in yolo_files}
    privacy_yolo_files = [file_info for file_info in yolo_files if file_info["recommended_for_censor"]]
    general_yolo_files = [file_info for file_info in yolo_files if not file_info["recommended_for_censor"]]

    if legacy_model_path and privacy_yolo_files:
        legacy_message = "Privacy-part YOLO model ready."
        if general_yolo_files:
            legacy_message += " Generic YOLO26/YOLOv8 files are also installed for compatibility tests, but they are not recommended for privacy censoring."
    elif legacy_model_path:
        legacy_message = "A local YOLO model is available, but it does not look like a privacy-part detector."
    else:
        legacy_message = "No legacy YOLO model found in models/yolo."

    health = {
        "wd14": {
            "default_model": DEFAULT_TAGGER_MODEL,
            "available": default_tagger_model.exists() and default_tagger_tags.exists(),
            "model_path": str(default_tagger_model.resolve()) if default_tagger_model.exists() else None,
            "tags_path": str(default_tagger_tags.resolve()) if default_tagger_tags.exists() else None,
            "installed_models": [
                {
                    "name": model_name,
                    "available": (
                        (Path(get_wd14_model_dir()) / model_name / config["model_file"]).exists()
                        and (Path(get_wd14_model_dir()) / model_name / config["tags_file"]).exists()
                    ),
                }
                for model_name, config in TAGGER_MODELS.items()
            ],
        },
        "toriigate": {
            "available": (
                (toriigate_dir / "config.json").exists()
                and (toriigate_dir / "model.safetensors").exists()
                and _module_installed("transformers")
                and (bool(torch_version) or _module_installed("torch"))
            ),
            "model_name": "toriigate-0.5",
            "model_dir": str(toriigate_dir.resolve()),
            "requires_gpu": True,
            "message": (
                "ToriiGate runtime files are ready."
                if (toriigate_dir / "config.json").exists() and (toriigate_dir / "model.safetensors").exists()
                else "ToriiGate files are not downloaded yet. The first run will need a large model download."
            ),
        },
        "oppai_oracle": {
            "available": oppai_oracle_model.exists() and oppai_oracle_tags.exists(),
            "model_name": "oppai-oracle-v1.1",
            "model_dir": str((Path(get_oppai_oracle_model_dir()) / "oppai-oracle-v1.1").resolve()),
            "model_path": str(oppai_oracle_model.resolve()) if oppai_oracle_model.exists() else None,
            "tags_path": str(oppai_oracle_tags.resolve()) if oppai_oracle_tags.exists() else None,
            "requires_gpu": False,
            "expected_size_mb": 947,
            "message": (
                "OppaiOracle V1.1 ONNX bundle is ready."
                if oppai_oracle_model.exists() and oppai_oracle_tags.exists()
                else "OppaiOracle V1.1 (~947 MB ONNX) is not downloaded yet."
            ),
        },
        "clip": {
            "available": bool(clip_model_path) and _module_installed("fastembed"),
            "model_downloaded": bool(clip_model_path),
            "runtime_available": _module_installed("fastembed"),
            "runtime_loaded": _clip_model_loaded(),
            "model_name": CLIP_MODEL_NAME,
            "model_path": clip_model_path,
            "expected_path": str(Path(get_clip_model_dir()) / CLIP_MODEL_NAME.replace("/", "-").replace("\\", "-")),
            "message": (
                "Local CLIP model ready."
                if clip_model_path and _module_installed("fastembed")
                else (
                    "CLIP model files are downloaded, but the FastEmbed runtime is missing."
                    if clip_model_path
                    else "Local CLIP model is missing. Similar search will need a first-run download."
                )
            ),
        },
        "censor": {
            "legacy": {
                "available": bool(legacy_model_path),
                "default_model_path": legacy_model_path,
                "expected_path": str(Path(get_yolo_model_dir())),
                "message": legacy_message,
                "files": yolo_files,
                "has_yolo26": any("yolo26" in name for name in yolo_names),
                "has_yolov8s": any("yolov8s" in name for name in yolo_names),
                "privacy_model_count": len(privacy_yolo_files),
                "general_model_count": len(general_yolo_files),
                "simple_user_advice": (
                    "Keep mode on Both and leave the model path blank. The app will pick the recommended privacy model automatically."
                    if privacy_yolo_files
                    else "Install a privacy-focused YOLO file or switch to NudeNet for the simple workflow."
                ),
                "advanced_user_advice": (
                    "The current local yolo26/yolov8 files are fixed-class models. They are useful for advanced compatibility tests, but not for free-text prompting."
                ),
            },
            "nudenet": {
                "available": _module_installed("nudenet"),
                "model_downloaded": nudenet_model.exists(),
                "model_path": str(nudenet_model.resolve()) if nudenet_model.exists() else None,
                "message": (
                    "NudeNet runtime is ready."
                    if _module_installed("nudenet") and nudenet_model.exists()
                    else (
                        "NudeNet runtime is installed. The detector can still prepare/download its model on first use."
                        if _module_installed("nudenet")
                        else "NudeNet runtime is not installed yet."
                    )
                ),
                "capabilities": {
                    "class_scope": "fixed-nudenet",
                    "class_scope_label": "Built-in NSFW body-part classes",
                    "input_mode_label": "No manual prompt input",
                    "output_mode_label": "Detection boxes",
                    "supports_text_prompt": False,
                    "supports_mask_output": False,
                    "recommended_user_level": "normal",
                    "best_for": "Fast NSFW region detection",
                    "plain_english": "Good default when you want the app to detect exposed and covered NSFW regions without setting up extra prompts.",
                },
            },
            "sam3": {
                "available": sam3_supported and bool(sam3_checkpoint) and not sam3_missing and cuda_available,
                "checkpoint_path": sam3_checkpoint,
                "expected_path": str(Path(get_sam3_model_dir())),
                "missing_dependencies": sam3_missing,
                "missing_dependency_packages": sam3_missing_packages,
                "cuda_available": cuda_available,
                "torch_version": torch_version,
                "torch_cuda_build": torch_cuda_build,
                "torch_probe_error": torch_state.get("torch_probe_error"),
                "torch_probe_source": torch_state.get("torch_probe_source"),
                "message": _format_sam3_readiness_message(
                    checkpoint_path=sam3_checkpoint,
                    missing_packages=sam3_missing_packages,
                    cuda_available=cuda_available,
                    uses_cpu_only_torch=uses_cpu_only_torch,
                    supported_on_platform=sam3_supported,
                ),
                "runtime_note": (
                    "SAM3 is currently only prepared on Windows/Linux CUDA environments."
                    if not sam3_supported
                    else (
                        "SAM3 runs inside this app's own Python environment, so its GPU readiness depends on the Torch build installed here."
                        if sam3_checkpoint or sam3_missing_packages
                        else None
                    )
                ),
                "capabilities": {
                    "class_scope": "open-text",
                    "class_scope_label": "Prompt-guided segmentation",
                    "input_mode_label": "Text prompt or box prompt",
                    "output_mode_label": "Pixel-accurate masks",
                    "supports_text_prompt": True,
                    "supports_mask_output": True,
                    "recommended_user_level": "pro",
                    "best_for": "Precise mask refinement and advanced text-guided segmentation",
                    "plain_english": "This is the precise tool for pro users. It can refine a box or follow a text prompt, but the current runtime is GPU-only.",
                },
            },
        },
        "artist": {
            "available": bool(artist_runtime_path and artist_checkpoint and artist_class_mapping and not artist_missing),
            "model_name": ARTIST_HF_MODEL_ID,
            "runtime_path": artist_runtime_path,
            "checkpoint_path": artist_checkpoint,
            "expected_path": str(Path(get_artist_model_dir())),
            "class_mapping_path": artist_class_mapping,
            "missing_dependencies": artist_missing,
            "huggingface_available": artist_hf_available,
            "modelscope_available": artist_ms_available,
            "has_download_source": artist_has_any_source,
            "runtime_note": (
                (
                    "triton is not installed. The LSNet runtime may fall back to PyTorchSkaFn (slower but functional). "
                    "Install triton-windows to use the optimized kernel."
                )
                if platform.system() == "Windows" and not artist_triton_available
                else (
                    "On Windows, comfyui-lsnet may log 'SkaFn failed; falling back to PyTorchSkaFn'. That fallback is usually okay if artist predictions still appear."
                    if platform.system() == "Windows"
                    else None
                )
            ),
            "message": (
                "Kaloscope runtime is ready."
                if artist_runtime_path and artist_checkpoint and artist_class_mapping and not artist_missing
                else (
                    "Kaloscope checkpoint files are missing. "
                    + (
                        "Use Prepare / Download to fetch them."
                    )
                    if not artist_checkpoint
                    else "Artist identification still needs the LSNet runtime or Python dependencies."
                )
            ),
        },
    }
    return health


def format_model_health_report(health: Optional[Dict[str, Any]] = None) -> str:
    """Format a plain-text report suitable for startup scripts."""
    health = health or get_model_health()
    lines = ["Model Readiness"]

    wd14 = health["wd14"]
    lines.append(
        f"[{'OK' if wd14['available'] else 'WARN'}] WD14 default ({wd14['default_model']}): "
        f"{'ready' if wd14['available'] else 'missing files'}"
    )

    toriigate = health["toriigate"]
    lines.append(
        f"[{'OK' if toriigate['available'] else 'WARN'}] ToriiGate: {toriigate['message']}"
    )

    clip = health["clip"]
    lines.append(
        f"[{'OK' if clip['available'] else 'WARN'}] CLIP similarity: {clip['message']}"
    )

    legacy = health["censor"]["legacy"]
    lines.append(
        f"[{'OK' if legacy['available'] else 'WARN'}] Legacy YOLO: {legacy['message']}"
    )
    if legacy["available"] and legacy["default_model_path"]:
        lines.append(f"      Default: {legacy['default_model_path']}")
    if legacy.get("privacy_model_count") or legacy.get("general_model_count"):
        lines.append(
            f"      Installed files: {legacy.get('privacy_model_count', 0)} privacy-focused, {legacy.get('general_model_count', 0)} general-purpose"
        )

    nudenet = health["censor"]["nudenet"]
    lines.append(
        f"[{'OK' if nudenet['available'] else 'WARN'}] NudeNet: {nudenet['message']}"
    )

    sam3 = health["censor"]["sam3"]
    lines.append(
        f"[{'OK' if sam3['available'] else 'WARN'}] SAM3: {sam3['message']}"
    )
    if sam3["missing_dependencies"]:
        lines.append(f"      Missing: {', '.join(sam3['missing_dependencies'])}")

    artist = health["artist"]
    lines.append(
        f"[{'OK' if artist['available'] else 'WARN'}] Artist/Kaloscope: {artist['message']}"
    )
    if artist["missing_dependencies"]:
        lines.append(f"      Missing: {', '.join(artist['missing_dependencies'])}")
    if artist["runtime_path"]:
        lines.append(f"      Runtime: {artist['runtime_path']}")

    return "\n".join(lines)


def get_startup_readiness(
    health: Optional[Dict[str, Any]] = None,
    system_info: Optional[Dict[str, Any]] = None,
    recommendation: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a user-facing startup readiness summary for launchers."""
    health = health or get_model_health()
    system_info = system_info or get_system_info()
    recommendation = recommendation or recommend_tagger_config(system_info)

    providers = [str(provider) for provider in (system_info.get("onnx_providers") or [])]
    gpu_name = system_info.get("gpu_name")
    ram_gb = system_info.get("total_ram_gb")
    vram_mb = system_info.get("gpu_vram_total_mb")
    recommended_chunk = int(recommendation.get("recommended_batch_size") or 8)
    recommended_gpu = bool(recommendation.get("recommended_use_gpu"))

    wd14 = health["wd14"]
    clip = health["clip"]
    legacy = health["censor"]["legacy"]
    nudenet = health["censor"]["nudenet"]
    artist = health["artist"]
    sam3 = health["censor"]["sam3"]

    hardware_parts = []
    if gpu_name:
        hardware_parts.append(gpu_name)
    if ram_gb:
        hardware_parts.append(f"{ram_gb:.0f}GB RAM")
    if vram_mb:
        hardware_parts.append(f"{vram_mb / 1024:.1f}GB VRAM")

    provider_parts = []
    if "TensorrtExecutionProvider" in providers:
        provider_parts.append("TensorRT")
    if "CUDAExecutionProvider" in providers:
        provider_parts.append("CUDA")
    if "DmlExecutionProvider" in providers:
        provider_parts.append("DirectML")
    if system_info.get("torch_cuda_available"):
        provider_parts.append("PyTorch CUDA")
    if "CPUExecutionProvider" in providers:
        provider_parts.append("CPU")

    if wd14["available"]:
        if recommended_gpu:
            tagger_status = {
                "level": "ready",
                "headline": "WD14 tagging: GPU ready",
                "detail": f"Recommended GPU mode is available. Suggested chunk size: {recommended_chunk}.",
            }
        else:
            tagger_status = {
                "level": "warn",
                "headline": "WD14 tagging: CPU fallback",
                "detail": recommendation.get("message") or "GPU runtime is not ready, so tagging will stay on CPU.",
            }
    else:
        tagger_status = {
            "level": "warn",
            "headline": "WD14 tagging: model files missing",
            "detail": "The default WD14 files are not ready yet.",
        }

    if clip["available"]:
        similarity_status = {
            "level": "ready",
            "headline": "Similar search: ready",
            "detail": "Local CLIP model and runtime are available.",
        }
    else:
        similarity_status = {
            "level": "warn",
            "headline": "Similar search: setup needed",
            "detail": clip["message"],
        }

    if legacy["available"] or nudenet["available"]:
        detail_parts = []
        if legacy["available"]:
            detail_parts.append("Privacy YOLO ready")
        if nudenet["available"]:
            detail_parts.append("NudeNet ready")
        censor_status = {
            "level": "ready",
            "headline": "Censor tools: ready",
            "detail": " · ".join(detail_parts),
        }
    else:
        censor_status = {
            "level": "warn",
            "headline": "Censor tools: partial",
            "detail": "Neither Privacy YOLO nor NudeNet is ready yet.",
        }

    artist_status = {
        "level": "ready" if artist["available"] else "warn",
        "headline": "Artist ID: ready" if artist["available"] else "Artist ID: setup needed",
        "detail": artist["message"],
    }

    sam3_status = {
        "level": "ready" if sam3["available"] else "warn",
        "headline": "SAM3 Pro masks: ready" if sam3["available"] else "SAM3 Pro masks: setup needed",
        "detail": sam3["message"],
    }

    return {
        "hardware": {
            "summary": " · ".join(hardware_parts) if hardware_parts else "No dedicated GPU detected",
            "providers": provider_parts,
            "onnxruntime_conflict": bool(system_info.get("onnxruntime_conflict")),
            "recommendation_message": recommendation.get("message") or "",
        },
        "features": {
            "tagger": tagger_status,
            "similarity": similarity_status,
            "censor": censor_status,
            "artist": artist_status,
            "sam3": sam3_status,
        },
    }


def format_startup_readiness_report(
    readiness: Optional[Dict[str, Any]] = None,
    health: Optional[Dict[str, Any]] = None,
    system_info: Optional[Dict[str, Any]] = None,
    recommendation: Optional[Dict[str, Any]] = None,
) -> str:
    """Format a concise launcher-friendly startup report."""
    readiness = readiness or get_startup_readiness(
        health=health,
        system_info=system_info,
        recommendation=recommendation,
    )

    hardware = readiness["hardware"]
    features = readiness["features"]
    lines = ["Startup Readiness"]
    lines.append(f"Hardware: {hardware['summary']}")
    if hardware.get("providers"):
        lines.append("Providers: " + ", ".join(hardware["providers"]))
    if hardware.get("onnxruntime_conflict"):
        lines.append("[WARN] ONNX Runtime packages are conflicting. The launcher should repair this automatically.")

    for feature_key in ("tagger", "similarity", "censor", "artist", "sam3"):
        feature = features[feature_key]
        marker = "OK" if feature["level"] == "ready" else "WARN"
        lines.append(f"[{marker}] {feature['headline']}")
        if feature.get("detail"):
            lines.append(f"      {feature['detail']}")

    if hardware.get("recommendation_message"):
        lines.append("Runtime note: " + hardware["recommendation_message"])

    return "\n".join(lines)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Print SD Image Sorter model readiness")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    parser.add_argument("--startup", action="store_true", help="Print launcher-friendly startup readiness summary")
    args = parser.parse_args()

    health = get_model_health()
    if args.startup:
        readiness = get_startup_readiness(health=health)
        if args.json:
            print(json.dumps(readiness, indent=2, ensure_ascii=False))
        else:
            print(format_startup_readiness_report(readiness=readiness))
    elif args.json:
        print(json.dumps(health, indent=2, ensure_ascii=False))
    else:
        print(format_model_health_report(health))
