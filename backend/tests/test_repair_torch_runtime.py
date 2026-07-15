from __future__ import annotations

import os
import subprocess
import sys
import traceback
from pathlib import Path

import pytest

import repair_torch_runtime


def test_cuda_index_candidates_follow_driver_cap():
    assert repair_torch_runtime._cuda_index_candidates((13, 0))[0][0] == "cu130"
    assert repair_torch_runtime._cuda_index_candidates((12, 9))[0][0] == "cu126"
    assert repair_torch_runtime._cuda_index_candidates((12, 8))[0][0] == "cu126"
    assert repair_torch_runtime._cuda_index_candidates((12, 4)) == []
    assert repair_torch_runtime._cuda_index_candidates((12, 0)) == []
    assert repair_torch_runtime._cuda_index_candidates(None) == []


def test_custom_cuda_index_preserves_secure_wheel_label(monkeypatch):
    url = "https://mirror.example/pytorch-wheels/cu126"
    monkeypatch.setenv("SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL", url)

    assert repair_torch_runtime._cuda_index_candidates((12, 6)) == [
        ("cu126", url, (12, 6)),
    ]


def test_custom_cuda_index_respects_driver_cap(monkeypatch):
    monkeypatch.setenv(
        "SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL",
        "https://mirror.example/pytorch-wheels/cu130",
    )

    with pytest.raises(
        ValueError,
        match=r"requires CUDA 13\.0.*reports CUDA 12\.6",
    ):
        repair_torch_runtime._cuda_index_candidates((12, 6))


def test_custom_cuda_index_rejects_url_without_supported_label(monkeypatch):
    monkeypatch.setenv(
        "SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL",
        "https://user:secret@mirror.example/pytorch-wheels/custom",
    )

    with pytest.raises(ValueError, match="cu130 or cu126") as exc_info:
        repair_torch_runtime._cuda_index_candidates((13, 0))

    message = str(exc_info.value)
    assert "https://***@mirror.example/pytorch-wheels/custom" in message
    assert "user:secret" not in message


def test_cuda_index_candidates_rewrite_host_when_mirror_selected(monkeypatch):
    """If mirror_selector picks tuna/sjtu, the cuXXX URLs must use that host
    instead of download.pytorch.org. Tests the wiring that makes Chinese
    users see 60 MB/s instead of 1 MB/s on the 2.5 GB CUDA torch wheel.
    """
    monkeypatch.setattr(
        repair_torch_runtime,
        "_resolve_torch_cuda_host",
        lambda: "https://mirrors.tuna.tsinghua.edu.cn/pytorch-wheels",
    )
    candidates = repair_torch_runtime._cuda_index_candidates((12, 8))
    assert candidates[0][0] == "cu126"

    assert candidates[0][1] == "https://mirrors.tuna.tsinghua.edu.cn/pytorch-wheels/cu126"
    labels = [c[0] for c in candidates]
    urls = [c[1] for c in candidates]
    for label, url in zip(labels, urls):
        assert url == f"https://mirrors.tuna.tsinghua.edu.cn/pytorch-wheels/{label}"


def test_cuda_index_candidates_official_host_keeps_pinned_urls_untouched(monkeypatch):
    """The official host must keep the highest compatible pinned URL."""
    monkeypatch.setattr(
        repair_torch_runtime,
        "_resolve_torch_cuda_host",
        lambda: "https://download.pytorch.org/whl",
    )
    candidates = repair_torch_runtime._cuda_index_candidates((13, 0))
    assert candidates == [repair_torch_runtime.TORCH_CUDA_INDEXES[0]]


def test_cuda_package_versions_match_official_wheel_matrix():
    assert repair_torch_runtime._cuda_package_versions("cu130") == ("2.13.0", "0.28.0")
    assert repair_torch_runtime._cuda_package_versions("cu126") == ("2.13.0", "0.28.0")
    assert set(repair_torch_runtime.TORCH_CUDA_PACKAGE_VERSIONS) == {"cu130", "cu126"}


