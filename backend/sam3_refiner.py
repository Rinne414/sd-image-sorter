"""
SAM 3 (Segment Anything with Concepts) mask refinement for censoring.

Takes bounding boxes from YOLO26 / NudeNet and produces pixel-precise
segmentation masks using Meta's SAM 3 model.

SAM 3 features:
- Open-vocabulary segmentation via text prompts
- 848M parameters, DETR-based detector + SAM2 tracker
- Text-prompt support for semantic selection

Requires:
- Python 3.12+
- PyTorch 2.7+
- CUDA 12.6+
- git clone https://github.com/facebookresearch/sam3.git && pip install -e .
- HuggingFace access for model checkpoints (gated)

NOTE: SAM3 requires significant GPU resources. Falls back gracefully
to bounding-box censoring if SAM3 is unavailable.
"""
import os
import threading
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image


# Lazy-loaded model
_sam3_model = None
_sam3_processor = None
_sam3_lock = threading.Lock()
_sam3_available = None  # None = not checked, True/False after check


def _check_sam3_available() -> bool:
    """Check if SAM3 can be imported."""
    global _sam3_available
    if _sam3_available is None:
        try:
            from sam3.build_sam import build_sam3_image_model
            from sam3.sam3_processor import Sam3Processor
            _sam3_available = True
        except ImportError:
            _sam3_available = False
            print("[SAM3] Not available. Install from: https://github.com/facebookresearch/sam3")
    return _sam3_available


def _load_sam3(checkpoint_path: Optional[str] = None):
    """Load SAM3 model and processor (singleton, thread-safe)."""
    global _sam3_model, _sam3_processor
    if _sam3_model is None:
        with _sam3_lock:
            if _sam3_model is None:
                if not _check_sam3_available():
                    raise RuntimeError(
                        "SAM3 not available. Install from:\n"
                        "  git clone https://github.com/facebookresearch/sam3.git\n"
                        "  cd sam3 && pip install -e .\n"
                        "Requires Python 3.12+, PyTorch 2.7+, CUDA 12.6+"
                    )

                from sam3.build_sam import build_sam3_image_model
                from sam3.sam3_processor import Sam3Processor
                import torch

                print("[SAM3] Loading model...")

                # Use default checkpoint or user-provided
                if checkpoint_path and os.path.exists(checkpoint_path):
                    model = build_sam3_image_model(checkpoint=checkpoint_path)
                else:
                    # Will download from HuggingFace if access is granted
                    model = build_sam3_image_model()

                device = "cuda" if torch.cuda.is_available() else "cpu"
                model = model.to(device)
                model.eval()

                _sam3_model = model
                _sam3_processor = Sam3Processor(model)
                print(f"[SAM3] Model loaded on {device}")

    return _sam3_model, _sam3_processor


class SAM3Refiner:
    """
    SAM3 mask refinement for precise censoring.

    Takes bounding boxes (from YOLO26/NudeNet) and refines them
    into pixel-precise segmentation masks using SAM3.
    """

    def __init__(self, checkpoint_path: Optional[str] = None):
        self.checkpoint_path = checkpoint_path
        self._model = None
        self._processor = None

    @staticmethod
    def is_available() -> bool:
        """Check if SAM3 is available."""
        return _check_sam3_available()

    def load(self):
        """Load SAM3 model."""
        self._model, self._processor = _load_sam3(self.checkpoint_path)

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
        """
        Refine a bounding box into a precise segmentation mask.

        Args:
            image: PIL Image.
            box: [x1, y1, x2, y2] bounding box.
            text_prompt: Optional text description for semantic guidance.
                e.g. "breast", "genitalia", "buttocks"

        Returns:
            Binary mask as numpy array (H, W), or None on failure.
        """
        try:
            import torch

            processor = self.processor
            img_array = np.array(image.convert("RGB"))

            # Set image
            processor.set_image(img_array)

            # Use text prompt if provided (SAM3 feature)
            if text_prompt:
                processor.set_text_prompt(text_prompt)

            # Use bounding box as input prompt
            input_box = np.array(box)
            masks, scores, _ = processor.predict(
                box=input_box,
                multimask_output=True,
            )

            if masks is not None and len(masks) > 0:
                # Return the highest-scored mask
                best_idx = np.argmax(scores)
                return masks[best_idx].astype(np.uint8)

        except Exception as e:
            print(f"[SAM3] Mask refinement failed: {e}")

        return None

    def refine_boxes(
        self,
        image: Image.Image,
        detections: List[Dict],
    ) -> List[Dict]:
        """
        Refine multiple detection boxes into masks.

        Args:
            image: PIL Image.
            detections: List of detection dicts with 'box' and 'class' keys.

        Returns:
            Same detections list with added 'mask' key for each detection.
        """
        import copy
        refined = []

        for det in detections:
            refined_det = copy.deepcopy(det)
            box = det.get("box", [])
            cls_name = det.get("class", "")

            if box:
                mask = self.refine_box(
                    image,
                    box,
                    text_prompt=cls_name if cls_name else None,
                )
                if mask is not None:
                    refined_det["mask"] = mask
                    refined_det["mask_refined"] = True
                else:
                    refined_det["mask_refined"] = False
            else:
                refined_det["mask_refined"] = False

            refined.append(refined_det)

        return refined

    def segment_by_text(
        self,
        image: Image.Image,
        text_prompt: str,
    ) -> Optional[np.ndarray]:
        """
        Segment objects by text description (open-vocabulary).

        SAM3's key feature: segment anything described in natural language.

        Args:
            image: PIL Image.
            text_prompt: Text description of what to segment.
                e.g. "exposed breasts", "person's face"

        Returns:
            Binary mask as numpy array (H, W), or None on failure.
        """
        try:
            processor = self.processor
            img_array = np.array(image.convert("RGB"))

            processor.set_image(img_array)
            processor.set_text_prompt(text_prompt)

            masks, scores, _ = processor.predict(
                multimask_output=True,
            )

            if masks is not None and len(masks) > 0:
                best_idx = np.argmax(scores)
                return masks[best_idx].astype(np.uint8)

        except Exception as e:
            print(f"[SAM3] Text segmentation failed: {e}")

        return None


# Singleton
_sam3_refiner = None


def get_sam3_refiner(
    checkpoint_path: Optional[str] = None,
) -> SAM3Refiner:
    """Get singleton SAM3 refiner."""
    global _sam3_refiner
    if _sam3_refiner is None:
        _sam3_refiner = SAM3Refiner(checkpoint_path=checkpoint_path)
    return _sam3_refiner
