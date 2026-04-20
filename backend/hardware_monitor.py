"""Hardware detection and memory monitoring for adaptive AI model inference."""
import json
import logging
import platform
import subprocess
from importlib import metadata
from typing import Any, Dict, List, Optional

from config import TAGGER_MODELS

logger = logging.getLogger(__name__)


def _nvidia_smi_probe() -> List[Dict[str, Any]]:
    """Query nvidia-smi for per-GPU name + true VRAM. Returns [] if unavailable."""
    try:
        raw = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=6,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception as exc:
        logger.debug("nvidia-smi probe failed: %s", exc)
        return []

    results: List[Dict[str, Any]] = []
    for line in raw.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            continue
        name = parts[0]
        try:
            total_mb = float(parts[1])
        except ValueError:
            continue
        free_mb: Optional[float] = None
        if len(parts) >= 3:
            try:
                free_mb = float(parts[2])
            except ValueError:
                free_mb = None
        results.append({
            "name": name,
            "vendor": "nvidia",
            "vram_total_mb": total_mb,
            "vram_available_mb": free_mb,
        })
    return results


# Win32_VideoController.AdapterRAM is a 32-bit DWORD, capped at ~4 GB. Any value at
# this cap is unreliable for modern GPUs and should be replaced with nvidia-smi data.
WMI_ADAPTER_RAM_CAP_MB = 4095