def test_supported_cuda_state_requires_release_pair_and_available_device():
    state = {
        "torch_version": "2.13.0+cu126",
        "torchvision_version": "0.28.0+cu126",
        "torch_cuda_build": "12.6",
        "torch_cuda_available": True,
    }

    assert repair_torch_runtime._is_supported_cuda_torch_state(state) is True
    assert repair_torch_runtime._is_supported_cuda_torch_state(
        {**state, "torch_version": "2.9.1+cu128"}
    ) is False
    assert repair_torch_runtime._is_supported_cuda_torch_state(
        {**state, "torch_cuda_available": False}
    ) is False
    assert repair_torch_runtime._is_supported_cuda_torch_state(
        {
            **state,
            "torch_version": "2.13.0+cu130",
            "torch_cuda_build": "13.0",
        }
    ) is False


def test_non_windows_does_not_run_pip(monkeypatch):
    pip_calls = []
    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Linux")
    monkeypatch.setattr(repair_torch_runtime, "_run_pip", lambda args, stream=False: pip_calls.append(args))
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe",
        lambda: {"torch_version": "2.11.0+cpu", "torchvision_version": "0.26.0", "torch_cuda_build": None, "torch_cuda_available": False},
    )
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: ["transformers>=5.6.0"])

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
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: ["transformers>=5.6.0"])

    result = repair_torch_runtime.repair_windows_torch_runtime()

    assert result["repaired"] is False
    assert "No NVIDIA GPU detected" in result["actions"][0]
    assert pip_calls == []


def test_nvidia_cpu_torch_installs_cuda_torch_and_sam3_runtime(monkeypatch):
    pip_calls = []
    probe_results = iter(
        [
            {"torch_version": "2.13.0+cpu", "torchvision_version": "0.28.0", "torch_cuda_build": None, "torch_cuda_available": False},
            {"torch_version": "2.13.0+cu126", "torchvision_version": "0.28.0", "torch_cuda_build": "12.6", "torch_cuda_available": True},
        ]
    )

    def fake_run_pip(args, stream=False):
        pip_calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(repair_torch_runtime, "_detect_gpu_vendor", lambda: {"primary": "nvidia", "vendors": ["nvidia"], "devices": []})
    monkeypatch.setattr(repair_torch_runtime, "_detect_nvidia_cuda_version", lambda: (12, 8))
    monkeypatch.setattr(repair_torch_runtime, "_torch_probe", lambda: next(probe_results))
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {"torch_version": "2.13.0+cu126", "torchvision_version": "0.28.0+cu126", "torch_cuda_build": "12.6", "torch_cuda_available": True, "torch_probe_error": None},
    )
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: ["transformers>=5.6.0", "safetensors"])
    monkeypatch.setattr(repair_torch_runtime, "_run_pip", fake_run_pip)

    result = repair_torch_runtime.repair_windows_torch_runtime()

    assert result["repaired"] is True
    # pip_calls layout after the pinned-CUDA fix:
    #   [0] numpy<2.0 (3.12) or numpy>=2.1 (3.13) from PyPI pre-install,
    #       kept outside the cu-index call so the cu-index step stays single-source
    #   [1] torch==X.Y.Z+cuXXX from the cu-specific index (no extra-index-url)
    #   [2] SAM3 runtime (transformers, safetensors, …) from PyPI
    assert repair_torch_runtime._numpy_sam3_constraint() in pip_calls[0]
    assert pip_calls[1] is not pip_calls[0]
    assert any("torch==2.13.0+cu126" in call for call in pip_calls[1]), (
        "CUDA torch must be pinned with the +cuXXX local-version label so "
        "pip cannot silently fall back to PyPI's CPU torch wheel when the "
        "CUDA index has a transient network glitch."
    )
    assert "--index-url" in pip_calls[1]
    assert "https://download.pytorch.org/whl/cu126" in pip_calls[1]
    # Regression guard: the CUDA install must NOT use --extra-index-url.
    # Pre-fix, ``--extra-index-url https://pypi.org/simple`` let pip pick
    # the CPU ``torch==2.13.0`` wheel from PyPI whenever the CUDA index
    # download was interrupted. Now the cu-specific index is the ONLY
    # source, and the +cuXXX local-version label guarantees no PyPI wheel
    # could match anyway.
    assert "--extra-index-url" not in pip_calls[1], (
        "CUDA torch install must NOT use --extra-index-url. Combined with "
        "an ``IncompleteRead`` on download.pytorch.org, that previously "
        "let pip silently fall back to PyPI's CPU torch wheel."
    )
    # Regression guard: without ``--no-deps``, torch's force-reinstall
    # cascades through sympy, jinja2, markupsafe, setuptools, pillow, etc.
    # — uninstalling and reinstalling each in place. That's pure noise on
    # first launch and confuses users into thinking the install is broken.
    assert "--no-deps" in pip_calls[1], (
        "CUDA torch reinstall must use --no-deps so torch's transitive "
        "dependencies are not uninstalled and reinstalled needlessly."
    )
    assert "transformers>=5.6.0" in pip_calls[2]
    assert "safetensors" in pip_calls[2]
    assert "sam3==0.1.3" not in pip_calls[2]
    assert "decord" not in pip_calls[2]



