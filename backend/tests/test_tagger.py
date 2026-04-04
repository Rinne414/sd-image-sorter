"""
Unit tests for WD14 tagger runtime safety behavior.
"""

from typing import Any, List
import numpy as np
from PIL import Image

import tagger as tagger_module


class _FakeSessionOptions:
    def __init__(self):
        self.intra_op_num_threads = None
        self.inter_op_num_threads = None
        self.execution_mode = None
        self.graph_optimization_level = None
        self.enable_cpu_mem_arena = True
        self.enable_mem_pattern = True
        self.entries = {}

    def add_session_config_entry(self, key: str, value: str) -> None:
        self.entries[key] = value


class _FakeInferenceSession:
    calls: List[List[str]] = []

    def __init__(self, model_path: str, sess_options: Any = None, providers: Any = None):
        provider_list = list(providers or [])
        _FakeInferenceSession.calls.append(provider_list)
        if "CUDAExecutionProvider" in provider_list:
            raise RuntimeError("CUDA out of memory")
        self._providers = provider_list

    def get_providers(self) -> List[str]:
        return list(self._providers)


class _FakeOrtModule:
    SessionOptions = _FakeSessionOptions
    InferenceSession = _FakeInferenceSession

    class ExecutionMode:
        ORT_SEQUENTIAL = "ORT_SEQUENTIAL"

    class GraphOptimizationLevel:
        ORT_ENABLE_ALL = "ORT_ENABLE_ALL"

    @staticmethod
    def get_available_providers() -> List[str]:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_load_falls_back_to_cpu_when_cuda_session_creation_fails(monkeypatch):
    """GPU session init failure should transparently fall back to CPU safe mode."""
    monkeypatch.setattr(tagger_module, "ort", _FakeOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    tagger = tagger_module.WD14Tagger(
        model_name="wd-swinv2-tagger-v3",
        use_gpu=True,
    )

    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", "dummy.csv"))
    monkeypatch.setattr(tagger, "_load_tags", lambda tags_path: None)

    _FakeInferenceSession.calls = []
    tagger.load()

    assert _FakeInferenceSession.calls[0] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert _FakeInferenceSession.calls[1] == ["CPUExecutionProvider"]
    assert tagger.use_gpu is False
    assert tagger.session is not None
    assert tagger.session.get_providers() == ["CPUExecutionProvider"]


class _RuntimeFallbackSession:
    calls: List[List[str]] = []

    def __init__(self, model_path: str, sess_options: Any = None, providers: Any = None):
        provider_list = list(providers or [])
        _RuntimeFallbackSession.calls.append(provider_list)
        self._providers = provider_list

    def get_providers(self) -> List[str]:
        return list(self._providers)

    def get_inputs(self) -> List[Any]:
        return [type("FakeInput", (), {"shape": [1, 448, 448, 3], "name": "input"})()]

    def run(self, *_args, **_kwargs):
        if "CUDAExecutionProvider" in self._providers:
            raise RuntimeError("CUDA out of memory during session run")
        output = np.zeros((1, 3), dtype=np.float32)
        output[0, 0] = 0.91
        return [output]


class _RuntimeFallbackOrtModule(_FakeOrtModule):
    InferenceSession = _RuntimeFallbackSession


def test_tag_falls_back_to_cpu_when_gpu_inference_fails(monkeypatch, tmp_path):
    """A mid-run GPU failure should rebuild the session in CPU Safe Mode and retry once."""
    monkeypatch.setattr(tagger_module, "ort", _RuntimeFallbackOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    image_path = tmp_path / "runtime-fallback.png"
    Image.new("RGB", (64, 64), color="white").save(image_path)

    tagger = tagger_module.WD14Tagger(
        model_name="wd-swinv2-tagger-v3",
        use_gpu=True,
    )

    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", "dummy.csv"))

    def fake_load_tags(_tags_path: str) -> None:
        tagger.tags = ["balanced_tag"]
        tagger.general_tags = [(0, "balanced_tag")]
        tagger.character_tags = []
        tagger.rating_tags = []
        tagger.rating_indices = {}

    monkeypatch.setattr(tagger, "_load_tags", fake_load_tags)

    _RuntimeFallbackSession.calls = []
    result = tagger.tag(str(image_path))

    assert _RuntimeFallbackSession.calls[0] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert _RuntimeFallbackSession.calls[1] == ["CPUExecutionProvider"]
    assert tagger.use_gpu is False
    assert result["general_tags"][0]["tag"] == "balanced_tag"
