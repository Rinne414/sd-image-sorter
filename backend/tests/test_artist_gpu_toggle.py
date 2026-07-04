"""Tests for the Artist (Kaloscope) GPU/CPU toggle.

Kaloscope previously hardcoded `device = "cuda" if torch.cuda.is_available()
else "cpu"` with no way to opt out. Some GPU stacks (e.g. NVIDIA proprietary
driver on Wayland) freeze the whole desktop the moment a CUDA workload starts,
so — exactly like the WD14 tagger's `use_gpu` option — the artist identifier now
exposes a use_gpu toggle (env default SD_IMAGE_SORTER_ARTIST_USE_GPU, per-call
override). CPU is ~2x slower but works (benchmarked).
"""
from __future__ import annotations

import importlib

import pytest


def test_artist_use_gpu_defaults_true(monkeypatch):
    monkeypatch.delenv("SD_IMAGE_SORTER_ARTIST_USE_GPU", raising=False)
    import config
    importlib.reload(config)
    assert config.ARTIST_USE_GPU is True


@pytest.mark.parametrize("value", ["0", "false", "no", "off", "FALSE"])
def test_artist_use_gpu_env_disables(monkeypatch, value):
    monkeypatch.setenv("SD_IMAGE_SORTER_ARTIST_USE_GPU", value)
    import config
    importlib.reload(config)
    assert config.ARTIST_USE_GPU is False
    monkeypatch.delenv("SD_IMAGE_SORTER_ARTIST_USE_GPU", raising=False)
    importlib.reload(config)


def test_resolve_artist_device_matrix():
    import artist_identifier
    # use_gpu on + cuda present -> cuda; otherwise cpu.
    assert artist_identifier._resolve_artist_device(use_gpu=True, cuda_available=True) == "cuda"
    assert artist_identifier._resolve_artist_device(use_gpu=True, cuda_available=False) == "cpu"
    assert artist_identifier._resolve_artist_device(use_gpu=False, cuda_available=True) == "cpu"
    assert artist_identifier._resolve_artist_device(use_gpu=False, cuda_available=False) == "cpu"


def test_identifier_use_gpu_defaults_from_config(monkeypatch):
    monkeypatch.delenv("SD_IMAGE_SORTER_ARTIST_USE_GPU", raising=False)
    import config
    importlib.reload(config)
    import artist_identifier
    importlib.reload(artist_identifier)
    ident = artist_identifier.ArtistIdentifier()
    assert ident.use_gpu is True


def test_identifier_use_gpu_explicit_overrides_config(monkeypatch):
    monkeypatch.delenv("SD_IMAGE_SORTER_ARTIST_USE_GPU", raising=False)
    import config
    importlib.reload(config)
    import artist_identifier
    importlib.reload(artist_identifier)
    ident = artist_identifier.ArtistIdentifier(use_gpu=False)
    assert ident.use_gpu is False


def test_get_artist_identifier_recreates_when_use_gpu_changes(monkeypatch):
    import artist_identifier
    importlib.reload(artist_identifier)
    first = artist_identifier.get_artist_identifier(use_gpu=True)
    second = artist_identifier.get_artist_identifier(use_gpu=False)
    # A changed use_gpu must rebuild the singleton, not silently reuse the GPU one.
    assert second.use_gpu is False
    assert first is not second


class _FakeOrt:
    """Stand-in for onnxruntime with a GPU provider installed."""

    def __init__(self, available):
        self._available = available

    def get_available_providers(self):
        return list(self._available)


def test_onnx_providers_cpu_only_when_gpu_off():
    """The .onnx path ignored use_gpu entirely (owner report 2026-07-05):
    InferenceSession(path) defaults to CUDA-first on onnxruntime-gpu."""
    import artist_identifier

    fake = _FakeOrt(["CUDAExecutionProvider", "CPUExecutionProvider"])
    assert artist_identifier._onnx_providers_for(fake, use_gpu=False) == [
        "CPUExecutionProvider"
    ]


def test_onnx_providers_prefer_gpu_when_on_and_available():
    import artist_identifier

    fake = _FakeOrt(["CUDAExecutionProvider", "CPUExecutionProvider"])
    assert artist_identifier._onnx_providers_for(fake, use_gpu=True) == [
        "CUDAExecutionProvider", "CPUExecutionProvider",
    ]


def test_onnx_providers_safe_on_cpu_only_install():
    import artist_identifier

    fake = _FakeOrt(["CPUExecutionProvider"])
    assert artist_identifier._onnx_providers_for(fake, use_gpu=True) == [
        "CPUExecutionProvider"
    ]