def test_repair_upgrades_outdated_cuda_torch_to_secure_matrix(monkeypatch):
    install_calls = []
    monkeypatch.setattr(
        repair_torch_runtime,
        "get_install_state",
        lambda: {
            "platform": "Windows",
            "gpu_vendor_primary": "nvidia",
            "torch_version": "2.9.1+cu128",
            "torchvision_version": "0.24.1+cu128",
            "torch_cuda_build": "12.8",
            "torch_cuda_available": True,
            "sam3_missing_runtime_packages": [],
        },
    )
    monkeypatch.setattr(
        repair_torch_runtime,
        "_install_cuda_torch",
        lambda actions, state, stream_pip: install_calls.append(dict(state)) or True,
    )
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: [])
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {
            "torch_version": "2.13.0+cu126",
            "torchvision_version": "0.28.0+cu126",
            "torch_cuda_build": "12.6",
            "torch_cuda_available": True,
            "torch_probe_error": None,
        },
    )

    result = repair_torch_runtime.repair_windows_torch_runtime()

    assert len(install_calls) == 1
    assert result["torch_version"] == "2.13.0+cu126"

def test_cuda_install_keeps_cpu_when_driver_below_secure_cuda_floor(monkeypatch):
    pip_calls = []
    actions = []

    def fake_run_pip(args, stream=False):
        pip_calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(repair_torch_runtime, "_run_pip", fake_run_pip)
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {
            "torch_version": "2.6.0+cu124",
            "torch_cuda_build": "12.4",
            "torch_cuda_available": True,
            "torch_probe_error": None,
        },
    )

    installed = repair_torch_runtime._install_cuda_torch(
        actions,
        {
            "torch_version": "2.13.0+cpu",
            "torchvision_version": "0.28.0",
            "nvidia_cuda_version": "12.4",
        },
        stream_pip=False,
    )

    assert installed is False
    assert pip_calls == []
    assert any(
        "driver" in action.lower()
        and "update" in action.lower()
        and "12.6" in action
        for action in actions
    )


def test_cuda_install_fails_closed_when_driver_capability_is_unknown(monkeypatch):
    pip_calls = []
    actions = []

    monkeypatch.setattr(
        repair_torch_runtime,
        "_run_pip",
        lambda args, stream=False: pip_calls.append(args),
    )

    installed = repair_torch_runtime._install_cuda_torch(
        actions,
        {
            "torch_version": "2.13.0+cpu",
            "torchvision_version": "0.28.0",
            "nvidia_cuda_version": None,
        },
        stream_pip=False,
    )

    assert installed is False
    assert pip_calls == []
    assert any("could not determine" in action.lower() for action in actions)


