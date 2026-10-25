"""The tagger the UI preselects on this computer.

PixAI v1.0 knows far more characters and series than the WD v3 tag list, which
stops around early 2024 and has no series tags. On 240 of the owner's pictures
(2026-10-26, .plans/dtq-2026-10) it named 130 of the 168 prompt characters
(SwinV2 79) and 110 of the 126 series (SwinV2 none), with equal general-tag
quality, hair and eye colour and rating. It needs about 8.3 GB of free video
memory at 1008 px and is about ten times slower than SwinV2 (0.53 s vs 0.05 s
per picture on an RTX 3090), so it is the default only on an NVIDIA card with
room for it; elsewhere the light SwinV2 stays the default.

``SD_IMAGE_SORTER_DEFAULT_TAGGER_MODEL`` set explicitly always wins. A request
without a model name still uses ``config.DEFAULT_TAGGER_MODEL``, which runs on
any hardware.
"""

import logging
import os
from typing import Any, Dict

from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS

logger = logging.getLogger(__name__)

DEFAULT_TAGGER_ENV = "SD_IMAGE_SORTER_DEFAULT_TAGGER_MODEL"
LARGE_GPU_DEFAULT_TAGGER_MODEL = "pixai-tagger-v1.0"
# A 12 GB card reports about 12,000-12,288 MiB; desktop use leaves it the
# ~8.3 GB PixAI v1.0 needs. 8 and 10 GB cards keep SwinV2.
LARGE_GPU_MIN_VRAM_MB = 11_500.0


def _explicit_default() -> str:
    return str(os.environ.get(DEFAULT_TAGGER_ENV) or "").strip()


def _cuda_card_vram_mb(system_info: Dict[str, Any]) -> float:
    """Memory of the NVIDIA card ONNX Runtime will use, in MiB (0 when none).

    With PyTorch the probe reports CUDA device 0, the card ONNX Runtime picks by
    default. Without it the NVIDIA entries of the adapter list are all there is;
    CUDA orders the fastest (usually largest) card first, so take the largest.
    """
    if system_info.get("torch_cuda_available"):
        return float(system_info.get("gpu_vram_total_mb") or 0)
    sizes = [
        float(device.get("vram_total_mb") or 0)
        for device in system_info.get("gpu_devices") or []
        if str(device.get("vendor") or "").lower() == "nvidia"
    ]
    if "nvidia" in str(system_info.get("gpu_name") or "").lower():
        sizes.append(float(system_info.get("gpu_vram_total_mb") or 0))
    return max(sizes, default=0.0)


def pick_default_tagger_model(system_info: Dict[str, Any]) -> str:
    """PixAI v1.0 on an NVIDIA (CUDA) card of 12 GB or more, otherwise SwinV2."""
    explicit = _explicit_default()
    if explicit:
        return explicit
    providers = system_info.get("onnx_providers") or []
    if (
        LARGE_GPU_DEFAULT_TAGGER_MODEL in TAGGER_MODELS
        and "CUDAExecutionProvider" in providers
        and _cuda_card_vram_mb(system_info) >= LARGE_GPU_MIN_VRAM_MB
    ):
        return LARGE_GPU_DEFAULT_TAGGER_MODEL
    return DEFAULT_TAGGER_MODEL


def default_tagger_model() -> str:
    """This computer's default, from the hardware probe (cached there for ~30 s).

    Not cached here: a probe that ran before the GPU runtime was installed, or
    that failed, must not decide the default until the next restart.
    """
    explicit = _explicit_default()
    if explicit:
        return explicit
    from hardware_monitor import get_system_info

    try:
        system_info = get_system_info()
    except Exception as exc:
        logger.warning(
            "Hardware probe failed; default tagger stays %s: %s",
            DEFAULT_TAGGER_MODEL,
            exc,
        )
        return DEFAULT_TAGGER_MODEL
    return pick_default_tagger_model(system_info)
