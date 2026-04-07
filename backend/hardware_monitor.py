"""Hardware detection and memory monitoring for safe AI model inference."""
import logging
import platform
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def get_system_info() -> Dict[str, Any]:
    """
    Detect system hardware capabilities for AI model inference.

    Returns a dictionary with:
    - total_ram_gb, available_ram_gb (via psutil)
    - gpu_name, gpu_vram_total_mb, gpu_vram_available_mb (via torch.cuda or pynvml, fallback to None)
    - cpu_count, os_platform
    - onnx_providers (from onnxruntime.get_available_providers())

    All GPU detection is wrapped in try/except and falls back gracefully.
    """
    info: Dict[str, Any] = {
        "total_ram_gb": None,
        "available_ram_gb": None,
        "gpu_name": None,
        "gpu_vram_total_mb": None,
        "gpu_vram_available_mb": None,
        "cpu_count": None,
        "os_platform": platform.system(),
        "onnx_providers": [],
    }

    # --- RAM via psutil ---
    try:
        import psutil

        mem = psutil.virtual_memory()
        info["total_ram_gb"] = round(mem.total / (1024 ** 3), 2)
        info["available_ram_gb"] = round(mem.available / (1024 ** 3), 2)
    except Exception as exc:
        logger.debug("psutil RAM detection failed: %s", exc)

    # --- CPU count ---
    try:
        import multiprocessing

        info["cpu_count"] = multiprocessing.cpu_count()
    except Exception as exc:
        logger.debug("CPU count detection failed: %s", exc)

    # --- GPU via torch.cuda ---
    try:
        import torch

        if torch.cuda.is_available():
            info["gpu_name"] = torch.cuda.get_device_name(0)
            try:
                props = torch.cuda.get_device_properties(0)
                info["gpu_vram_total_mb"] = round(props.total_mem / (1024 ** 2), 0)
            except Exception:
                pass
            try:
                free_mem, _ = torch.cuda.mem_get_info(0)
                info["gpu_vram_available_mb"] = round(free_mem / (1024 ** 2), 0)
            except Exception:
                pass
    except Exception as exc:
        logger.debug("torch.cuda GPU detection failed: %s", exc)

    # --- Fallback GPU via pynvml if torch didn't work ---
    if info["gpu_name"] is None:
        try:
            import pynvml  # type: ignore

            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            info["gpu_name"] = pynvml.nvmlDeviceGetName(handle)
            if isinstance(info["gpu_name"], bytes):
                info["gpu_name"] = info["gpu_name"].decode("utf-8")
            mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
            info["gpu_vram_total_mb"] = round(mem_info.total / (1024 ** 2), 0)
            info["gpu_vram_available_mb"] = round(mem_info.free / (1024 ** 2), 0)
            pynvml.nvmlShutdown()
        except Exception as exc:
            logger.debug("pynvml GPU detection failed: %s", exc)

    # --- ONNX Runtime providers ---
    try:
        import onnxruntime as ort  # type: ignore

        info["onnx_providers"] = ort.get_available_providers()
    except Exception as exc:
        logger.debug("ONNX Runtime provider detection failed: %s", exc)

    return info