def test_cuda_install_rejects_fresh_probe_when_cuda_is_unavailable(monkeypatch):
    pip_calls = []
    actions = []

    def fake_run_pip(args, stream=False):
        pip_calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(repair_torch_runtime, "_run_pip", fake_run_pip)
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {
            "torch_version": "2.13.0+cu126",
            "torchvision_version": "0.28.0+cu126",
            "torch_cuda_build": "12.6",
            "torch_cuda_available": False,
            "torch_probe_error": "CUDA driver is incompatible",
        },
    )

    with pytest.raises(RuntimeError, match="CUDA.*available"):
        repair_torch_runtime._install_cuda_torch(
            actions,
            {
                "torch_version": "2.13.0+cpu",
                "torchvision_version": "0.28.0",
                "nvidia_cuda_version": "12.6",
            },
            stream_pip=False,
        )

    assert len(pip_calls) == 2

def test_cuda_install_rejects_wrong_versions_after_pip(monkeypatch):
    monkeypatch.setattr(
        repair_torch_runtime,
        "_run_pip",
        lambda args, stream=False: subprocess.CompletedProcess(args, 0),
    )
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {
            "torch_version": "2.9.1+cu126",
            "torchvision_version": "0.24.1+cu126",
            "torch_cuda_build": "12.6",
            "torch_cuda_available": True,
            "torch_probe_error": None,
        },
    )

    with pytest.raises(RuntimeError, match="expected torch 2.13.0"):
        repair_torch_runtime._install_cuda_torch(
            [],
            {
                "torch_version": "2.13.0+cpu",
                "torchvision_version": "0.28.0",
                "nvidia_cuda_version": "12.6",
            },
            stream_pip=False,
        )


def test_cuda_install_stops_when_numpy_constraint_install_fails(monkeypatch):
    pip_calls = []

    def fail_numpy_install(args, stream=False):
        pip_calls.append(args)
        raise subprocess.CalledProcessError(
            1,
            args,
            output="resolver stdout",
            stderr="index unavailable",
        )

    monkeypatch.setattr(repair_torch_runtime, "_run_pip", fail_numpy_install)
    monkeypatch.setattr(
        repair_torch_runtime,
        "_resolve_pypi_fallback_index",
        lambda: "https://user:secret@mirror.example/simple",
    )

    with pytest.raises(RuntimeError, match="CUDA PyTorch was not changed") as exc_info:
        repair_torch_runtime._install_cuda_torch(
            [],
            {
                "torch_version": "2.13.0+cpu",
                "torchvision_version": "0.28.0",
                "nvidia_cuda_version": "12.6",
            },
            stream_pip=False,
        )

    assert len(pip_calls) == 1
    message = str(exc_info.value)
    assert "command=" in message
    assert "exit_code=1" in message
    assert "resolver stdout" in message
    assert "index unavailable" in message
    assert "https://***@mirror.example/simple" in message
    assert "user:secret" not in message
    formatted_traceback = "".join(traceback.format_exception(exc_info.value))
    assert "https://***@mirror.example/simple" in formatted_traceback
    assert "user:secret" not in formatted_traceback


def test_streamed_pip_command_redacts_index_credentials(monkeypatch, capsys):
    executed_commands = []

    def fake_run(command, **kwargs):
        executed_commands.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(repair_torch_runtime.subprocess, "run", fake_run)
    index_url = "https://user:secret@mirror.example/simple"

    repair_torch_runtime._run_pip(
        ["install", "--index-url", index_url, "numpy<2.0"],
        stream=True,
    )

    output = capsys.readouterr().out
    assert "https://***@mirror.example/simple" in output
    assert "user:secret" not in output
    assert index_url in executed_commands[0][0]


def test_subprocess_error_redacts_index_credentials_from_captured_output():
    error = subprocess.CalledProcessError(
        1,
        ["pip", "install", "torch"],
        output="Looking in indexes: https://user:secret@mirror.example/simple",
        stderr="Could not fetch https://token-value@mirror.example/simple/torch",
    )

    detail = repair_torch_runtime._format_subprocess_error(error)

    assert detail.count("https://***@mirror.example/simple") == 2
    assert "user:secret" not in detail
    assert "token-value" not in detail


