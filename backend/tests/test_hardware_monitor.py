"""Regression tests for hardware_monitor.py — VRAM detection and batch sizing."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from hardware_monitor import (  # noqa: E402
    WMI_ADAPTER_RAM_CAP_MB,
    _detect_windows_gpu_devices,
    recommend_tagger_config,
)


def _fake_nvidia_smi_ok(*_args, **_kwargs):
    # name, memory.total, memory.free (MB)
    return "NVIDIA GeForce RTX 3090, 24576, 21617\n"


def _fake_powershell_3090_capped(*_args, **_kwargs):
    # Win32_VideoController reports AdapterRAM capped at 4 GB for any GPU with ≥4 GB.
    return (
        '[{"Name":"NVIDIA GeForce RTX 3090","AdapterRAM":4293918720,"PNPDeviceID":"PCI\\\\VEN_10DE"},'
        '{"Name":"Intel(R) UHD Graphics 770","AdapterRAM":2147483648,"PNPDeviceID":"PCI\\\\VEN_8086"}]'
    )


def test_nvidia_smi_overrides_wmi_4gb_cap():
    """RTX 3090's 24 GB VRAM must not be truncated to 4 GB by WMI AdapterRAM cap."""
    with patch("hardware_monitor.platform.system", return_value="Windows"), patch(
        "hardware_monitor.subprocess.check_output"
    ) as mock_check:
        def route(cmd, *args, **kwargs):
            if cmd and "nvidia-smi" in str(cmd[0]):
                return _fake_nvidia_smi_ok()
            if cmd and cmd[0] == "powershell":
                return _fake_powershell_3090_capped()
            raise FileNotFoundError

        mock_check.side_effect = route
        devices = _detect_windows_gpu_devices()

    nvidia = next(d for d in devices if d["vendor"] == "nvidia")
    # Without nvidia-smi overlay, WMI would have reported ~4095 MB.
    assert nvidia["vram_total_mb"] == 24576, (
        f"Expected 24 GB for RTX 3090, got {nvidia['vram_total_mb']} MB "
        f"(WMI cap is {WMI_ADAPTER_RAM_CAP_MB} MB)"
    )
    assert nvidia["vram_available_mb"] == 21617


def test_rtx_3090_recommendation_uses_aggressive_batch():
    """With 24 GB VRAM visible, batch size should be 64, not a toy-sized chunk."""
    info = {
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": 21617,
        "torch_cuda_available": False,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 32,
        "available_ram_gb": 20,
        "gpu_devices": [
            {"name": "NVIDIA GeForce RTX 3090", "vendor": "nvidia", "vram_total_mb": 24576}
        ],
    }
    rec = recommend_tagger_config(info, model_name="wd-swinv2-tagger-v3")
    assert rec["recommended_batch_size"] == 64
    assert rec["recommended_use_gpu"] is True
    assert rec["risk_level"] == "low"


def test_capped_vram_still_recommends_small_batch():
    """If nvidia-smi is unavailable, the 4 GB-capped value should still be safe."""
    info = {
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": 4095,
        "gpu_vram_available_mb": 4095,
        "torch_cuda_available": False,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 32,
        "available_ram_gb": 20,
        "gpu_devices": [
            {"name": "NVIDIA GeForce RTX 3090", "vendor": "nvidia", "vram_total_mb": 4095}
        ],
    }
    rec = recommend_tagger_config(info, model_name="wd-swinv2-tagger-v3")
    # 4 GB reports a small-but-not-crippled chunk; adaptive backoff still catches real OOM.
    assert rec["recommended_batch_size"] == 12


def test_heavy_models_are_capped_below_balanced_models_on_same_gpu():
    info = {
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": 21617,
        "torch_cuda_available": False,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 32,
        "available_ram_gb": 20,
        "gpu_devices": [
            {"name": "NVIDIA GeForce RTX 3090", "vendor": "nvidia", "vram_total_mb": 24576}
        ],
    }

    balanced = recommend_tagger_config(info, model_name="wd-swinv2-tagger-v3")
    heavy = recommend_tagger_config(info, model_name="wd-eva02-large-tagger-v3")

    assert balanced["recommended_batch_size"] == 64
    assert heavy["recommended_batch_size"] == 48
    assert heavy["runtime_safety_tier"] == "heavy"


def test_heavy_models_use_real_throughput_on_midrange_gpus():
    """A 16 GB card should not be stuck at chunk 12 for long WD14 runs."""
    info = {
        "gpu_name": "NVIDIA GeForce RTX 4080 Laptop GPU",
        "gpu_vram_total_mb": 16384,
        "gpu_vram_available_mb": 14500,
        "torch_cuda_available": False,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 32,
        "available_ram_gb": 18,
        "gpu_devices": [
            {"name": "NVIDIA GeForce RTX 4080 Laptop GPU", "vendor": "nvidia", "vram_total_mb": 16384}
        ],
    }

    balanced = recommend_tagger_config(info, model_name="wd-swinv2-tagger-v3")
    heavy = recommend_tagger_config(info, model_name="wd-eva02-large-tagger-v3")

    assert balanced["recommended_batch_size"] == 48
    assert heavy["recommended_batch_size"] == 32


def test_heavy_models_still_downshift_when_free_vram_is_actually_tight():
    info = {
        "gpu_name": "NVIDIA GeForce RTX 4090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": 3500,
        "torch_cuda_available": False,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 64,
        "available_ram_gb": 40,
        "gpu_devices": [
            {"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia", "vram_total_mb": 24576}
        ],
    }

    rec = recommend_tagger_config(info, model_name="wd-eva02-large-tagger-v3")

    assert rec["recommended_batch_size"] == 4


