"""
Unified model discovery and readiness helpers for SD Image Sorter.

This module keeps model path detection in one place so the backend, startup
scripts, and frontend diagnostics can all report the same truth.
"""
from __future__ import annotations

import ast
import importlib
import json
import os
import platform
import warnings
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

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
    get_sam3_model_dir,
    get_wd14_model_dir,
    get_yolo_model_dir,
)


def _module_available(module_name: str) -> bool:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            importlib.import_module(module_name)
        return True
    except Exception:
        return False


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


def _canonicalize_yolo_class_name(class_name: str) -> str:
    normalized = str(class_name or "").strip().lower().replace("_", " ").replace("-", " ")
    collapsed = normalized.replace(" ", "")
    aliases = {
        "breast": "breasts",
        "breasts": "breasts",
        "boob": "breasts",
        "boobs": "breasts",
        "tits": "breasts",
        "tit": "breasts",
        "vagina": "pussy",
        "vulva": "pussy",
        "pussy": "pussy",
        "labia": "pussy",
        "penis": "dick",
        "dick": "dick",
        "cock": "dick",
        "cum": "cum",
        "semen": "cum",
        "anus": "anus",
        "butthole": "anus",
    }
    return aliases.get(collapsed, normalized)


def _parse_class_mapping(raw_names: Any) -> List[str]:
    if isinstance(raw_names, str):
        raw_names = ast.literal_eval(raw_names)
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
            import onnxruntime as ort

            session = ort.InferenceSession(str(candidate), providers=["CPUExecutionProvider"])
            metadata = session.get_modelmeta().custom_metadata_map or {}
            raw_names = metadata.get("names")
            if not raw_names:
                continue
            return _parse_class_mapping(raw_names)
        except Exception:
            continue

    if model_path.suffix.lower() in {".pt", ".pth"} and _module_available("ultralytics"):
        try:
            from ultralytics import YOLO

            return _parse_class_mapping(getattr(YOLO(str(model_path)), "names", {}))
        except Exception:
            return []

    return []


def _infer_yolo_model_profile(class_names: List[str], filename: str) -> Dict[str, Any]:
    canonical = [_canonicalize_yolo_class_name(name) for name in class_names]
    canonical_set = {name.replace(" ", "") for name in canonical}
    privacy_keywords = {"anus", "cum", "dick", "breasts", "pussy"}

    if privacy_keywords.intersection(canonical_set):
        return {
            "id": "privacy-censor",
            "label": "Privacy-part detector",
            "recommended_for_censor": True,
            "message": "Specialized for privacy-part detection and censor workflows.",
        }

    filename_lower = filename.lower()
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

    if profile_id == "privacy-censor":
        return {
            "class_scope": "fixed-privacy",
            "class_scope_label": f"{class_count or 5} built-in privacy classes",
            "input_mode_label": "Fixed privacy-part labels",
            "output_mode_label": "Fast box-first censoring",
            "supports_text_prompt": False,
            "supports_mask_output": False,
            "recommended_user_level": "normal",
            "best_for": "Quick privacy-part censoring",
            "plain_english": (
                "Best for normal users who want quick privacy-part auto-detection. "
                "This route does not understand arbitrary text prompts."
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
    """Return the local FastEmbed-compatible CLIP model directory if present."""
    clip_root = Path(get_clip_model_dir())
    repo_slug = CLIP_MODEL_NAME.replace("/", "-").replace("\\", "-")
    candidate = clip_root / repo_slug
    if (candidate / "model.onnx").exists():
        return str(candidate.resolve())
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
    sam3_root = Path(get_sam3_model_dir())
    candidates = [
        sam3_root / "facebook-sam3-modelscope" / "sam3.pt",
        sam3_root / "facebook-sam3-modelscope" / "model.safetensors",
        sam3_root / "facebook-sam3" / "sam3.pt",
        sam3_root / "facebook-sam3" / "model.safetensors",
        sam3_root / "sam3.pt",
        sam3_root / "model.safetensors",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate.resolve())
    return None


def _resolve_artist_runtime_path() -> Optional[str]:
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
    legacy_model_path = get_default_legacy_model_path()
    nudenet_model = Path(get_nudenet_model_dir()) / "320n.onnx"
    sam3_checkpoint = get_sam3_checkpoint_path()
    artist_runtime_path = _resolve_artist_runtime_path()
    artist_checkpoint = get_artist_checkpoint_path()
    artist_class_mapping = get_artist_class_mapping_path()

    sam3_missing = [
        module_name
        for module_name in ("sam3", "einops", "hydra", "omegaconf", "pycocotools", "cv2")
        if not _module_available(module_name)
    ]
    cuda_available = False
    try:
        import torch

        cuda_available = bool(torch.cuda.is_available())
    except Exception:
        cuda_available = False

    artist_missing = [
        module_name
        for module_name in ("torch", "timm")
        if not _module_available(module_name)
    ]
    if platform.system() == "Windows" and not _module_available("triton"):
        artist_missing.append("triton")

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
        "clip": {
            "available": bool(clip_model_path),
            "model_name": CLIP_MODEL_NAME,
            "model_path": clip_model_path,
            "message": (
                "Local CLIP model ready."
                if clip_model_path
                else "Local CLIP model is missing. Similar search will need a first-run download."
            ),
        },
        "censor": {
            "legacy": {
                "available": bool(legacy_model_path),
                "default_model_path": legacy_model_path,
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
                "available": nudenet_model.exists() and _module_available("nudenet"),
                "model_path": str(nudenet_model.resolve()) if nudenet_model.exists() else None,
                "message": (
                    "NudeNet model ready."
                    if nudenet_model.exists()
                    else "NudeNet local model file is missing."
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
                "available": bool(sam3_checkpoint) and not sam3_missing and cuda_available,
                "checkpoint_path": sam3_checkpoint,
                "missing_dependencies": sam3_missing,
                "cuda_available": cuda_available,
                "message": (
                    "SAM3 checkpoint and runtime dependencies are ready."
                    if sam3_checkpoint and not sam3_missing and cuda_available
                    else (
                        "SAM3 files are installed, but this environment has no CUDA GPU. The current SAM3 runtime is GPU-only."
                        if sam3_checkpoint and not sam3_missing and not cuda_available
                        else "SAM3 still needs a checkpoint or runtime dependencies."
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
            "class_mapping_path": artist_class_mapping,
            "missing_dependencies": artist_missing,
            "runtime_note": (
                "On Windows, comfyui-lsnet may log 'SkaFn failed; falling back to PyTorchSkaFn'. That fallback is usually okay if artist predictions still appear."
                if platform.system() == "Windows"
                else None
            ),
            "message": (
                "Kaloscope runtime is ready."
                if artist_runtime_path and artist_checkpoint and artist_class_mapping and not artist_missing
                else "Artist identification still needs the LSNet runtime, Kaloscope files, or Python dependencies."
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


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Print SD Image Sorter model readiness")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = parser.parse_args()

    health = get_model_health()
    if args.json:
        print(json.dumps(health, indent=2, ensure_ascii=False))
    else:
        print(format_model_health_report(health))
