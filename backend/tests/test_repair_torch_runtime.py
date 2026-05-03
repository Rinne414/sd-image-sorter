from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

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


def test_sys_path_bootstrap_handles_embedded_python_layout(tmp_path):
    """Regression test for the embedded Python sys.path bug.

    The portable Windows launcher uses an embedded Python distribution
    whose ``python312._pth`` file fully controls ``sys.path`` and does
    NOT auto-prepend the running script's directory. Without the manual
    ``sys.path`` bootstrap at the top of ``repair_torch_runtime.py``,
    the module-level ``from repair_onnxruntime import _detect_gpu_vendor``
    silently fails, ``_detect_gpu_vendor`` falls back to the empty stub
    ({"vendors": [], "primary": None, "devices": []}), and CUDA torch
    is never installed for NVIDIA users.

    This test simulates the embedded layout by spawning a subprocess
    where:
      - the ``backend/`` directory is removed from ``sys.path``
      - ``PYTHONPATH`` is cleared so it cannot accidentally re-add it
      - the project root is added (so ``backend.repair_torch_runtime``
        is importable as a package member, mirroring how subprocess
        invocation lands the launcher in production)

    If the bootstrap is missing, the import will quietly use the
    fallback stub. We detect that by inspecting the ``__module__``
    attribute of ``_detect_gpu_vendor``: when imported from the real
    sibling module it equals ``"repair_onnxruntime"``; when the
    fallback is used it equals ``"repair_torch_runtime"``.
    """
    repair_script = Path(repair_torch_runtime.__file__).resolve()
    backend_dir = repair_script.parent
    project_root = backend_dir.parent

    backend_norm = str(backend_dir).replace("\\", "/").rstrip("/").lower()

    snippet = (
        "import sys\n"
        # Strip backend dir from sys.path so the embedded-Python condition holds.
        f"backend_norm = {backend_norm!r}\n"
        "sys.path = ["
        "  p for p in sys.path "
        "  if p.replace(chr(92), '/').rstrip('/').lower() != backend_norm"
        "]\n"
        # Add project root so backend can be imported as a package.
        f"sys.path.insert(0, {str(project_root)!r})\n"
        # Import via the package path — this mimics ``python backend\\script.py``
        # in embedded Python, where the script-dir-on-sys.path rule is bypassed.
        "from backend import repair_torch_runtime as rtr\n"
        # Verify the bootstrap re-added backend dir to sys.path.
        "added = any("
        "  p.replace(chr(92), '/').rstrip('/').lower() == backend_norm "
        "  for p in sys.path"
        ")\n"
        "print('BOOTSTRAP_OK' if added else 'BOOTSTRAP_MISSING')\n"
        # Verify the real ``_detect_gpu_vendor`` from repair_onnxruntime was
        # imported (not the empty fallback defined inside repair_torch_runtime).
        "module_name = rtr._detect_gpu_vendor.__module__\n"
        "print('REAL_DETECTOR' if module_name == 'repair_onnxruntime' "
        "else 'FALLBACK_DETECTOR_' + module_name)\n"
    )

    env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}

    completed = subprocess.run(
        [sys.executable, "-c", snippet],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
        env=env,
        timeout=60,
    )

    assert completed.returncode == 0, (
        f"Subprocess failed.\nSTDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
    )
    assert "BOOTSTRAP_OK" in completed.stdout, (
        "sys.path bootstrap missing in repair_torch_runtime.py — embedded "
        "Python layout will fail to find sibling repair_onnxruntime module.\n"
        f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
    )
    assert "REAL_DETECTOR" in completed.stdout, (
        "_detect_gpu_vendor resolved to the empty fallback stub. NVIDIA users "
        "would never get CUDA torch installed in production.\n"
        f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
    )


def test_detect_nvidia_cuda_version_uses_marker_not_driver_version(monkeypatch):
    """Regression test: do not confuse Driver Version with CUDA Version.

    ``nvidia-smi`` header output looks like::

        NVIDIA-SMI 591.86   Driver Version: 591.86   CUDA Version: 13.1

    Earlier code used a plain ``\\d+\\.\\d+`` regex which matched the
    driver version (591.86) before the CUDA version (13.1). On RTX 3090
    machines the wrong value happened to satisfy ``<= max_cuda`` checks
    so cu128 was installed by accident, but on older NVIDIA hardware the
    bug could pick a CUDA wheel that does not load.
    """
    smi_header_output = (
        "Sun May  3 10:04:11 2026\n"
        "+-----------------------------------------------------------------+\n"
        "| NVIDIA-SMI 591.86   Driver Version: 591.86   CUDA Version: 13.1 |\n"
        "+-----------------------------------------------------------------+\n"
    )
    smi_query_unsupported = 'Field "cuda_version" is not a valid field to query.\n'

    call_log = []

    def fake_check_output(command, **kwargs):
        call_log.append(tuple(command))
        if "--query-gpu=cuda_version" in command:
            return smi_query_unsupported
        return smi_header_output

    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(repair_torch_runtime.subprocess, "check_output", fake_check_output)

    result = repair_torch_runtime._detect_nvidia_cuda_version()

    assert result == (13, 1), (
        f"Parser must return CUDA version (13, 1), not driver version. Got: {result!r}\n"
        f"Subprocess call log: {call_log}"
    )


def test_detect_nvidia_cuda_version_uses_query_when_supported(monkeypatch):
    """When ``nvidia-smi --query-gpu=cuda_version`` works, use its output directly."""
    call_log = []

    def fake_check_output(command, **kwargs):
        call_log.append(tuple(command))
        if "--query-gpu=cuda_version" in command:
            return "12.4\n"
        raise AssertionError("Should not fall through to full nvidia-smi when query works")

    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(repair_torch_runtime.subprocess, "check_output", fake_check_output)

    result = repair_torch_runtime._detect_nvidia_cuda_version()

    assert result == (12, 4)
    assert len(call_log) == 1, f"Should not invoke full nvidia-smi when query path succeeds. Calls: {call_log}"
