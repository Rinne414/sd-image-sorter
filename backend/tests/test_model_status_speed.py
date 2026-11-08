"""Model Center status answers without re-running heavy probes every time.

Measured 2026-11-08: /api/models/status took 7.1 s on its first call and 3.8 s
on every later one, and the first page of the program waited for it (app
ready at 6.3 s). Each call started two subprocesses that import torch (about
2 s each), and the SAM3 readiness check imported transformers (2.9 s) while
saying it does not load anything.
"""

from __future__ import annotations

import sys
import types

import model_health
import model_health_probes as probes


def _completed(stdout: str) -> types.SimpleNamespace:
    return types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")


def test_the_torch_probe_runs_once_per_installed_torch_version(monkeypatch):
    probes.clear_torch_probe_cache()
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    runs = []

    def fake_run(*_args, **_kwargs):
        runs.append(1)
        return _completed(
            '{"torch_version": "2.7.0+cu128", "torch_cuda_available": true}'
        )

    version = {"value": "2.7.0+cu128"}
    monkeypatch.setattr(probes.subprocess, "run", fake_run)
    monkeypatch.setattr(probes, "_installed_torch_version", lambda: version["value"])

    first = probes._probe_torch_runtime()
    second = probes._probe_torch_runtime()
    assert first == second
    assert first["torch_cuda_available"] is True
    assert len(runs) == 1

    # Prepare installed another torch: the next status asks again.
    version["value"] = "2.8.0+cu128"
    probes._probe_torch_runtime()
    assert len(runs) == 2
    probes.clear_torch_probe_cache()


def test_a_failed_torch_probe_is_tried_again(monkeypatch):
    probes.clear_torch_probe_cache()
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    runs = []

    def failing_run(*_args, **_kwargs):
        runs.append(1)
        raise OSError("the subprocess could not start")

    monkeypatch.setattr(probes.subprocess, "run", failing_run)
    monkeypatch.setattr(probes, "_installed_torch_version", lambda: "2.7.0")
    assert probes._probe_torch_runtime()["torch_probe_error"]
    probes._probe_torch_runtime()
    assert len(runs) == 2
    probes.clear_torch_probe_cache()


def test_torch_counts_as_working_when_the_card_name_cannot_be_read(
    monkeypatch, tmp_path
):
    # A torch whose CUDA works but cannot name the card (seen with the E2E
    # stand-in; a driver hiccup does the same) must not read as a failed import:
    # that hid Aesthetic Score as "torch import failed".
    stub = (
        "__version__ = '2.7.0+cu128'",
        "class version:",
        "    cuda = '12.8'",
        "class cuda:",
        "    @staticmethod",
        "    def is_available():",
        "        return True",
    )
    (tmp_path / "torch.py").write_text("\n".join(stub) + "\n", encoding="utf-8")
    monkeypatch.setenv("PYTHONPATH", str(tmp_path))
    result, answered = probes._run_torch_probe()
    assert answered is True
    assert result["torch_probe_error"] is None
    assert result["torch_cuda_available"] is True
    assert result.get("gpu_name") is None


def test_the_sam3_readiness_check_does_not_import_transformers(monkeypatch):
    for name in list(sys.modules):
        if name == "transformers" or name.startswith("transformers."):
            monkeypatch.delitem(sys.modules, name)
    model_health._sam3_runtime_import_ready()
    assert "transformers" not in sys.modules
