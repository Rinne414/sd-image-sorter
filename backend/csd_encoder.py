"""CSD style encoder: the open_clip ViT-L/14 visual tower plus the style head.

CSD-ViT-L is OpenAI's CLIP ViT-L/14 visual tower fine-tuned for style (its
projection dropped: the tower answers its 1024-wide feature) followed by one
learned 1024 x 768 style matrix. OpenAI's own ``clip`` package is not needed:
open_clip's ``VisionTransformer`` has the same layers under the same names, and
OpenAI-trained weights need its QuickGELU activation. Weights are read by
``csd_weights`` (allow-listed ``weights_only`` pickle) and loaded strictly, so a
changed layout fails loudly instead of loading half of the model.

The class offers the same surface the style index drives on Kaloscope
(``prepare_style_input``, batch extraction at a runtime priority lane,
``supports_style_vectors``), so the one extraction job runs both spaces.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

import csd_weights
from ai_runtime_guard import (
    PRIORITY_NORMAL,
    claim_gpu_residency,
    cuda_has_headroom,
    exclusive_ai_runtime,
    forget_gpu_residency,
)

logger = logging.getLogger(__name__)

CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)
INPUT_SIZE = 224
FEATURE_DIM = 1024
CSD_EMBED_DIM = 768
# fp16 weights (0.6 GB) plus the activations of a batch of 8.
_MIN_CUDA_FREE_MB = 2500

CSD_NOT_PREPARED_ERROR = (
    "CSD is not prepared: click Prepare / Download for CSD in the Model Center. / "
    "CSD 画风描述模型尚未准备好：请到模型中心点击「准备 / 下载」。"
)
CSD_NOT_LOADED_ERROR = "The CSD model is not loaded."
CSD_NO_GPU_MEMORY_ERROR = (
    "Not enough free GPU memory to run CSD. Close other GPU programs or turn the "
    "GPU option off. / 显存不足，无法运行 CSD：请关闭其他占用显卡的程序，或关闭 GPU 选项。"
)


def build_backbone():
    """The CLIP ViT-L/14 visual tower (QuickGELU, no projection) as shapes only.

    Built on the meta device: no memory and no random initialisation, because
    the checkpoint's tensors are assigned into it (``load_state_dict(assign=True)``).
    """
    import torch
    from open_clip.transformer import QuickGELU, VisionTransformer

    with torch.device("meta"):
        visual = VisionTransformer(
            image_size=INPUT_SIZE,
            patch_size=14,
            width=FEATURE_DIM,
            layers=24,
            heads=16,
            mlp_ratio=4.0,
            output_dim=CSD_EMBED_DIM,
            act_layer=QuickGELU,
        )
    visual.proj = None  # CSD uses the 1024-wide feature before CLIP's projection
    return visual


class CsdEncoder:
    """Loads CSD once and turns pictures into 768-d unit style vectors."""

    # The style index batches pictures for this model even without an artist answer.
    vector_only_batches = True

    def __init__(self, use_gpu: bool = False) -> None:
        self.use_gpu = bool(use_gpu)
        self._backbone: Any = None
        self._style: Any = None
        self._device: Any = None
        self._dtype: Any = None
        self._transform: Any = None
        self._load_lock = threading.Lock()
        self.load_error: Optional[str] = None

    # ----------------------------------------------------------------- state
    @property
    def model_loaded(self) -> bool:
        return self._backbone is not None and self._style is not None

    def supports_style_vectors(self) -> bool:
        return self.model_loaded

    @property
    def style_vector_model_version(self) -> str:
        return csd_weights.CSD_MODEL_VERSION

    def _pick_device(self):
        import torch

        if self.use_gpu and torch.cuda.is_available():
            if not cuda_has_headroom(torch, min_free_mb=_MIN_CUDA_FREE_MB):
                raise RuntimeError(CSD_NO_GPU_MEMORY_ERROR)
            return torch.device("cuda"), torch.float16
        return torch.device("cpu"), torch.float32

    # ------------------------------------------------------------------ load
    def load(self) -> None:
        """Read the checkpoint and build the model; a no-op once loaded."""
        if self.model_loaded:
            return
        with self._load_lock:
            if self.model_loaded:
                return
            try:
                self._load_locked()
                self.load_error = None
            except Exception as exc:
                self.release()
                self.load_error = str(exc)
                raise

    def _load_locked(self) -> None:
        import torch

        if not csd_weights.is_installed():
            raise RuntimeError(CSD_NOT_PREPARED_ERROR)
        if not csd_weights.runtime_available():
            raise RuntimeError(CSD_NOT_PREPARED_ERROR)
        with exclusive_ai_runtime("csd-load"):
            device, dtype = self._pick_device()
            backbone_state, style = csd_weights.split_state_dict(
                csd_weights.load_state_dict_file(csd_weights.weights_in_use())
            )
            backbone = build_backbone()
            backbone.load_state_dict(backbone_state, strict=True, assign=True)
            del backbone_state
            backbone.requires_grad_(False)
            if device.type == "cuda":
                claim_gpu_residency(self, self.release, label="csd")
            else:
                forget_gpu_residency(self)
                with torch.no_grad():  # leave the memory-mapped checkpoint file
                    for param in backbone.parameters():
                        param.data = param.data.clone()
            self._backbone = backbone.to(device=device, dtype=dtype).eval()
            self._style = style.to(device=device, dtype=torch.float32).contiguous()
            self._device, self._dtype = device, dtype
        logger.info("CSD loaded on %s (%s)", self._device, self._dtype)

    def release(self) -> None:
        """Drop the model (and its GPU memory); the next call loads it again."""
        self._backbone = None
        self._style = None
        forget_gpu_residency(self)
        try:
            from ai_runtime_guard import clear_torch_cuda_cache

            clear_torch_cuda_cache()
        except Exception:  # noqa: BLE001 - freeing memory must never raise
            logger.debug("CSD release could not clear the CUDA cache", exc_info=True)

    # ----------------------------------------------------------------- input
    def prepare_style_input(self, image: Image.Image):
        """The 3x224x224 float32 tensor of one decoded picture (CPU work, safe
        on helper threads): short side to 224 (bicubic), centre crop, CLIP
        normalisation, the reference implementation's own transform."""
        if self._transform is None:
            from torchvision import transforms as T

            self._transform = T.Compose(
                [
                    T.Resize(INPUT_SIZE, interpolation=T.InterpolationMode.BICUBIC),
                    T.CenterCrop(INPUT_SIZE),
                    T.ToTensor(),
                    T.Normalize(CLIP_MEAN, CLIP_STD),
                ]
            )
        return self._transform(image)

    # ------------------------------------------------------------- inference
    def embed_batch(self, batch) -> np.ndarray:
        """(N, 768) unit vectors of an (N, 3, 224, 224) tensor batch."""
        import torch

        if not self.model_loaded:
            raise RuntimeError(CSD_NOT_LOADED_ERROR)
        with torch.no_grad():
            features = self._backbone(batch.to(self._device, dtype=self._dtype))
            embedded = torch.nn.functional.normalize(
                features.float() @ self._style, dim=1
            )
        vectors = embedded.cpu().numpy().astype(np.float32, copy=False)
        if vectors.ndim != 2 or vectors.shape[0] != batch.shape[0]:
            raise RuntimeError("CSD returned an unexpected number of vectors.")
        if not np.all(np.isfinite(vectors)):
            raise RuntimeError("CSD returned a non-finite style vector.")
        return vectors

    def _stack(self, items: Sequence[Tuple[str, Any]]):
        import torch

        return torch.stack(
            [
                value
                if isinstance(value, torch.Tensor)
                else self.prepare_style_input(value)
                for _path, value in items
            ]
        )

    def extract_style_vectors_and_identifications(
        self,
        items: Sequence[Tuple[str, Any]],
        *,
        top_k: int = 5,
        threshold: float = 0.0,
        priority: int = PRIORITY_NORMAL,
    ) -> List[Tuple[np.ndarray, None]]:
        """One forward for a batch of (path, decoded image or prepared tensor)
        pairs; CSD has no artist classifier, so the second answer is None."""
        if not items:
            return []
        batch = self._stack(items)
        with exclusive_ai_runtime("csd-style-vector", priority=priority):
            vectors = self.embed_batch(batch)
        return [(vector, None) for vector in vectors]

    def extract_style_vector(
        self, image_path: str, priority: int = PRIORITY_NORMAL
    ) -> np.ndarray:
        """Style vector of one image file."""
        self.load()
        with Image.open(image_path) as source:
            image = source.convert("RGB")
        ((vector, _none),) = self.extract_style_vectors_and_identifications(
            [(image_path, image)], priority=priority
        )
        return vector


