"""
SAM3 mask refinement for precise censoring.

This module wraps the real SAM3 API exposed by the `sam3` Python package.
It supports:
- refining existing bounding boxes into pixel masks
- text-prompt segmentation
- local checkpoint discovery under models/sam3
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from PIL import Image

from config import get_sam3_model_dir


logger = logging.getLogger(__name__)


_sam3_model = None
_sam3_processor = None
_sam3_device = None
_sam3_lock = threading.Lock()
_sam3_available = None


def _check_sam3_available() -> bool:
    """Check whether the SAM3 runtime package can be imported."""
    global _sam3_available
    if _sam3_available is None:
        try:
            import torch
            from sam3 import build_sam3_image_model  # noqa: F401
            from sam3.model.sam3_image_processor import Sam3Processor  # noqa: F401
            _sam3_available = bool(torch.cuda.is_available())
            if not _sam3_available:
                logger.warning("SAM3 runtime is installed, but CUDA is not available in this environment.")
        except ImportError as exc:
            _sam3_available = False
            logger.warning("SAM3 runtime is unavailable: %s", exc)
    return bool(_sam3_available)


def _resolve_checkpoint_path(checkpoint_path: Optional[str] = None) -> Optional[str]:
    if checkpoint_path and os.path.exists(checkpoint_path):
        return checkpoint_path

    sam3_dir = Path(get_sam3_model_dir())
    candidates = [
        sam3_dir / "facebook-sam3-modelscope" / "sam3.pt",
        sam3_dir / "facebook-sam3-modelscope" / "model.safetensors",
        sam3_dir / "facebook-sam3" / "sam3.pt",
        sam3_dir / "facebook-sam3" / "model.safetensors",
        sam3_dir / "sam3.pt",
        sam3_dir / "model.safetensors",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate.resolve())
    return None


def _load_from_modelscope(device: str):
    """Download a SAM3 checkpoint from ModelScope if needed."""
    try:
        from modelscope import snapshot_download  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "ModelScope SDK is not installed. Install `modelscope` or place a local SAM3 checkpoint in models/sam3."
        ) from exc

    from sam3 import build_sam3_image_model  # type: ignore

    logger.info("Downloading SAM3 from ModelScope...")
    cache_dir = Path(get_sam3_model_dir()) / "facebook-sam3-modelscope"
    cache_dir.mkdir(parents=True, exist_ok=True)
    model_dir = snapshot_download("facebook/sam3", cache_dir=str(cache_dir))

    checkpoint = None
    for path in Path(model_dir).rglob("*"):
        if path.suffix.lower() in {".pt", ".pth", ".bin", ".safetensors"}:
            checkpoint = str(path.resolve())
            break

    if not checkpoint:
        raise RuntimeError("ModelScope download finished, but no SAM3 checkpoint file was found.")

    return build_sam3_image_model(
        checkpoint_path=checkpoint,
        load_from_HF=False,
        device=device,
        eval_mode=True,
    )


def _load_sam3(checkpoint_path: Optional[str] = None, source: str = "huggingface"):
    """Load the SAM3 model and processor once."""
    global _sam3_model, _sam3_processor, _sam3_device

    if _sam3_model is None:
        with _sam3_lock:
            if _sam3_model is None:
                if not _check_sam3_available():
                    raise RuntimeError(
                        "SAM3 runtime is not installed correctly. Install the sam3 package and its runtime dependencies first."
                    )

                from sam3 import build_sam3_image_model  # type: ignore
                from sam3.model.sam3_image_processor import Sam3Processor  # type: ignore
                import torch

                device = "cuda" if torch.cuda.is_available() else "cpu"
                resolved_checkpoint = _resolve_checkpoint_path(checkpoint_path)

                logger.info("Loading SAM3 on %s", device)
                if resolved_checkpoint:
                    logger.info("Using local SAM3 checkpoint: %s", resolved_checkpoint)
                    model = build_sam3_image_model(
                        checkpoint_path=resolved_checkpoint,
                        load_from_HF=False,
                        device=device,
                        eval_mode=True,
                    )
                elif source == "modelscope":
                    model = _load_from_modelscope(device=device)
                else:
                    try:
                        model = build_sam3_image_model(
                            device=device,
                            eval_mode=True,
                            load_from_HF=True,
                        )
                    except Exception as hf_error:
                        message = str(hf_error).lower()
                        if any(token in message for token in ("auth", "token", "403", "401")):
                            logger.warning("SAM3 HuggingFace access failed, falling back to ModelScope.")
                            model = _load_from_modelscope(device=device)
                        else:
                            raise

                model = model.to(device)
                model.eval()

                _sam3_model = model
                _sam3_processor = Sam3Processor(model, device=device)
                _sam3_device = device

    return _sam3_model, _sam3_processor


def _normalize_prompt_box(box: List[int], width: int, height: int) -> Optional[List[float]]:
    if len(box) != 4 or width <= 0 or height <= 0:
        return None

    x1, y1, x2, y2 = [float(v) for v in box]
    x1 = max(0.0, min(width, x1))
    y1 = max(0.0, min(height, y1))
    x2 = max(0.0, min(width, x2))
    y2 = max(0.0, min(height, y2))
    if x2 <= x1 or y2 <= y1:
        return None

    center_x = ((x1 + x2) / 2.0) / width
    center_y = ((y1 + y2) / 2.0) / height
    box_width = (x2 - x1) / width
    box_height = (y2 - y1) / height
    return [center_x, center_y, box_width, box_height]


def _tensor_to_numpy(value):
    if value is None:
        return None
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.asarray(value)


def _extract_best_mask(state: Dict) -> Optional[np.ndarray]:
    masks = _tensor_to_numpy(state.get("masks"))
    scores = _tensor_to_numpy(state.get("scores"))
    if masks is None or masks.size == 0:
        return None

    if masks.ndim == 4:
        masks = masks[:, 0, :, :]
    elif masks.ndim == 2:
        masks = masks[np.newaxis, ...]

    best_idx = 0
    if scores is not None and scores.size > 0:
        best_idx = int(np.argmax(scores))

    mask = masks[best_idx]
    return mask.astype(np.uint8)


class SAM3Refiner:
    """Refine detection boxes into SAM3 masks."""

    def __init__(self, checkpoint_path: Optional[str] = None, source: str = "huggingface"):
        self.checkpoint_path = checkpoint_path
        self.source = source
        self._model = None
        self._processor = None

    @staticmethod
    def is_available() -> bool:
        return _check_sam3_available()

    def load(self):
        self._model, self._processor = _load_sam3(self.checkpoint_path, source=self.source)

    @property
    def processor(self):
        if self._processor is None:
            self.load()
        return self._processor

    def refine_box(
        self,
        image: Image.Image,
        box: List[int],
        text_prompt: Optional[str] = None,
    ) -> Optional[np.ndarray]:
        try:
            prompt_box = _normalize_prompt_box(box, image.width, image.height)
            if prompt_box is None:
                return None

            state = self.processor.set_image(image.convert("RGB"))
            if text_prompt:
                state = self.processor.set_text_prompt(text_prompt, state)
            state = self.processor.add_geometric_prompt(prompt_box, True, state)
            return _extract_best_mask(state)
        except Exception as exc:
            logger.error("SAM3 box refinement failed: %s", exc)
            return None

    def refine_boxes(self, image: Image.Image, detections: List[Dict]) -> List[Dict]:
        import copy

        refined = []
        for det in detections:
            refined_det = copy.deepcopy(det)
            box = det.get("box", [])
            cls_name = det.get("class", "")
            mask = self.refine_box(image, box, text_prompt=cls_name if cls_name else None)
            refined_det["mask"] = mask if mask is not None else refined_det.get("mask")
            refined_det["mask_refined"] = mask is not None
            refined.append(refined_det)
        return refined

    def segment_by_text(self, image: Image.Image, text_prompt: str) -> Optional[np.ndarray]:
        try:
            state = self.processor.set_image(image.convert("RGB"))
            state = self.processor.set_text_prompt(text_prompt, state)
            return _extract_best_mask(state)
        except Exception as exc:
            logger.error("SAM3 text segmentation failed: %s", exc)
            return None


_sam3_refiner = None


def get_sam3_refiner(checkpoint_path: Optional[str] = None, source: str = "huggingface") -> SAM3Refiner:
    global _sam3_refiner
    if _sam3_refiner is None:
        _sam3_refiner = SAM3Refiner(checkpoint_path=checkpoint_path, source=source)
    return _sam3_refiner
