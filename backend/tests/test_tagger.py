"""
Unit tests for WD14 tagger runtime safety behavior.
"""

from typing import Any, List
import numpy as np
from PIL import Image
import pytest

import tagger as tagger_module


@pytest.fixture(autouse=True)
def reset_session_tracking():
    """Reset all session tracking state before each test."""
    _FakeInferenceSession.calls = []
    _CpuOnlySessionDespiteCudaRequest.calls = []
    _RuntimeFallbackSession.calls = []
    _AdaptiveGpuBatchSession.creation_calls = []
    _AdaptiveGpuBatchSession.run_batch_sizes = []
    yield


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


def _make_score_tagger(monkeypatch, *, threshold: float = 0.5, character_threshold: float = 0.8):
    monkeypatch.setattr(tagger_module, "ort", _FakeOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())
    return tagger_module.WD14Tagger(
        model_name="wd-swinv2-tagger-v3",
        threshold=threshold,
        character_threshold=character_threshold,
        use_gpu=False,
    )


def test_process_probs_applies_general_and_character_thresholds_strictly(monkeypatch):
    tagger = _make_score_tagger(monkeypatch, threshold=0.5, character_threshold=0.8)
    tagger.general_tags = [(0, "general_above"), (1, "general_below"), (2, "general_equal")]
    tagger.character_tags = [(3, "char_above"), (4, "char_below"), (5, "char_equal")]
    tagger.rating_tags = [(6, "general"), (7, "sensitive"), (8, "explicit")]

    result = tagger._process_probs(
        np.array([0.51, 0.49, 0.50, 0.81, 0.79, 0.80, 0.10, 0.30, 0.20], dtype=np.float32)
    )

    assert [item["tag"] for item in result["general_tags"]] == ["general_above", "general_equal"]
    assert [item["tag"] for item in result["character_tags"]] == ["char_above", "char_equal"]
    assert result["rating"] == "sensitive"
    assert result["rating_confidences"] == pytest.approx({"general": 0.10, "sensitive": 0.30, "explicit": 0.20})
    assert "general_below" not in {item["tag"] for item in result["all_tags"]}
    assert "char_below" not in {item["tag"] for item in result["all_tags"]}


def test_process_probs_ignores_invalid_probability_scores(monkeypatch):
    tagger = _make_score_tagger(monkeypatch, threshold=0.5, character_threshold=0.8)
    tagger.general_tags = [(0, "valid_general"), (1, "invalid_logit"), (2, "nan_general")]
    tagger.character_tags = [(3, "invalid_negative_character")]
    tagger.rating_tags = [(4, "general"), (5, "explicit")]

    result = tagger._process_probs(
        np.array([0.70, 6.0, np.nan, -0.10, 2.0, 0.60], dtype=np.float32)
    )

    assert [item["tag"] for item in result["general_tags"]] == ["valid_general"]
    assert result["character_tags"] == []
    assert result["rating"] == "explicit"
    assert result["rating_confidences"]["general"] == 0.0
    assert result["rating_confidences"]["explicit"] == pytest.approx(0.60)
    assert all(0.0 <= item["confidence"] <= 1.0 for item in result["all_tags"])


def test_sigmoid_output_activation_ignores_nonfinite_logits(monkeypatch):
    tagger = _make_score_tagger(monkeypatch, threshold=0.9, character_threshold=0.8)
    tagger._output_activation = "sigmoid"
    tagger.general_tags = [(0, "invalid_positive_inf"), (1, "valid_logit")]
    tagger.character_tags = []
    tagger.rating_tags = []

    result = tagger._process_probs(np.array([np.inf, 4.0], dtype=np.float32))

    assert [item["tag"] for item in result["general_tags"]] == ["valid_logit"]
    assert result["general_tags"][0]["confidence"] == pytest.approx(0.98201376)
    assert "invalid_positive_inf" not in {item["tag"] for item in result["all_tags"]}


class _CpuOnlySessionDespiteCudaRequest:
    calls: List[List[str]] = []

    def __init__(self, _model_path: str, sess_options: Any = None, providers: Any = None):
        _CpuOnlySessionDespiteCudaRequest.calls.append(list(providers or []))
        self._providers = ["CPUExecutionProvider"]

    def get_providers(self) -> List[str]:
        return list(self._providers)


