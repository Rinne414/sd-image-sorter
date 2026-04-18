"""
LAION Aesthetic Predictor integration.

Uses CLIP ViT-L/14 embeddings + a tiny linear head trained on human aesthetic ratings.
Outputs a score from ~1 to ~10. Model downloads automatically on first use (~400MB).
"""
import os
import logging
from typing import Optional
from pathlib import Path

logger = logging.getLogger(__name__)

_predictor = None
_clip_model = None
_clip_preprocess = None
_device = None


def _get_models_dir() -> Path:
    models_dir = Path(__file__).parent.parent / "models" / "aesthetic"
    models_dir.mkdir(parents=True, exist_ok=True)
    return models_dir


def _ensure_loaded():
    """Lazy-load CLIP + aesthetic head on first call."""
    global _predictor, _clip_model, _clip_preprocess, _device

    if _predictor is not None:
        return

    try:
        import torch
        import torch.nn as nn

        _device = "cuda" if torch.cuda.is_available() else "cpu"
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
        raise


def predict_score(image_path: str) -> Optional[float]:
    """Predict aesthetic score for a single image. Returns float ~1-10 or None on error."""
    try:
        _ensure_loaded()

        import torch
        from PIL import Image

        img = Image.open(image_path).convert("RGB")
        img_tensor = _clip_preprocess(img).unsqueeze(0).to(_device)

        with torch.no_grad():
            # Get CLIP image embedding
            try:
                import open_clip
                features = _clip_model.encode_image(img_tensor)
            except ImportError:
                features = _clip_model.encode_image(img_tensor)

            # Normalize
            features = features / features.norm(dim=-1, keepdim=True)
            # Predict aesthetic score
            score = _predictor(features.float())

        return round(float(score.item()), 4)

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