def test_captured_pip_failure_redacts_index_credentials_before_print(monkeypatch, capsys):
    def fail_run(command, **kwargs):
        raise subprocess.CalledProcessError(
            1,
            command,
            output="Looking in indexes: https://user:secret@mirror.example/simple",
            stderr="Could not fetch https://token-value@mirror.example/simple/torch",
        )

    monkeypatch.setattr(repair_torch_runtime.subprocess, "run", fail_run)

    with pytest.raises(subprocess.CalledProcessError):
        repair_torch_runtime._run_pip(["install", "torch"], stream=False)

    captured = capsys.readouterr()
    assert "https://***@mirror.example/simple" in captured.out
    assert "https://***@mirror.example/simple/torch" in captured.err
    assert "user:secret" not in captured.out
    assert "token-value" not in captured.err


def test_cuda_install_uses_fresh_subprocess_probe_after_pip_reinstall(monkeypatch):
    pip_calls = []
    actions = []

    def fake_run_pip(args, stream=False):
        pip_calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    def stale_current_process_probe():
        raise AssertionError(
            "CUDA repair must not verify a pip-reinstalled torch wheel by reusing "
            "the current process's already-imported torch module."
        )

    monkeypatch.setattr(repair_torch_runtime, "_run_pip", fake_run_pip)
    monkeypatch.setattr(repair_torch_runtime, "_torch_probe", stale_current_process_probe)
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {"torch_version": "2.13.0+cu126", "torchvision_version": "0.28.0+cu126", "torch_cuda_build": "12.6", "torch_cuda_available": True, "torch_probe_error": None},
    )

    installed = repair_torch_runtime._install_cuda_torch(
        actions,
        {
            "torch_version": "2.13.0+cpu",
            "torchvision_version": "0.28.0",
            "nvidia_cuda_version": "12.8",
        },
        stream_pip=False,
    )

    assert installed is True
    # pip_calls[0] is the numpy ABI pre-install from PyPI (numpy<2.0 on
    # Python 3.12, numpy>=2.1 on Python 3.13). Kept outside the CUDA-index
    # loop so the cu-index call stays single-source.
    # pip_calls[1] is the single selected cu126 torch install. Repair must
    # never try another wheel family after this candidate succeeds or fails.
    assert len(pip_calls) == 2, (
        "CUDA repair should attempt exactly one compatible wheel family. "
        "Expected: numpy pre-install + 1 torch install = 2 pip calls."
    )
    assert "https://download.pytorch.org/whl/cu126" in pip_calls[1]


def test_cuda_install_pins_local_version_label_so_pypi_cannot_satisfy(monkeypatch):
    """Regression test: prevent silent fallback to PyPI's CPU torch wheel.

    The original ``_install_cuda_torch`` passed
    ``--extra-index-url https://pypi.org/simple`` plus a plain
    ``torch==2.13.0`` requirement. When the CUDA index briefly failed
    (``IncompleteRead``, DNS lookup miss, etc.), pip would happily
    satisfy ``torch==2.13.0`` from PyPI's CPU wheel — pip would then
    report a successful install, but ``torch.version.cuda`` was empty
    and SAM3 refused to load.

    The fix pins the explicit local-version label
    (``torch==2.13.0+cu126``). PyPI's CPU wheel is published without
    any local-version suffix and therefore cannot match — pip is
    forced to either fetch from the cu-specific index or fail loudly.

    This test asserts both halves of the fix:
      1. The torch requirement carries a ``+cuXXX`` local-version tag.
      2. The pip command does NOT include ``--extra-index-url``.
    """
    pip_calls = []
    actions: list[str] = []

    def fake_run_pip(args, stream=False):
        pip_calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(repair_torch_runtime, "_run_pip", fake_run_pip)
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {"torch_version": "2.13.0+cu126", "torchvision_version": "0.28.0+cu126", "torch_cuda_build": "12.6", "torch_cuda_available": True, "torch_probe_error": None},
    )

    repair_torch_runtime._install_cuda_torch(
        actions,
        {
            "torch_version": "2.13.0+cpu",
            "torchvision_version": "0.28.0",
            "nvidia_cuda_version": "12.8",
        },
        stream_pip=False,
    )

    # pip_calls[0] == numpy ABI pre-install from PyPI
    # (numpy<2.0 on 3.12, numpy>=2.1 on 3.13)
    # pip_calls[1] == cu126 torch install
    assert len(pip_calls) >= 2, f"Expected numpy + torch install, got: {pip_calls}"
    torch_call = pip_calls[1]

    # The torch wheel must be pinned to +cuXXX so PyPI can never satisfy it.
    pinned_torch = [a for a in torch_call if a.startswith("torch==")]
    assert pinned_torch, f"No torch== requirement in: {torch_call}"
    assert any("+cu" in a for a in pinned_torch), (
        f"torch requirement {pinned_torch} is missing the +cuXXX local-version "
        "label. Without it, pip can silently fall back to PyPI's CPU torch "
        "wheel when the CUDA index has a transient network glitch, leaving "
        "the user with a working install that fails SAM3 with a confusing "
        "'torch.version.cuda is empty' error."
    )

    # The torch install must NOT include --extra-index-url; with --no-deps
    # we don't need PyPI as a fallback, and including it re-opens the
    # silent-CPU-fallback footgun even with the pinned local version.
    assert "--extra-index-url" not in torch_call, (
        f"--extra-index-url found in torch install args: {torch_call}. "
        "Even with the +cuXXX pin, including PyPI as an extra index "
        "weakens the guarantee. Numpy is now installed in a separate "
        "pip call (pip_calls[0]) so the torch step needs only the "
        "single cu-specific --index-url."
    )


