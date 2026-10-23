"""Check free video memory before a model goes on the GPU.

The program stays open next to ComfyUI all day. Loading a tagger on a card
whose memory ComfyUI is using either fails or pushes ComfyUI out of memory in
the middle of a generation. Before a model is put on the GPU, its loader asks
``decide_gpu``: when the card has less free memory than the model needs, that
job runs on the CPU instead and its status says so.

Free memory comes from ``nvidia-smi`` (the same probe the hardware report
uses). It does not create a CUDA context, so asking costs no video memory.
When the free amount cannot be read (no NVIDIA card, DirectML, no driver
tool), the GPU is allowed and the runtime's own out-of-memory fallback stays
the safety net, as before.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

# What a model needs free before it goes on the GPU: its weights, the runtime
# workspace and a small batch. Measured loads on a 3090: WD14 SwinV2/ViT about
# 0.9-1.2 GB, EVA02-Large and the 1008 px PixAI about 2.5-3 GB. ToriiGate has
# its own, larger floor (toriigate_tagger.TORIIGATE_GPU_MIN_FREE_MB).
TAGGER_GPU_NEED_MB: Dict[str, float] = {
    "light": 1200.0,
    "balanced": 1500.0,
    "heavy": 3000.0,
    "custom": 2000.0,
}
_RECENT_FALLBACK_LIMIT = 8

_lock = threading.Lock()
_recent_fallbacks: List[Dict[str, Any]] = []


@dataclass(frozen=True)
class GpuDecision:
    """Whether one load may use the GPU, and the numbers behind the answer."""

    use_gpu: bool
    free_mb: Optional[float]
    need_mb: float

    def message(self) -> str:
        """The job-status sentence for a CPU fallback ("" when the GPU is used)."""
        if self.use_gpu:
            return ""
        free = int(self.free_mb or 0)
        return (
            f"GPU busy, used CPU: only {free} MB of video memory was free and this "
            f"model needs about {int(self.need_mb)} MB (another program, such as "
            "ComfyUI, is using the card)."
        )


def _probe_free_vram_mb() -> Optional[float]:
    """Free memory of the first NVIDIA card in MB, or None when unknown."""
    from hardware_monitor import _nvidia_smi_probe

    for device in _nvidia_smi_probe():
        free_mb = device.get("vram_available_mb")
        if isinstance(free_mb, (int, float)):
            return float(free_mb)
    return None


def free_vram_mb() -> Optional[float]:
    try:
        return _probe_free_vram_mb()
    except Exception:  # noqa: BLE001 - an unreadable probe means "unknown"
        return None


def decide_gpu(label: str, need_mb: float) -> GpuDecision:
    """Decide GPU or CPU for one load; a CPU answer is remembered for Settings."""
    free_mb = free_vram_mb()
    use_gpu = free_mb is None or free_mb >= float(need_mb)
    decision = GpuDecision(use_gpu=use_gpu, free_mb=free_mb, need_mb=float(need_mb))
    if not use_gpu:
        _remember_fallback(label, decision)
    return decision


def _remember_fallback(label: str, decision: GpuDecision) -> None:
    entry = {
        "label": str(label),
        "free_mb": decision.free_mb,
        "need_mb": decision.need_mb,
        "at": time.time(),
    }
    with _lock:
        _recent_fallbacks.insert(0, entry)
        del _recent_fallbacks[_RECENT_FALLBACK_LIMIT:]


def recent_fallbacks() -> List[Dict[str, Any]]:
    """Newest first: the loads that went to the CPU because the GPU was busy."""
    with _lock:
        return [dict(entry) for entry in _recent_fallbacks]


def clear_recent_fallbacks() -> None:
    with _lock:
        _recent_fallbacks.clear()


def tagger_gpu_need_mb(model_name: str) -> float:
    """Free video memory a tagger model needs, by its runtime safety tier."""
    from config import TAGGER_MODELS

    key = str(model_name or "").strip().lower()
    config = TAGGER_MODELS.get(key, {})
    if key == "custom" or not config:
        return TAGGER_GPU_NEED_MB["custom"]
    if str(config.get("runtime_backend", "")).lower() == "toriigate":
        from toriigate_tagger import TORIIGATE_GPU_MIN_FREE_MB

        return float(TORIIGATE_GPU_MIN_FREE_MB)
    tier = str(config.get("runtime_safety_tier") or "").strip().lower()
    if not tier:
        if "eva02" in key or key in {"camie-tagger-v2", "pixai-tagger-v0.9"}:
            tier = "heavy"
        elif key == "wd-vit-tagger-v3":
            tier = "light"
        else:
            tier = "balanced"
    return TAGGER_GPU_NEED_MB.get(tier, TAGGER_GPU_NEED_MB["balanced"])
