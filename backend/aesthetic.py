"""
LAION Aesthetic Predictor integration.

Uses CLIP ViT-L/14 embeddings + a tiny linear head trained on human aesthetic ratings.
Outputs a score from ~1 to ~10. Model downloads automatically on first use (~400MB).
"""
import os
import logging
import threading
from typing import Optional
from pathlib import Path

from ai_runtime_guard import (
    clear_torch_cuda_cache,
    cuda_has_headroom,
    exclusive_ai_runtime,
    looks_like_cuda_oom,
)

logger = logging.getLogger(__name__)

_predictor = None
_clip_model = None
_clip_preprocess = None
_device = None
_load_lock = threading.Lock()
_inference_lock = threading.Lock()
_force_cpu_after_gpu_failure = False

_MIN_AESTHETIC_CUDA_FREE_MB = 3800


def _get_models_dir() -> Path:
    models_dir = Path(__file__).parent.parent / "models" / "aesthetic"
    models_dir.mkdir(parents=True, exist_ok=True)
    return models_dir


def _get_torch_module():
    import torch

    return torch


def _cuda_has_headroom(torch_module, min_free_mb: int = _MIN_AESTHETIC_CUDA_FREE_MB) -> bool:
    return cuda_has_headroom(torch_module, min_free_mb=min_free_mb)


def _select_device(*, use_gpu: bool = True) -> str:
    global _force_cpu_after_gpu_failure

    if not use_gpu or _force_cpu_after_gpu_failure:
        return "cpu"

    torch = _get_torch_module()
    if not torch.cuda.is_available():
        return "cpu"
    if not _cuda_has_headroom(torch, _MIN_AESTHETIC_CUDA_FREE_MB):
        logger.warning(
            "Aesthetic predictor skipped GPU because free VRAM is below %d MB. Using CPU Safe Mode.",
            _MIN_AESTHETIC_CUDA_FREE_MB,
        )
        return "cpu"
    return "cuda"


def _is_cuda_oom(exc: BaseException) -> bool:
    return looks_like_cuda_oom(exc)


def _unload_models() -> None:
    global _predictor, _clip_model, _clip_preprocess, _device

    _predictor = None
    _clip_model = None
    _clip_preprocess = None
    previous_device = _device
    _device = None
    try:
        if previous_device == "cuda":
            clear_torch_cuda_cache()
    except Exception:
        logger.debug("Aesthetic model cache clear failed", exc_info=True)


def _ensure_loaded(device: Optional[str] = None):
    """Lazy-load CLIP + aesthetic head on first call."""
    global _predictor, _clip_model, _clip_preprocess, _device

    target_device = device or _select_device(use_gpu=True)
    if _predictor is not None and _device == target_device:
        return

    with _load_lock:
        if _predictor is not None and _device == target_device:
            return

        if _predictor is not None and _device != target_device:
            _unload_models()
        _load_predictor(target_device)


def _load_predictor(device: Optional[str] = None):
    """Load CLIP + aesthetic head under the singleton load lock."""
    global _predictor, _clip_model, _clip_preprocess, _device

    try:
        torch = _get_torch_module()
        import torch.nn as nn

        _device = device or _select_device(use_gpu=True)
        logger.info(f"Loading aesthetic predictor on {_device}")

        # Load CLIP
        try:
            import open_clip
            model, _, preprocess = open_clip.create_model_and_transforms(
                "ViT-L-14", pretrained="openai", device=_device
            )
            model.eval()
            _clip_model = model
            _clip_preprocess = preprocess
        except ImportError:
            import clip
            model, preprocess = clip.load("ViT-L/14", device=_device)
            model.eval()
            _clip_model = model
            _clip_preprocess = preprocess

        # Download and load aesthetic linear head
        weights_path = _get_models_dir() / "sa_0_4_vit_l_14_linear.pth"
        if not weights_path.exists():
            logger.info("Downloading aesthetic predictor weights...")
            import urllib.request
            url = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_l_14_linear.pth"
            urllib.request.urlretrieve(url, str(weights_path))
            logger.info("Download complete")

        # LAION's published predictor is a simple linear estimator on top of
        # normalized CLIP embeddings, not a deep MLP.
        head = nn.Linear(768, 1)
        state = torch.load(str(weights_path), map_location=_device, weights_only=True)
        head.load_state_dict(state)
        head.to(_device)
        head.eval()
        _predictor = head
        logger.info("Aesthetic predictor loaded successfully")

    except Exception as e:
        logger.error(f"Failed to load aesthetic predictor: {e}")
        _unload_models()
        raise


def _predict_score_loaded(image_path: str) -> float:
    torch = _get_torch_module()
    from PIL import Image

    assert _clip_preprocess is not None
    assert _clip_model is not None
    assert _predictor is not None

    with Image.open(image_path) as img:
        img_tensor = _clip_preprocess(img.convert("RGB")).unsqueeze(0).to(_device)

    with torch.no_grad():
        features = _clip_model.encode_image(img_tensor)
        features = features / features.norm(dim=-1, keepdim=True)
        score = _predictor(features.float())

    result = round(float(score.item()), 4)
    del img_tensor, features, score
    return result


def predict_score(image_path: str) -> Optional[float]:
    """Predict aesthetic score for a single image. Returns float ~1-10 or None on error."""
    global _force_cpu_after_gpu_failure

    try:
        with exclusive_ai_runtime("aesthetic"), _inference_lock:
            _ensure_loaded()
            try:
                return _predict_score_loaded(image_path)
            except Exception as exc:
                if _device != "cuda" or not _is_cuda_oom(exc):
                    raise
                logger.warning(
                    "Aesthetic GPU inference ran out of memory. Unloading GPU model and retrying once on CPU Safe Mode: %s",
                    exc,
                )
                _force_cpu_after_gpu_failure = True
                _unload_models()
                _ensure_loaded("cpu")
                return _predict_score_loaded(image_path)

    except Exception as e:
        logger.error(f"Aesthetic prediction failed for {image_path}: {e}")
        return None


def is_available() -> bool:
    """Check if the required dependencies are installed."""
    try:
        import torch
        try:
            import open_clip
        except ImportError:
            try:
                import clip
            except ImportError:
                return False
        return True
    except ImportError:
        return False