class _CpuOnlyOrtModule(_FakeOrtModule):
    InferenceSession = _CpuOnlySessionDespiteCudaRequest


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

    tagger.load()

    assert _FakeInferenceSession.calls[0] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert _FakeInferenceSession.calls[1] == ["CPUExecutionProvider"]
    assert tagger.use_gpu is False
    assert tagger.session is not None
    assert tagger.session.get_providers() == ["CPUExecutionProvider"]


def test_load_marks_gpu_disabled_when_ort_silently_falls_back_to_cpu(monkeypatch):
    monkeypatch.setattr(tagger_module, "ort", _CpuOnlyOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    tagger = tagger_module.WD14Tagger(
        model_name="wd-swinv2-tagger-v3",
        use_gpu=True,
    )

    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", "dummy.csv"))
    monkeypatch.setattr(tagger, "_load_tags", lambda tags_path: None)

    _CpuOnlySessionDespiteCudaRequest.calls = []
    tagger.load()

    assert _CpuOnlySessionDespiteCudaRequest.calls[0] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert tagger.session is not None
    assert tagger.session.get_providers() == ["CPUExecutionProvider"]
    assert tagger.use_gpu is False


class _RuntimeFallbackSession:
    calls: List[List[str]] = []

    def __init__(self, model_path: str, sess_options: Any = None, providers: Any = None):
        provider_list = list(providers or [])
        _RuntimeFallbackSession.calls.append(provider_list)
        self._providers = provider_list

    def get_providers(self) -> List[str]:
        return list(self._providers)

    def get_inputs(self) -> List[Any]:
        return [type("FakeInput", (), {"shape": ["batch_size", 448, 448, 3], "name": "input"})()]

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


class _BatchInferenceSession:
    def __init__(self, *_args, **_kwargs):
        self._providers = ["CPUExecutionProvider"]
        self.last_input_shape = None

    def get_providers(self) -> List[str]:
        return list(self._providers)

    def get_inputs(self) -> List[Any]:
        return [type("FakeInput", (), {"shape": ["batch_size", 448, 448, 3], "name": "input"})()]

    def run(self, _outputs, inputs):
        batch = inputs["input"]
        self.last_input_shape = batch.shape
        output = np.zeros((batch.shape[0], 3), dtype=np.float32)
        for index in range(batch.shape[0]):
            output[index, 0] = 0.8 + (index * 0.01)
        return [output]


class _BatchOrtModule(_FakeOrtModule):
    InferenceSession = _BatchInferenceSession


def test_tag_batch_uses_true_multi_image_inference(monkeypatch, tmp_path):
    monkeypatch.setattr(tagger_module, "ort", _BatchOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    paths = []
    for index in range(3):
        image_path = tmp_path / f"batch-{index}.png"
        Image.new("RGB", (64 + index, 64), color="white").save(image_path)
        paths.append(str(image_path))

    tagger = tagger_module.WD14Tagger(model_name="wd-swinv2-tagger-v3", use_gpu=False)
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", "dummy.csv"))

    def fake_load_tags(_tags_path: str) -> None:
        tagger.tags = ["balanced_tag"]
        tagger.general_tags = [(0, "balanced_tag")]
        tagger.character_tags = []
        tagger.rating_tags = []
        tagger.rating_indices = {}

    monkeypatch.setattr(tagger, "_load_tags", fake_load_tags)

    results = tagger.tag_batch(paths)

    assert len(results) == 3
    assert all(result["general_tags"][0]["tag"] == "balanced_tag" for result in results)
    assert getattr(tagger.session, "last_input_shape", None) == (3, 448, 448, 3)


class _AdaptiveGpuBatchSession:
    creation_calls: List[List[str]] = []
    run_batch_sizes: List[int] = []
    fail_threshold = 2

    def __init__(self, _model_path: str, sess_options: Any = None, providers: Any = None):
        provider_list = list(providers or [])
        _AdaptiveGpuBatchSession.creation_calls.append(provider_list)
        self._providers = provider_list

    def get_providers(self) -> List[str]:
        return list(self._providers)

    def get_inputs(self) -> List[Any]:
        return [type("FakeInput", (), {"shape": ["batch_size", 448, 448, 3], "name": "input"})()]

    def run(self, _outputs, inputs):
        batch = inputs["input"]
        _AdaptiveGpuBatchSession.run_batch_sizes.append(int(batch.shape[0]))
        if "CUDAExecutionProvider" in self._providers and batch.shape[0] > self.fail_threshold:
            raise RuntimeError("CUDA batch too large")
        output = np.zeros((batch.shape[0], 3), dtype=np.float32)
        output[:, 0] = 0.93
        return [output]


class _AdaptiveGpuOrtModule(_FakeOrtModule):
    InferenceSession = _AdaptiveGpuBatchSession


def test_tag_batch_gpu_backoff_retries_with_smaller_chunks(monkeypatch, tmp_path):
    monkeypatch.setattr(tagger_module, "ort", _AdaptiveGpuOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    paths = []
    for index in range(4):
        image_path = tmp_path / f"gpu-backoff-{index}.png"
        Image.new("RGB", (64, 64), color="white").save(image_path)
        paths.append(str(image_path))

    tagger = tagger_module.WD14Tagger(model_name="wd-swinv2-tagger-v3", use_gpu=True)
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", "dummy.csv"))

    def fake_load_tags(_tags_path: str) -> None:
        tagger.tags = ["balanced_tag"]
        tagger.general_tags = [(0, "balanced_tag")]
        tagger.character_tags = []
        tagger.rating_tags = []
        tagger.rating_indices = {}

    monkeypatch.setattr(tagger, "_load_tags", fake_load_tags)
    _AdaptiveGpuBatchSession.creation_calls = []
    _AdaptiveGpuBatchSession.run_batch_sizes = []

    results, runtime_info = tagger.tag_batch(
        paths,
        preferred_batch_size=4,
        return_runtime_info=True,
    )

    assert len(results) == 4
    assert all(result["general_tags"][0]["tag"] == "balanced_tag" for result in results)
    assert _AdaptiveGpuBatchSession.run_batch_sizes == [4, 2, 2]
    assert runtime_info["backoff_steps"][0]["from"] == 4
    assert runtime_info["backoff_steps"][0]["to"] == 2
    assert runtime_info["used_cpu_fallback"] is False
    assert tagger.use_gpu is True


def test_tag_batch_reuses_learned_stable_gpu_chunk_size(monkeypatch, tmp_path):
    monkeypatch.setattr(tagger_module, "ort", _AdaptiveGpuOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    paths = []
    for index in range(8):
        image_path = tmp_path / f"gpu-learn-{index}.png"
        Image.new("RGB", (64, 64), color="white").save(image_path)
        paths.append(str(image_path))

    tagger = tagger_module.WD14Tagger(model_name="wd-swinv2-tagger-v3", use_gpu=True)
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", "dummy.csv"))

    def fake_load_tags(_tags_path: str) -> None:
        tagger.tags = ["balanced_tag"]
        tagger.general_tags = [(0, "balanced_tag")]
        tagger.character_tags = []
        tagger.rating_tags = []
        tagger.rating_indices = {}

    monkeypatch.setattr(tagger, "_load_tags", fake_load_tags)
    _AdaptiveGpuBatchSession.creation_calls = []
    _AdaptiveGpuBatchSession.run_batch_sizes = []

    first_results, first_runtime = tagger.tag_batch(
        paths[:4],
        preferred_batch_size=4,
        return_runtime_info=True,
    )
    second_results, second_runtime = tagger.tag_batch(
        paths[4:],
        preferred_batch_size=4,
        return_runtime_info=True,
    )

    assert len(first_results) == 4
    assert len(second_results) == 4
    assert _AdaptiveGpuBatchSession.run_batch_sizes[:3] == [4, 2, 2]
    assert _AdaptiveGpuBatchSession.run_batch_sizes[3:] == [2, 2]
    assert first_runtime["backoff_steps"][0]["to"] == 2
    assert second_runtime["backoff_steps"] == []


class _CamieBatchSession:
    def __init__(self, *_args, **_kwargs):
        self._providers = ["CPUExecutionProvider"]
        self.last_input_shape = None

    def get_providers(self):
        return list(self._providers)

    def get_inputs(self):
        return [type("FakeInput", (), {"shape": ["batch", 3, 512, 512], "name": "input"})()]

    def run(self, _outputs, inputs):
        batch = inputs["input"]
        self.last_input_shape = batch.shape
        output = np.zeros((batch.shape[0], 30), dtype=np.float32)
        output[:, 20] = 6.0
        output[:, 24] = 4.0
        output[:, 25] = -1.0
        return [output]


class _CamieOrtModule(_FakeOrtModule):
    InferenceSession = _CamieBatchSession


def test_camie_metadata_and_preprocess_are_supported(monkeypatch, tmp_path):
    monkeypatch.setattr(tagger_module, "ort", _CamieOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    image_path = tmp_path / "camie.png"
    Image.new("RGB", (640, 480), color="white").save(image_path)

    metadata_path = tmp_path / "camie-metadata.json"
    metadata_path.write_text(
        '{"dataset_info":{"total_tags":30,"tag_mapping":{"idx_to_tag":{"20":"rating_general","24":"1girl","25":"weak_noise"},"tag_to_category":{"rating_general":"rating","1girl":"general","weak_noise":"general"}}}}',
        encoding='utf-8'
    )

    tagger = tagger_module.WD14Tagger(
        model_name="camie-tagger-v2",
        model_path="dummy.onnx",
        tags_path=str(metadata_path),
        use_gpu=False,
    )
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", str(metadata_path)))

    result = tagger.tag(str(image_path))

    assert result["rating"] == "general"
    assert result["general_tags"][0]["tag"] == "1girl"
    assert result["general_tags"][0]["confidence"] == pytest.approx(0.98201376)
    assert all(item["tag"] != "weak_noise" for item in result["general_tags"])
    assert all(0.0 <= item["confidence"] <= 1.0 for item in result["all_tags"])
    assert getattr(tagger.session, "last_input_shape", None) == (1, 3, 512, 512)


class _PixAIBatchSession:
    def __init__(self, *_args, **_kwargs):
        self._providers = ["CPUExecutionProvider"]
        self.last_input_shape = None
        self.last_input_min = None
        self.last_input_max = None

    def get_providers(self):
        return list(self._providers)

    def get_inputs(self):
        return [type("FakeInput", (), {"shape": ["batch", 3, 448, 448], "name": "input"})()]

    def run(self, _outputs, inputs):
        batch = inputs["input"]
        self.last_input_shape = batch.shape
        self.last_input_min = float(batch.min())
        self.last_input_max = float(batch.max())
        output = np.zeros((batch.shape[0], 8), dtype=np.float32)
        output[:, 0] = 0.92
        output[:, 2] = 0.9
        return [output]


class _PixAIOrtModule(_FakeOrtModule):
    InferenceSession = _PixAIBatchSession


def test_pixai_onnx_preprocess_and_tags_are_supported(monkeypatch, tmp_path):
    monkeypatch.setattr(tagger_module, "ort", _PixAIOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    image_path = tmp_path / "pixai.png"
    Image.new("RGB", (320, 640), color=(32, 128, 224)).save(image_path)

    tags_path = tmp_path / "pixai-selected-tags.csv"
    tags_path.write_text(
        "id,tag_id,name,category,count,ips\n"
        "0,1,1girl,0,10,[]\n"
        "1,2,solo,0,10,[]\n"
        "2,3,hu_tao_(genshin_impact),4,10,[\"genshin_impact\"]\n",
        encoding="utf-8",
    )

    tagger = tagger_module.WD14Tagger(
        model_name="pixai-tagger-v0.9",
        model_path="dummy.onnx",
        tags_path=str(tags_path),
        use_gpu=False,
    )
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", str(tags_path)))

    result = tagger.tag(str(image_path))

    assert result["rating"] == "general"
    assert result["general_tags"][0]["tag"] == "1girl"
    assert result["character_tags"][0]["tag"] == "hu_tao_(genshin_impact)"
    assert getattr(tagger.session, "last_input_shape", None) == (1, 3, 448, 448)
    assert getattr(tagger.session, "last_input_min", None) is not None
    assert getattr(tagger.session, "last_input_min", None) >= -1.01
    assert getattr(tagger.session, "last_input_max", None) <= 1.01


def test_custom_onnx_infers_nchw_input_layout(monkeypatch, tmp_path):
    monkeypatch.setattr(tagger_module, "ort", _PixAIOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    image_path = tmp_path / "custom-nchw.png"
    Image.new("RGB", (640, 320), color=(224, 128, 32)).save(image_path)

    tags_path = tmp_path / "selected_tags.csv"
    tags_path.write_text(
        "id,tag_id,name,category,count,ips\n"
        "0,1,1girl,0,10,[]\n"
        "1,2,solo,0,10,[]\n"
        "2,3,custom_character,4,10,[]\n",
        encoding="utf-8",
    )

    tagger = tagger_module.WD14Tagger(
        model_name="wd-swinv2-tagger-v3",
        model_path="custom.onnx",
        tags_path=str(tags_path),
        use_gpu=False,
    )
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("custom.onnx", str(tags_path)))

    result = tagger.tag(str(image_path))

    assert result["general_tags"][0]["tag"] == "1girl"
    assert result["character_tags"][0]["tag"] == "custom_character"
    assert getattr(tagger.session, "last_input_shape", None) == (1, 3, 448, 448)


def test_pixai_rating_fallback_can_escalate_to_explicit(monkeypatch, tmp_path):
    monkeypatch.setattr(tagger_module, "ort", _PixAIOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    image_path = tmp_path / "pixai-explicit.png"
    Image.new("RGB", (448, 448), color="white").save(image_path)

    tags_path = tmp_path / "pixai-selected-tags.csv"
    tags_path.write_text(
        "id,tag_id,name,category,count,ips\n"
        "0,1,pussy,0,10,[]\n"
        "1,2,1girl,0,10,[]\n"
        "2,3,hu_tao_(genshin_impact),4,10,[\"genshin_impact\"]\n",
        encoding="utf-8",
    )

    class _ExplicitPixAISession(_PixAIBatchSession):
        def run(self, _outputs, inputs):
            batch = inputs["input"]
            self.last_input_shape = batch.shape
            self.last_input_min = float(batch.min())
            self.last_input_max = float(batch.max())
            output = np.zeros((batch.shape[0], 8), dtype=np.float32)
            output[:, 0] = 0.97
            output[:, 1] = 0.95
            output[:, 2] = 0.9
            return [output]

    class _ExplicitPixAIOrtModule(_FakeOrtModule):
        InferenceSession = _ExplicitPixAISession

    monkeypatch.setattr(tagger_module, "ort", _ExplicitPixAIOrtModule)

    tagger = tagger_module.WD14Tagger(
        model_name="pixai-tagger-v0.9",
        model_path="dummy.onnx",
        tags_path=str(tags_path),
        use_gpu=False,
    )
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", str(tags_path)))

    result = tagger.tag(str(image_path))

    assert result["rating"] == "explicit"
    assert result["rating_confidences"]["explicit"] == 1.0


def test_pixai_rating_fallback_uses_only_thresholded_tags(monkeypatch, tmp_path):
    image_path = tmp_path / "pixai-low-explicit.png"
    Image.new("RGB", (448, 448), color="white").save(image_path)

    tags_path = tmp_path / "pixai-selected-tags.csv"
    tags_path.write_text(
        "id,tag_id,name,category,count,ips\n"
        "0,1,pussy,0,10,[]\n"
        "1,2,1girl,0,10,[]\n"
        "2,3,hu_tao_(genshin_impact),4,10,[\"genshin_impact\"]\n",
        encoding="utf-8",
    )

    class _LowExplicitPixAISession(_PixAIBatchSession):
        def run(self, _outputs, inputs):
            batch = inputs["input"]
            self.last_input_shape = batch.shape
            self.last_input_min = float(batch.min())
            self.last_input_max = float(batch.max())
            output = np.zeros((batch.shape[0], 8), dtype=np.float32)
            output[:, 0] = 0.29
            output[:, 1] = 0.91
            output[:, 2] = 0.9
            return [output]

    class _LowExplicitPixAIOrtModule(_FakeOrtModule):
        InferenceSession = _LowExplicitPixAISession

    monkeypatch.setattr(tagger_module, "ort", _LowExplicitPixAIOrtModule)
    monkeypatch.setattr(tagger_module, "hf_hub", object())

    tagger = tagger_module.WD14Tagger(
        model_name="pixai-tagger-v0.9",
        model_path="dummy.onnx",
        tags_path=str(tags_path),
        threshold=0.30,
        use_gpu=False,
    )
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", str(tags_path)))

    result = tagger.tag(str(image_path))

    assert result["rating"] == "general"
    assert "pussy" not in {item["tag"] for item in result["general_tags"]}
    assert result["rating_confidences"]["general"] == 1.0
