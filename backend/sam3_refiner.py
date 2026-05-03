"""
SAM3 mask refinement for precise censoring.

This module wraps the real SAM3 API exposed by the `sam3` Python package.
It supports:
- refining existing bounding boxes into pixel masks
- text-prompt segmentation
- local checkpoint discovery under models/sam3
"""
from __future__ import annotations

import contextlib
import logging
import os
import shutil
import threading
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from PIL import Image

from config import get_sam3_model_dir
from ai_runtime_guard import exclusive_ai_runtime


logger = logging.getLogger(__name__)


_sam3_model = None
_sam3_processor = None
_sam3_device = None
_sam3_lock = threading.Lock()
_sam3_available = None
_sam3_text_assets_provisioned = False


def _ensure_sam3_text_assets() -> None:
    """Provision the BPE vocab asset SAM3's tokenizer expects.

    SAM3 0.1.3's ``model_builder.py`` hard-codes its tokenizer to load
    ``<sam3>/../assets/bpe_simple_vocab_16e6.txt.gz`` (i.e. a top-level
    ``assets/`` directory in site-packages), but the published wheel
    doesn't ship that file. Without it, ``segment-by-text`` crashes with
    ``[Errno 2] No such file or directory: ...assets/bpe_simple_vocab_16e6.txt.gz``.

    ``open-clip-torch`` is already a dependency and bundles the identical
    file at ``open_clip/bpe_simple_vocab_16e6.txt.gz``. Copy it once so
    text segmentation works. Idempotent — skips when target already
    exists; tolerant of missing source / permission errors (logs a
    warning and lets the original SAM3 failure surface).
    """
    global _sam3_text_assets_provisioned
    if _sam3_text_assets_provisioned:
        return

    try:
        import sam3 as _sam3_pkg  # type: ignore
    except ImportError:
        # SAM3 not installed; the import error from _check_sam3_available
        # is the right surface for that case.
        return

    try:
        sam3_dir = Path(_sam3_pkg.__file__).resolve().parent
    except Exception as exc:
        logger.warning("Could not resolve sam3 package directory: %s", exc)
        return

    target = sam3_dir.parent / "assets" / "bpe_simple_vocab_16e6.txt.gz"
    if target.exists():
        _sam3_text_assets_provisioned = True
        return

    try:
        import open_clip as _open_clip  # type: ignore
        source = Path(_open_clip.__file__).resolve().parent / "bpe_simple_vocab_16e6.txt.gz"
    except ImportError:
        logger.warning(
            "SAM3 vocab asset is missing and open_clip is not available to "
            "provide a fallback. SAM3 text segmentation will fail until "
            "%s exists.",
            target,
        )
        return

    if not source.exists():
        logger.warning(
            "open_clip is installed but does not ship %s; cannot provision "
            "SAM3 vocab asset.",
            source.name,
        )
        return

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        logger.info("Provisioned SAM3 tokenizer vocab from open_clip → %s", target)
        _sam3_text_assets_provisioned = True
    except Exception as exc:
        logger.warning("Failed to provision SAM3 vocab asset at %s: %s", target, exc)


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
                if getattr(getattr(torch, "version", None), "cuda", None) is None:
                    logger.warning("SAM3 runtime is installed, but this Python environment is using CPU-only PyTorch.")
                else:
                    logger.warning("SAM3 runtime is installed, but this Python environment cannot access CUDA right now.")
        except ImportError as exc:
            _sam3_available = False
            logger.warning("SAM3 runtime is unavailable: %s", exc)
    return bool(_sam3_available)


@contextlib.contextmanager
def _force_torch_load_weights_only_false():
    """Override ``torch.load`` ``weights_only=True`` during the SAM3 build.

    SAM3 0.1.3's ``model_builder.py`` calls
    ``torch.load(..., weights_only=True)`` on the checkpoint. PyTorch 2.6
    flipped the default of ``weights_only`` from ``False`` to ``True`` and
    started rejecting pickled objects (config classes, ``argparse.Namespace``,
    etc.) that aren't on its safe-globals allowlist — and the published
    facebook/sam3 checkpoint hits exactly that case. Without this override,
    ``build_sam3_image_model`` crashes with "Weights only load failed" the
    moment a SAM3 inference is attempted.

    Forcing ``weights_only=False`` is acceptable here: the checkpoint comes
    from facebook/sam3 on HuggingFace or ModelScope (both treated as trusted
    upstream sources for this app), and the override is scoped strictly to
    the SAM3 build call — restored in ``finally`` even if the build raises.
    """
    import torch
    original = torch.load

    def _torch_load_trusted(*args, **kwargs):
        kwargs["weights_only"] = False
        return original(*args, **kwargs)

    torch.load = _torch_load_trusted
    try:
        yield
    finally:
        torch.load = original


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

                # SAM3 0.1.3's wheel doesn't ship its tokenizer vocab; copy
                # it from open_clip (already a dep) so segment-by-text
                # doesn't crash with FileNotFoundError on first use.
                _ensure_sam3_text_assets()
                device = "cuda" if torch.cuda.is_available() else "cpu"
                resolved_checkpoint = _resolve_checkpoint_path(checkpoint_path)

                logger.info("Loading SAM3 on %s", device)
                with exclusive_ai_runtime("sam3-load"), _force_torch_load_weights_only_false():
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


SAM3_PRIVACY_PROMPTS = [
    {"prompt": "exposed female breast", "class": "breasts"},
    {"prompt": "exposed female nipple", "class": "breasts"},
    {"prompt": "exposed female genitalia", "class": "pussy"},
    {"prompt": "exposed male genitalia", "class": "dick"},
    {"prompt": "exposed anus", "class": "anus"},
    {"prompt": "exposed buttocks", "class": "buttocks"},
]


class SAM3Refiner:
    """SAM3-based segmentation: standalone text-prompt detection and box refinement."""

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

    def _inference_context(self):
        try:
            import torch
        except Exception:
            return contextlib.nullcontext()

        device = str(getattr(self.processor, "device", _sam3_device or "cuda"))
        if device.startswith("cuda"):
            return torch.amp.autocast(device_type="cuda", enabled=False)
        return contextlib.nullcontext()

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

            with exclusive_ai_runtime("sam3-inference"), self._inference_context():
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

    def detect_privacy_regions(
        self,
        image: Image.Image,
        conf_threshold: float = 0.3,
        prompts: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict]:
        prompts = prompts or SAM3_PRIVACY_PROMPTS
        rgb = image.convert("RGB")
        detections = []
        import gc

        for entry in prompts:
            text = entry["prompt"]
            cls_name = entry["class"]
            mask = self.segment_by_text(rgb, text)
            if mask is None:
                continue

            ys, xs = np.where(mask > 0)
            if len(xs) == 0:
                continue

            area = int(np.sum(mask > 0))
            image_area = rgb.width * rgb.height
            if area < 100 or area / image_area < 0.001:
                continue

            x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())

            detections.append({
                "class": cls_name,
                "confidence": round(min(1.0, area / max(1, (x2 - x1) * (y2 - y1))), 4),
                "box": [x1, y1, x2, y2],
                "mask": mask,
                "source": "sam3",
            })

            gc.collect()

        seen = set()
        unique = []
        for det in detections:
            key = (det["class"], tuple(det["box"]))
            if key not in seen:
                seen.add(key)
                unique.append(det)
        return unique

    def segment_by_text(self, image: Image.Image, text_prompt: str) -> Optional[np.ndarray]:
        try:
            with exclusive_ai_runtime("sam3-inference"), self._inference_context():
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