def _detect_windows_gpu_devices() -> List[Dict[str, Any]]:
    """Best-effort Windows GPU enumeration via CIM to catch NVIDIA/Intel/AMD devices.

    NVIDIA VRAM reported by WMI is clamped at 4 GB due to the 32-bit AdapterRAM field,
    so we overlay nvidia-smi results when they are available.
    """
    if platform.system() != "Windows":
        return []

    try:
        command = [
            "powershell",
            "-NoProfile",
            "-Command",
            (
                "Get-CimInstance Win32_VideoController | "
                "Select-Object Name,AdapterRAM,PNPDeviceID | ConvertTo-Json -Compress"
            ),
        ]
        raw = subprocess.check_output(command, text=True, timeout=10).strip()
        if not raw:
            return []

        parsed = json.loads(raw)
        rows = parsed if isinstance(parsed, list) else [parsed]
        devices: List[Dict[str, Any]] = []
        for row in rows:
            name = str(row.get("Name") or "").strip()
            if not name:
                continue

            lowered = name.lower()
            if "virtual" in lowered and "nvidia" not in lowered:
                continue
            if "microsoft basic render" in lowered:
                continue

            adapter_ram = row.get("AdapterRAM")
            vram_mb = None
            try:
                if adapter_ram:
                    vram_mb = round(float(adapter_ram) / (1024 ** 2), 0)
            except Exception:
                vram_mb = None

            vendor = "unknown"
            if "nvidia" in lowered:
                vendor = "nvidia"
            elif "intel" in lowered:
                vendor = "intel"
            elif "amd" in lowered or "radeon" in lowered:
                vendor = "amd"

            devices.append({
                "name": name,
                "vendor": vendor,
                "vram_total_mb": vram_mb,
                "pnp_device_id": row.get("PNPDeviceID"),
            })

        nvidia_true = _nvidia_smi_probe()
        if nvidia_true:
            # WMI enumerates in PnP order; nvidia-smi enumerates in NVML/CUDA
            # order. On dual-NVIDIA rigs the two orders can diverge, so match
            # by name first and only fall back to positional matching when the
            # names don't uniquely line up (e.g. two identical cards).
            consumed = [False] * len(nvidia_true)
            for device in devices:
                if device.get("vendor") != "nvidia":
                    continue
                wmi_name = (device.get("name") or "").strip().lower()
                truth_idx: Optional[int] = None
                for idx, truth in enumerate(nvidia_true):
                    if consumed[idx]:
                        continue
                    if (truth.get("name") or "").strip().lower() == wmi_name:
                        truth_idx = idx
                        break
                if truth_idx is None:
                    for idx in range(len(nvidia_true)):
                        if not consumed[idx]:
                            truth_idx = idx
                            break
                if truth_idx is None:
                    break
                consumed[truth_idx] = True
                truth = nvidia_true[truth_idx]
                wmi_vram = device.get("vram_total_mb")
                if wmi_vram is None or wmi_vram <= WMI_ADAPTER_RAM_CAP_MB + 1:
                    device["vram_total_mb"] = truth.get("vram_total_mb")
                if truth.get("vram_available_mb") is not None:
                    device["vram_available_mb"] = truth["vram_available_mb"]

        return devices
    except Exception as exc:
        logger.debug("Windows GPU enumeration failed: %s", exc)
        return []


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
        "torch_cuda_available": False,
        "cpu_count": None,
        "os_platform": platform.system(),
        "onnx_providers": [],
        "gpu_devices": [],
        "onnxruntime_version": None,
        "onnxruntime_gpu_version": None,
        "onnxruntime_conflict": False,
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

    # --- Windows multi-GPU enumeration (NVIDIA / Intel / AMD) ---
    info["gpu_devices"] = _detect_windows_gpu_devices()

    # --- GPU via torch.cuda ---
    try:
        import torch

        if torch.cuda.is_available():
            info["torch_cuda_available"] = True
            info["gpu_name"] = torch.cuda.get_device_name(0)
            try:
                props = torch.cuda.get_device_properties(0)
                info["gpu_vram_total_mb"] = round(props.total_mem / (1024 ** 2), 0)
            except Exception:
                pass
            try:
                free_mem, total_mem = torch.cuda.mem_get_info(0)
                info["gpu_vram_available_mb"] = round(free_mem / (1024 ** 2), 0)
                if info["gpu_vram_total_mb"] is None:
                    info["gpu_vram_total_mb"] = round(total_mem / (1024 ** 2), 0)
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

    # --- Final fallback from enumerated devices (nvidia-smi has already overlaid
    #     accurate NVIDIA VRAM on top of the 4 GB-capped WMI AdapterRAM) ---
    if info["gpu_name"] is None and info["gpu_devices"]:
        primary = info["gpu_devices"][0]
        info["gpu_name"] = primary.get("name")
        info["gpu_vram_total_mb"] = primary.get("vram_total_mb")
        if info["gpu_vram_available_mb"] is None:
            info["gpu_vram_available_mb"] = primary.get("vram_available_mb")
    elif info["gpu_devices"]:
        # torch / pynvml already populated gpu_name. If they missed VRAM numbers,
        # borrow from the matching enumerated device.
        for device in info["gpu_devices"]:
            if device.get("name") == info["gpu_name"]:
                if info["gpu_vram_total_mb"] is None:
                    info["gpu_vram_total_mb"] = device.get("vram_total_mb")
                if info["gpu_vram_available_mb"] is None:
                    info["gpu_vram_available_mb"] = device.get("vram_available_mb")
                break

    # --- ONNX Runtime providers ---
    try:
        from runtime_env import prepare_onnxruntime_environment

        prepare_onnxruntime_environment()
        import onnxruntime as ort  # type: ignore

        info["onnx_providers"] = ort.get_available_providers()
    except Exception as exc:
        logger.debug("ONNX Runtime provider detection failed: %s", exc)

    # --- Installed ONNX Runtime distributions ---
    try:
        info["onnxruntime_version"] = metadata.version("onnxruntime")
    except metadata.PackageNotFoundError:
        info["onnxruntime_version"] = None
    except Exception as exc:
        logger.debug("onnxruntime package inspection failed: %s", exc)

    try:
        info["onnxruntime_gpu_version"] = metadata.version("onnxruntime-gpu")
    except metadata.PackageNotFoundError:
        info["onnxruntime_gpu_version"] = None
    except Exception as exc:
        logger.debug("onnxruntime-gpu package inspection failed: %s", exc)

    info["onnxruntime_conflict"] = bool(info["onnxruntime_version"] and info["onnxruntime_gpu_version"])

    return info


