from __future__ import annotations

import subprocess

import repair_torch_runtime


def test_cuda_index_candidates_follow_driver_cap():
    assert repair_torch_runtime._cuda_index_candidates((12, 4))[0][0] == "cu124"
    assert repair_torch_runtime._cuda_index_candidates((12, 0))[0][0] == "cu121"
    assert repair_torch_runtime._cuda_index_candidates(None)[0][0] == "cu128"


def test_non_windows_does_not_run_pip(monkeypatch):
    pip_calls = []
    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Linux")
    monkeypatch.setattr(repair_torch_runtime, "_run_pip", lambda args, stream=False: pip_calls.append(args))
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe",
        lambda: {"torch_version": "2.11.0+cpu", "torchvision_version": "0.26.0", "torch_cuda_build": None, "torch_cuda_available": False},
    )
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: ["sam3==0.1.3"])

    result = repair_torch_runtime.repair_windows_torch_runtime()

    assert result["repaired"] is False
    assert pip_calls == []


def test_amd_windows_keeps_standard_torch(monkeypatch):
    pip_calls = []
    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(repair_torch_runtime, "_detect_gpu_vendor", lambda: {"primary": "amd", "vendors": ["amd"], "devices": []})
    monkeypatch.setattr(repair_torch_runtime, "_run_pip", lambda args, stream=False: pip_calls.append(args))
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe",
        lambda: {"torch_version": "2.11.0+cpu", "torchvision_version": "0.26.0", "torch_cuda_build": None, "torch_cuda_available": False},
    )
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: ["sam3==0.1.3"])

    result = repair_torch_runtime.repair_windows_torch_runtime()

    assert result["repaired"] is False
    assert "No NVIDIA GPU detected" in result["actions"][0]
    assert pip_calls == []


def test_nvidia_cpu_torch_installs_cuda_torch_and_sam3_runtime(monkeypatch):
    pip_calls = []
    probe_results = iter(
        [
            {"torch_version": "2.11.0+cpu", "torchvision_version": "0.26.0", "torch_cuda_build": None, "torch_cuda_available": False},
            {"torch_version": "2.11.0+cu128", "torchvision_version": "0.26.0", "torch_cuda_build": "12.8", "torch_cuda_available": True},
            {"torch_version": "2.11.0+cu128", "torchvision_version": "0.26.0", "torch_cuda_build": "12.8", "torch_cuda_available": True},
        ]
    )

    def fake_run_pip(args, stream=False):
        pip_calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(repair_torch_runtime, "_detect_gpu_vendor", lambda: {"primary": "nvidia", "vendors": ["nvidia"], "devices": []})
    monkeypatch.setattr(repair_torch_runtime, "_detect_nvidia_cuda_version", lambda: (12, 8))
    monkeypatch.setattr(repair_torch_runtime, "_torch_probe", lambda: next(probe_results))
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: ["sam3==0.1.3", "einops"])
    monkeypatch.setattr(repair_torch_runtime, "_run_pip", fake_run_pip)

    result = repair_torch_runtime.repair_windows_torch_runtime()

    assert result["repaired"] is True
    assert any("torch==2.11.0" in call for call in pip_calls[0])
    assert "--index-url" in pip_calls[0]
    assert "https://download.pytorch.org/whl/cu128" in pip_calls[0]
    assert "sam3==0.1.3" in pip_calls[1]
    assert "einops" in pip_calls[1]