def test_repair_reports_fresh_cuda_state_after_reinstall(monkeypatch):
    """The repair result must report the fresh interpreter CUDA state."""
    pip_calls = []
    probe_results = iter(
        [
            {"torch_version": "2.13.0+cpu", "torchvision_version": "0.28.0", "torch_cuda_build": None, "torch_cuda_available": False},
            {"torch_version": "2.13.0+cpu", "torchvision_version": "0.28.0", "torch_cuda_build": None, "torch_cuda_available": False},
        ]
    )

    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(repair_torch_runtime, "_detect_gpu_vendor", lambda: {"primary": "nvidia", "vendors": ["nvidia"], "devices": []})
    monkeypatch.setattr(repair_torch_runtime, "_detect_nvidia_cuda_version", lambda: (12, 8))
    monkeypatch.setattr(repair_torch_runtime, "_torch_probe", lambda: next(probe_results))
    monkeypatch.setattr(
        repair_torch_runtime,
        "_torch_probe_subprocess",
        lambda: {"torch_version": "2.13.0+cu126", "torchvision_version": "0.28.0+cu126", "torch_cuda_build": "12.6", "torch_cuda_available": True, "torch_probe_error": None},
    )
    monkeypatch.setattr(repair_torch_runtime, "_missing_sam3_runtime_packages", lambda: [])
    monkeypatch.setattr(repair_torch_runtime, "_run_pip", lambda args, stream=False: pip_calls.append(args) or subprocess.CompletedProcess(args, 0))

    result = repair_torch_runtime.repair_windows_torch_runtime()

    assert result["torch_version"] == "2.13.0+cu126"
    assert result["torch_cuda_build"] == "12.6"
    assert result["torch_cuda_available"] is True
    # numpy ABI pre-install + cu126 torch install = 2 pip calls.
    assert len(pip_calls) == 2


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


def test_detect_nvidia_cuda_version_accepts_umd_header(monkeypatch):
    smi_header_output = (
        "Wed Jul 15 06:43:49 2026\n"
        "+-----------------------------------------------------------------+\n"
        "| NVIDIA-SMI 610.62   KMD Version: 610.62   CUDA UMD Version: 13.3 |\n"
        "+-----------------------------------------------------------------+\n"
    )
    smi_query_unsupported = 'Field "cuda_version" is not a valid field to query.\n'

    def fake_check_output(command, **kwargs):
        if "--query-gpu=cuda_version" in command:
            return smi_query_unsupported
        return smi_header_output

    monkeypatch.setattr(repair_torch_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        repair_torch_runtime.subprocess,
        "check_output",
        fake_check_output,
    )

    result = repair_torch_runtime._detect_nvidia_cuda_version()

    assert result == (13, 3)


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