def recommend_tagger_config(
    system_info: Dict[str, Any],
    model_name: Optional[str] = None,
    use_gpu: Optional[bool] = None,
) -> Dict[str, Any]:
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
    has_gpu = gpu_name is not None

    onnx_providers = system_info.get("onnx_providers") or []
    has_cuda_provider = "CUDAExecutionProvider" in onnx_providers
    has_dml_provider = "DmlExecutionProvider" in onnx_providers
    model_key = str(model_name or "").strip().lower()
    torch_cuda_available = bool(system_info.get("torch_cuda_available"))
    uses_torch_cuda_runtime = "toriigate" in model_key
    has_any_gpu_provider = has_cuda_provider or has_dml_provider or (uses_torch_cuda_runtime and torch_cuda_available)

    if use_gpu is None:
        use_gpu = has_gpu and has_any_gpu_provider
    else:
        use_gpu = bool(use_gpu and has_gpu and has_any_gpu_provider)

    ram_gb = system_info.get("total_ram_gb") or 8
    available_ram_gb = system_info.get("available_ram_gb") or ram_gb
    available_vram_mb = system_info.get("gpu_vram_available_mb") or vram_mb
    model_config = TAGGER_MODELS.get(model_key, {})
    is_custom_model = model_key == "custom"
    runtime_backend = str(model_config.get("runtime_backend", "wd14")).lower()
    safety_tier = str(model_config.get("runtime_safety_tier") or "").strip().lower()
    if not safety_tier:
        if runtime_backend == "toriigate":
            safety_tier = "vlm"
        elif "eva02" in model_key or model_key in {"camie-tagger-v2", "pixai-tagger-v0.9"}:
            safety_tier = "heavy"
        elif model_key == "wd-vit-tagger-v3":
            safety_tier = "light"
        else:
            safety_tier = "balanced"

    def apply_gpu_model_cap(batch_size_value: int) -> int:
        if is_custom_model:
            usable_vram_mb = available_vram_mb if available_vram_mb is not None else vram_mb
            if usable_vram_mb is None or usable_vram_mb < 6000:
                return min(batch_size_value, 2)
            if usable_vram_mb < 10000:
                return min(batch_size_value, 4)
            return min(batch_size_value, 8)
        if safety_tier == "vlm":
            return 1
        if safety_tier != "heavy":
            return batch_size_value

        usable_vram_mb = available_vram_mb if available_vram_mb is not None else vram_mb
        if usable_vram_mb is None:
            usable_vram_mb = vram_mb

        if usable_vram_mb is None or usable_vram_mb < 4000:
            return min(batch_size_value, 2)
        if usable_vram_mb < 8000:
            return min(batch_size_value, 4)
        if usable_vram_mb < 12000:
            return min(batch_size_value, 6)
        if usable_vram_mb < 16000:
            return min(batch_size_value, 8)
        if usable_vram_mb < 24000:
            return min(batch_size_value, 12)
        return min(batch_size_value, 16)

    def apply_cpu_model_cap(batch_size_value: int) -> int:
        if is_custom_model:
            if available_ram_gb < 10:
                return min(batch_size_value, 2)
            if available_ram_gb < 18:
                return min(batch_size_value, 4)
            return min(batch_size_value, 8)
        if safety_tier == "vlm":
            return 1
        if safety_tier != "heavy":
            return batch_size_value

        if available_ram_gb < 8:
            return min(batch_size_value, 2)
        if available_ram_gb < 12:
            return min(batch_size_value, 4)
        if available_ram_gb < 20:
            return min(batch_size_value, 6)
        if available_ram_gb < 32:
            return min(batch_size_value, 8)
        return min(batch_size_value, 10)

    if use_gpu and vram_mb is not None:
        if available_vram_mb is not None and available_vram_mb < 2500:
            batch_size = 2
        elif vram_mb < 4000:
            batch_size = 4
        elif vram_mb < 8000:
            batch_size = 8
        elif vram_mb < 12000:
            batch_size = 12
        elif vram_mb < 16000:
            batch_size = 16
        elif vram_mb < 24000:
            batch_size = 24
        else:
            batch_size = 32
        batch_size = max(1, apply_gpu_model_cap(batch_size))
    else:
        # CPU / fallback runtimes: still keep a safety margin, but avoid tiny defaults on
        # modern 16-32GB desktops where users expect faster throughput.
        if available_ram_gb < 8:
            batch_size = 4
        elif available_ram_gb < 12:
            batch_size = 6
        elif available_ram_gb < 20:
            batch_size = 10
        elif available_ram_gb < 32:
            batch_size = 14
        else:
            batch_size = 18

        total_ram_gb = system_info.get("total_ram_gb") or available_ram_gb
        if total_ram_gb >= 24 and available_ram_gb >= 4:
            batch_size = max(batch_size, 8)
        batch_size = max(1, apply_cpu_model_cap(batch_size))

    session_refresh_interval = 180 if use_gpu else 0

    # Determine risk level
    if use_gpu:
        if (vram_mb is not None and vram_mb < 4000) or (available_vram_mb is not None and available_vram_mb < 2000):
            risk_level = "high"
        elif (vram_mb is not None and vram_mb < 8000) or (available_vram_mb is not None and available_vram_mb < 4000):
            risk_level = "medium"
        else:
            risk_level = "low"
    else:
        risk_level = "low"

    # Build message
    parts = []
    if use_gpu:
        if has_cuda_provider:
            runtime_label = "CUDA"
        elif has_dml_provider:
            runtime_label = "DirectML"
        elif uses_torch_cuda_runtime and torch_cuda_available:
            runtime_label = "CUDA (Torch)"
        else:
            runtime_label = "GPU"
        vram_fragment = f" ({int(vram_mb)}MB VRAM)" if vram_mb is not None else ""
        parts.append(f"{runtime_label} GPU detected: {gpu_name}{vram_fragment}.")
        if risk_level == "high":
            parts.append("VRAM headroom is tight right now. Auto runtime lowered the true batch size and kept session refresh enabled.")
        elif risk_level == "medium":
            parts.append("Moderate VRAM headroom. Auto runtime is using a balanced true batch size.")
        else:
            parts.append("Sufficient VRAM for aggressive batched GPU inference.")
    else:
        if system_info.get("onnxruntime_conflict"):
            parts.append(
                "Both onnxruntime and onnxruntime-gpu are installed. "
                "On Windows the launcher should keep only onnxruntime-gpu (NVIDIA) "
                "or onnxruntime-directml (Intel / AMD)."
            )
            parts.append("Running on CPU until the package state is repaired.")
        elif has_gpu and not (has_cuda_provider or has_dml_provider):
            parts.append(
                f"GPU detected ({gpu_name}) but no GPU execution provider is available in ONNX Runtime. "
                "Install onnxruntime-gpu for NVIDIA or onnxruntime-directml for Intel / AMD."
            )
            parts.append("Running on CPU.")
        else:
            parts.append("No GPU detected. Running on CPU.")

    extra_devices = [
        device.get("name")
        for device in (system_info.get("gpu_devices") or [])
        if device.get("name") and device.get("name") != gpu_name
    ]
    if extra_devices:
        parts.append("Also detected: " + ", ".join(extra_devices[:3]) + ".")
    if is_custom_model:
        parts.append(
            "Custom ONNX models stay on a conservative starting chunk until the model proves stable on this machine."
        )
    message = " ".join(parts)

    return {
        "recommended_batch_size": batch_size,
        "recommended_cpu_chunk_size": min(32, max(1, batch_size)),
        "recommended_use_gpu": use_gpu,
        "recommended_session_refresh_interval": session_refresh_interval,
        "risk_level": risk_level,
        "message": message,
        "runtime_safety_tier": safety_tier,
    }


def check_memory_pressure() -> Dict[str, Any]:
    """
    Check current memory pressure (RAM and VRAM).

    Returns a dictionary with:
    - ram_available_gb: float or None
    - ram_total_gb: float or None
    - ram_percent_used: float or None
    - vram_available_mb: float or None (None if no GPU)
    - vram_percent_used: float or None (None if no GPU)
    - should_pause: bool (True when mem.percent >= 95, relative to total RAM)
    - should_restart_session: bool (True when VRAM available < 500MB and GPU is in use)
    """
    result: Dict[str, Any] = {
        "ram_available_gb": None,
        "ram_total_gb": None,
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
        result["ram_total_gb"] = round(mem.total / (1024 ** 3), 2)
        result["ram_percent_used"] = mem.percent
        # Pressure is relative to total, not absolute. A 32 GB box with 1.5 GB
        # free is fine; a 4 GB box with 1.5 GB free is fine too. Both at 95%+
        # used are actually tight.
        if mem.percent >= 95.0:
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