def recommend_tagger_config(system_info: Dict[str, Any]) -> Dict[str, Any]:
    """
    Recommend tagger configuration based on detected hardware.

    Args:
        system_info: Output from get_system_info().

    Returns a dictionary with:
    - recommended_batch_size: int
    - recommended_use_gpu: bool
    - recommended_session_refresh_interval: int (GPU -> 100, CPU -> 0)
    - risk_level: "low" / "medium" / "high"
    - message: human-readable recommendation string
    """
    vram_mb = system_info.get("gpu_vram_total_mb")
    gpu_name = system_info.get("gpu_name")
    has_gpu = gpu_name is not None and vram_mb is not None

    onnx_providers = system_info.get("onnx_providers") or []
    has_cuda_provider = "CUDAExecutionProvider" in onnx_providers

    use_gpu = has_gpu and has_cuda_provider

    ram_gb = system_info.get("total_ram_gb") or 8

    if use_gpu and vram_mb is not None:
        if vram_mb < 4000:
            batch_size = 1
        elif vram_mb < 8000:
            batch_size = 2
        elif vram_mb < 12000:
            batch_size = 4
        else:
            batch_size = 8
    else:
        # CPU mode: scale with available RAM
        if ram_gb < 8:
            batch_size = 1
        elif ram_gb < 16:
            batch_size = 2
        elif ram_gb < 32:
            batch_size = 4
        else:
            batch_size = 8

    session_refresh_interval = 100 if use_gpu else 0

    # Determine risk level
    if use_gpu:
        if vram_mb is not None and vram_mb < 4000:
            risk_level = "high"
        elif vram_mb is not None and vram_mb < 8000:
            risk_level = "medium"
        else:
            risk_level = "low"
    else:
        risk_level = "low"

    # Build message
    parts = []
    if use_gpu:
        parts.append(f"GPU detected: {gpu_name} ({int(vram_mb)}MB VRAM).")
        if risk_level == "high":
            parts.append("Low VRAM detected. Batch size limited to 1 and session refresh enabled to prevent crashes.")
        elif risk_level == "medium":
            parts.append("Moderate VRAM. Session refresh enabled for stability.")
        else:
            parts.append("Sufficient VRAM for GPU inference.")
    else:
        if has_gpu and not has_cuda_provider:
            parts.append(f"GPU detected ({gpu_name}) but CUDAExecutionProvider not available in ONNX Runtime.")
            parts.append("Running on CPU.")
        else:
            parts.append("No GPU detected. Running on CPU.")
    message = " ".join(parts)

    return {
        "recommended_batch_size": batch_size,
        "recommended_use_gpu": use_gpu,
        "recommended_session_refresh_interval": session_refresh_interval,
        "risk_level": risk_level,
        "message": message,
    }


def check_memory_pressure() -> Dict[str, Any]:
    """
    Check current memory pressure (RAM and VRAM).

    Returns a dictionary with:
    - ram_available_gb: float or None
    - ram_percent_used: float or None
    - vram_available_mb: float or None (None if no GPU)
    - vram_percent_used: float or None (None if no GPU)
    - should_pause: bool (True when RAM < 1GB available)
    - should_restart_session: bool (True when VRAM available < 500MB and GPU is in use)
    """
    result: Dict[str, Any] = {
        "ram_available_gb": None,
        "ram_percent_used": None,
        "vram_available_mb": None,
        "vram_percent_used": None,
        "should_pause": False,
        "should_restart_session": False,
    }

    # --- RAM pressure ---
    try:
        import psutil

        mem = psutil.virtual_memory()
        result["ram_available_gb"] = round(mem.available / (1024 ** 3), 2)
        result["ram_percent_used"] = mem.percent
        if result["ram_available_gb"] < 1.0:
            result["should_pause"] = True
    except Exception as exc:
        logger.debug("psutil memory check failed: %s", exc)

    # --- VRAM pressure via torch.cuda ---
    vram_checked = False
    try:
        import torch

        if torch.cuda.is_available():
            free_mem, total_mem = torch.cuda.mem_get_info(0)
            result["vram_available_mb"] = round(free_mem / (1024 ** 2), 0)
            if total_mem > 0:
                used_pct = ((total_mem - free_mem) / total_mem) * 100
                result["vram_percent_used"] = round(used_pct, 1)
            if result["vram_available_mb"] < 500:
                result["should_restart_session"] = True
            vram_checked = True
    except Exception as exc:
        logger.debug("torch.cuda VRAM check failed: %s", exc)

    # --- Fallback VRAM via pynvml ---
    if not vram_checked:
        try:
            import pynvml  # type: ignore

            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
            result["vram_available_mb"] = round(mem_info.free / (1024 ** 2), 0)
            if mem_info.total > 0:
                used_pct = (mem_info.used / mem_info.total) * 100
                result["vram_percent_used"] = round(used_pct, 1)
            if result["vram_available_mb"] < 500:
                result["should_restart_session"] = True
            pynvml.nvmlShutdown()
        except Exception as exc:
            logger.debug("pynvml VRAM check failed: %s", exc)

    return result