def test_cpu_high_ram_recommendation_is_not_artificially_tiny():
    info = {
        "gpu_name": None,
        "gpu_vram_total_mb": None,
        "gpu_vram_available_mb": None,
        "torch_cuda_available": False,
        "onnx_providers": ["CPUExecutionProvider"],
        "total_ram_gb": 64,
        "available_ram_gb": 40,
        "gpu_devices": [],
    }

    balanced = recommend_tagger_config(info, model_name="wd-swinv2-tagger-v3", use_gpu=False)
    heavy = recommend_tagger_config(info, model_name="wd-eva02-large-tagger-v3", use_gpu=False)

    assert balanced["recommended_batch_size"] == 32
    assert heavy["recommended_batch_size"] == 24
    assert balanced["recommended_cpu_chunk_size"] == 32
    assert heavy["recommended_cpu_chunk_size"] == 24


def test_toriigate_stays_fixed_chunk_one_even_on_large_gpus():
    info = {
        "gpu_name": "NVIDIA GeForce RTX 4090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": 22000,
        "torch_cuda_available": True,
        "onnx_providers": ["CPUExecutionProvider"],
        "total_ram_gb": 64,
        "available_ram_gb": 40,
        "gpu_devices": [
            {"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia", "vram_total_mb": 24576}
        ],
    }

    rec = recommend_tagger_config(info, model_name="toriigate-0.5", use_gpu=True)

    assert rec["recommended_batch_size"] == 1
    assert rec["runtime_safety_tier"] == "vlm"


def test_custom_model_gpu_recommendation_stays_conservative_on_large_gpus():
    info = {
        "gpu_name": "NVIDIA GeForce RTX 4090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": 22000,
        "torch_cuda_available": False,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 64,
        "available_ram_gb": 40,
        "gpu_devices": [
            {"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia", "vram_total_mb": 24576}
        ],
    }

    rec = recommend_tagger_config(info, model_name="custom", use_gpu=True)

    assert rec["recommended_batch_size"] == 8
    assert "Custom ONNX models stay on a conservative starting chunk" in rec["message"]


def _fake_powershell_dual_nvidia_capped(*_args, **_kwargs):
    # WMI returns RTX 3060 first, then RTX 3090 — reversed from nvidia-smi below.
    return (
        '[{"Name":"NVIDIA GeForce RTX 3060","AdapterRAM":4293918720,"PNPDeviceID":"PCI\\\\VEN_10DE_1"},'
        '{"Name":"NVIDIA GeForce RTX 3090","AdapterRAM":4293918720,"PNPDeviceID":"PCI\\\\VEN_10DE_2"}]'
    )


def _fake_nvidia_smi_dual_ordered(*_args, **_kwargs):
    # nvidia-smi reports RTX 3090 first (NVML/CUDA order).
    return (
        "NVIDIA GeForce RTX 3090, 24576, 21617\n"
        "NVIDIA GeForce RTX 3060, 12288, 11000\n"
    )


def test_dual_nvidia_matches_by_name_not_index():
    """Dual-NVIDIA rigs must match VRAM to the correct card by name, not by enumeration order."""
    with patch("hardware_monitor.platform.system", return_value="Windows"), patch(
        "hardware_monitor.subprocess.check_output"
    ) as mock_check:
        def route(cmd, *_a, **_kw):
            if cmd and "nvidia-smi" in str(cmd[0]):
                return _fake_nvidia_smi_dual_ordered()
            if cmd and cmd[0] == "powershell":
                return _fake_powershell_dual_nvidia_capped()
            raise FileNotFoundError

        mock_check.side_effect = route
        devices = _detect_windows_gpu_devices()

    by_name = {d["name"]: d for d in devices if d["vendor"] == "nvidia"}
    assert by_name["NVIDIA GeForce RTX 3090"]["vram_total_mb"] == 24576, (
        "RTX 3090 should get nvidia-smi's 24 GB reading, not RTX 3060's 12 GB"
    )
    assert by_name["NVIDIA GeForce RTX 3060"]["vram_total_mb"] == 12288, (
        "RTX 3060 should get nvidia-smi's 12 GB reading, not RTX 3090's 24 GB"
    )
    assert by_name["NVIDIA GeForce RTX 3090"]["vram_available_mb"] == 21617
    assert by_name["NVIDIA GeForce RTX 3060"]["vram_available_mb"] == 11000


def test_non_nvidia_devices_do_not_receive_smi_overlay():
    """Intel/AMD-only rigs must not have nvidia-smi values leak onto their entries."""
    def _fake_powershell_intel_only(*_a, **_kw):
        return '[{"Name":"Intel(R) UHD Graphics 770","AdapterRAM":2147483648,"PNPDeviceID":"PCI\\\\VEN_8086"}]'

    with patch("hardware_monitor.platform.system", return_value="Windows"), patch(
        "hardware_monitor.subprocess.check_output"
    ) as mock_check:
        def route(cmd, *_a, **_kw):
            if cmd and "nvidia-smi" in str(cmd[0]):
                # Even if a leftover NVIDIA driver responds, Intel/AMD devices must stay clean.
                return "NVIDIA GeForce RTX 3090, 24576, 21617\n"
            if cmd and cmd[0] == "powershell":
                return _fake_powershell_intel_only()
            raise FileNotFoundError

        mock_check.side_effect = route
        devices = _detect_windows_gpu_devices()

    intel = next(d for d in devices if d["vendor"] == "intel")
    assert intel["vram_total_mb"] == 2048, "Intel iGPU should keep its own 2 GB reading"
    assert intel.get("vram_available_mb") is None, "nvidia-smi free-memory must not leak to Intel device"