_encoder: Optional[CsdEncoder] = None
_encoder_lock = threading.Lock()


def get_csd_encoder(use_gpu: Optional[bool] = None) -> CsdEncoder:
    """The shared encoder; a changed GPU choice replaces (and frees) the old one."""
    global _encoder
    if use_gpu is None:
        from config import ARTIST_USE_GPU

        use_gpu = ARTIST_USE_GPU
    wanted = bool(use_gpu)
    with _encoder_lock:
        if _encoder is not None and _encoder.use_gpu == wanted:
            return _encoder
        if _encoder is not None:
            _encoder.release()
        _encoder = CsdEncoder(use_gpu=wanted)
        return _encoder


def load_csd_encoder(getter, use_gpu: Optional[bool]) -> CsdEncoder:
    """Build and load CSD exactly once. A model that is not prepared (or does
    not fit the GPU) is a precondition the user can fix, not a fault: it is a
    ServiceError carrying the explaining sentence."""
    from exceptions import ServiceError

    encoder = getter(use_gpu=use_gpu)
    try:
        encoder.load()
    except (RuntimeError, OSError) as exc:
        raise ServiceError(str(exc)) from exc
    if getattr(encoder, "model_loaded", True) is False:
        raise ServiceError(str(getattr(encoder, "load_error", None) or CSD_NOT_PREPARED_ERROR))
    return encoder
