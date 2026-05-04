from __future__ import annotations

import subprocess

import repair_onnxruntime


def test_run_pip_streams_launcher_progress(monkeypatch, capsys):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(repair_onnxruntime.subprocess, "run", fake_run)

    repair_onnxruntime._run_pip(["install", "example-package"], stream=True)

    assert calls == [
        (
            [
                repair_onnxruntime.sys.executable,
                "-m",
                "pip",
                "--disable-pip-version-check",
                "install",
                "example-package",
            ],
            {"check": True, "text": True},
        )
    ]
    assert "python -m pip --disable-pip-version-check install example-package" in capsys.readouterr().out


def test_repair_prints_cuda_runtime_action_before_long_install(monkeypatch, capsys):
    install_state = {
        "platform": "Windows",
        "python": repair_onnxruntime.sys.executable,
        "onnxruntime_version": None,
        "onnxruntime_gpu_version": "1.21.0",
        "onnxruntime_directml_version": None,
        "has_conflict": False,
        "has_gpu_package": True,
        "has_dml_package": False,
        "gpu_vendor_primary": "nvidia",
        "gpu_vendors_detected": ["nvidia"],
        "gpu_devices": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia"}],
    }
    pip_calls = []

    def fake_version(dist_name: str):
        versions = {
            "onnxruntime-gpu": "1.21.0",
            "nvidia-cudnn-cu12": None,
        }
        return versions.get(dist_name)

    def fake_run_pip(args, *, stream=False):
        pip_calls.append((args, stream))
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(repair_onnxruntime, "get_install_state", lambda: dict(install_state))
    monkeypatch.setattr(repair_onnxruntime, "_version", fake_version)
    monkeypatch.setattr(repair_onnxruntime, "_run_pip", fake_run_pip)
    monkeypatch.setattr(repair_onnxruntime, "_probe_ort_providers", lambda: ["CUDAExecutionProvider"])

    result = repair_onnxruntime.repair_windows_onnxruntime(stream_pip=True)

    assert pip_calls == [
        (
            ["install", "--no-warn-script-location", "onnxruntime-gpu[cuda,cudnn]==1.21.0"],
            True,
        )
    ]
    assert result["repaired"] is True
    assert "Installing CUDA 12 + cuDNN 9 runtime DLLs" in capsys.readouterr().out
