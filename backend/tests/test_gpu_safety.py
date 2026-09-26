"""GPU crash safety (decision D46): batch caps scale with input area, a duty cycle
rests the GPU after each inference batch, and only one tagger session stays
resident on the GPU at a time.
"""

from __future__ import annotations

import gc
from typing import Any, List

import numpy as np
import pytest
from PIL import Image

import ai_runtime_guard
import gpu_duty_cycle
import tagger as tagger_module
from config import TAGGER_MODELS
from hardware_monitor import gpu_input_area_scale, recommend_tagger_config


def _rtx_3090_info(available_mb: float = 21617) -> dict:
    return {
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": available_mb,
        "torch_cuda_available": False,
        "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "total_ram_gb": 32,
        "available_ram_gb": 20,
        "gpu_devices": [],
    }


@pytest.fixture(autouse=True)
def _clean_residents(monkeypatch):
    monkeypatch.setattr(ai_runtime_guard, "_gpu_residents", {})
    monkeypatch.delenv(gpu_duty_cycle.GPU_DUTY_CYCLE_ENV, raising=False)
    yield


# --- batch caps scale with the model's input area ---------------------------


def test_input_area_scale_only_shrinks_for_inputs_larger_than_448():
    assert gpu_input_area_scale({"image_size": 1008}) == pytest.approx(
        (448 / 1008) ** 2
    )
    assert gpu_input_area_scale({"image_size": 448}) == 1.0
    assert gpu_input_area_scale({"image_size": 384}) == 1.0
    assert gpu_input_area_scale({}) == 1.0
    assert gpu_input_area_scale({"image_size": "not-a-size"}) == 1.0


@pytest.mark.parametrize(
    ("tier", "expected"),
    [
        ("heavy", 9),  # 48 * 0.1975
        ("balanced", 12),  # 64 * 0.1975
        ("light", 12),
        ("vlm", 1),
    ],
)
def test_gpu_batch_cap_scales_by_input_area_for_every_tier(monkeypatch, tier, expected):
    monkeypatch.setitem(
        TAGGER_MODELS,
        "test-1008-model",
        {"repo_id": "x/y", "runtime_safety_tier": tier, "image_size": 1008},
    )
    rec = recommend_tagger_config(_rtx_3090_info(), model_name="test-1008-model")
    assert rec["recommended_batch_size"] == expected
    if tier != "vlm":
        assert "1008 px" in rec["message"]


def test_scaled_gpu_batch_never_drops_below_one(monkeypatch):
    monkeypatch.setitem(
        TAGGER_MODELS,
        "test-1008-model",
        {"repo_id": "x/y", "runtime_safety_tier": "heavy", "image_size": 1008},
    )
    # 2 GB free: the heavy tier cap is 2, and 2 * 0.1975 rounds down to 0.
    rec = recommend_tagger_config(
        _rtx_3090_info(available_mb=2000), model_name="test-1008-model"
    )
    assert rec["recommended_batch_size"] == 1


def test_models_without_a_larger_input_keep_todays_caps():
    info = _rtx_3090_info()
    assert (
        recommend_tagger_config(info, model_name="wd-swinv2-tagger-v3")[
            "recommended_batch_size"
        ]
        == 64
    )
    assert (
        recommend_tagger_config(info, model_name="wd-eva02-large-tagger-v3")[
            "recommended_batch_size"
        ]
        == 48
    )
    assert (
        recommend_tagger_config(info, model_name="oppai-oracle-v1.1")[
            "recommended_batch_size"
        ]
        == 48
    )
    assert (
        recommend_tagger_config(info, model_name="cl-tagger-v2")[
            "recommended_batch_size"
        ]
        == 48
    )


def test_cpu_chunks_are_not_scaled(monkeypatch):
    monkeypatch.setitem(
        TAGGER_MODELS,
        "test-1008-model",
        {"repo_id": "x/y", "runtime_safety_tier": "heavy", "image_size": 1008},
    )
    scaled = recommend_tagger_config(
        _rtx_3090_info(), model_name="test-1008-model", use_gpu=False
    )
    plain = recommend_tagger_config(
        _rtx_3090_info(), model_name="wd-eva02-large-tagger-v3", use_gpu=False
    )
    assert scaled["recommended_batch_size"] == plain["recommended_batch_size"]


# --- duty cycle ----------------------------------------------------------------


class _FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: List[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def _run_batch(
    clock: _FakeClock, busy_seconds: float, *, uses_gpu: bool = True
) -> None:
    with gpu_duty_cycle.gpu_duty_cycle(uses_gpu, clock=clock, sleep=clock.sleep):
        clock.now += busy_seconds


def test_duty_cycle_pauses_in_proportion_to_the_batch_compute_time():
    clock = _FakeClock()
    _run_batch(clock, 1.0)
    assert clock.sleeps == [pytest.approx(0.15 / 0.85)]


def test_duty_cycle_keeps_the_gpu_busy_about_85_percent_over_a_run():
    clock = _FakeClock()
    start = clock.now
    busy = 0.0
    for seconds in (0.4, 1.2, 0.35, 2.0, 0.8):
        _run_batch(clock, seconds)
        busy += seconds
    assert busy / (clock.now - start) == pytest.approx(0.85, abs=1e-6)


def test_duty_cycle_has_a_minimum_pause_for_tiny_batches():
    clock = _FakeClock()
    _run_batch(clock, 0.0001)
    assert clock.sleeps == [gpu_duty_cycle.MIN_PAUSE_SECONDS]


@pytest.mark.parametrize(
    "value", ["1", "1.0", "100%", "0", "off", "OFF", "false", "no"]
)
def test_duty_cycle_can_be_disabled(monkeypatch, value):
    monkeypatch.setenv(gpu_duty_cycle.GPU_DUTY_CYCLE_ENV, value)
    clock = _FakeClock()
    _run_batch(clock, 1.0)
    assert clock.sleeps == []


def test_duty_cycle_setting_changes_the_pause(monkeypatch):
    monkeypatch.setenv(gpu_duty_cycle.GPU_DUTY_CYCLE_ENV, "50")
    clock = _FakeClock()
    _run_batch(clock, 2.0)
    assert clock.sleeps == [pytest.approx(2.0)]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, 0.85),
        ("", 0.85),
        ("0.7", 0.7),
        ("70", 0.7),
        ("70%", 0.7),
        ("0.01", 0.1),
        ("abc", 0.85),
        ("-3", 0.85),
        ("250", 1.0),
    ],
)
def test_busy_fraction_parsing(raw, expected):
    assert gpu_duty_cycle.parse_gpu_busy_fraction(raw) == pytest.approx(expected)


def test_duty_cycle_never_pauses_cpu_work_or_failed_batches():
    clock = _FakeClock()
    _run_batch(clock, 1.0, uses_gpu=False)
    with pytest.raises(RuntimeError):
        with gpu_duty_cycle.gpu_duty_cycle(True, clock=clock, sleep=clock.sleep):
            clock.now += 1.0
            raise RuntimeError("CUDA out of memory")
    assert clock.sleeps == []


# --- fake ONNX Runtime with GPU sessions -------------------------------------


class _Options:
    def __init__(self) -> None:
        self.entries = {}

    def add_session_config_entry(self, key: str, value: str) -> None:
        self.entries[key] = value


class _GpuSession:
    created: List["_GpuSession"] = []

    def __init__(
        self, model_path: str, sess_options: Any = None, providers: Any = None
    ):
        self.providers = list(providers or [])
        self.runs = 0
        _GpuSession.created.append(self)

    def get_providers(self) -> List[str]:
        return list(self.providers)

    def get_inputs(self):
        return [type("Input", (), {"shape": ["batch", 448, 448, 3], "name": "input"})()]

    def run(self, _outputs, inputs):
        self.runs += 1
        return [np.full((inputs["input"].shape[0], 2), 0.9, dtype=np.float32)]


class _GpuOrt:
    SessionOptions = _Options
    InferenceSession = _GpuSession

    class ExecutionMode:
        ORT_SEQUENTIAL = "ORT_SEQUENTIAL"

    class GraphOptimizationLevel:
        ORT_ENABLE_ALL = "ORT_ENABLE_ALL"

    @staticmethod
    def get_available_providers() -> List[str]:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]


@pytest.fixture
def fake_gpu_ort(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "dummy.onnx").write_bytes(b"model")
    monkeypatch.setattr(tagger_module, "ort", _GpuOrt)
    monkeypatch.setattr(tagger_module, "hf_hub", object())
    _GpuSession.created = []
    return tmp_path


def _gpu_tagger(monkeypatch, model_name: str, *, use_gpu: bool = True):
    tagger = tagger_module.WD14Tagger(model_name=model_name, use_gpu=use_gpu)
    monkeypatch.setattr(tagger, "_get_model_paths", lambda: ("dummy.onnx", "dummy.csv"))

    def load_tags(_path: str) -> None:
        tagger.tags = ["1girl", "solo"]
        tagger.general_tags = [(0, "1girl"), (1, "solo")]

    monkeypatch.setattr(tagger, "_load_tags", load_tags)
    return tagger


def test_wd14_gpu_inference_rests_after_each_batch(monkeypatch, fake_gpu_ort):
    clock = _FakeClock()
    monkeypatch.setattr(gpu_duty_cycle, "_clock", clock)
    monkeypatch.setattr(gpu_duty_cycle, "_sleep", clock.sleep)
    tagger = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3")
    tagger.load()

    tagger._run_inference(np.zeros((1, 448, 448, 3), dtype=np.float32))
    tagger._run_inference(np.zeros((2, 448, 448, 3), dtype=np.float32))

    assert len(clock.sleeps) == 2


def test_wd14_cpu_inference_does_not_rest(monkeypatch, fake_gpu_ort):
    clock = _FakeClock()
    monkeypatch.setattr(gpu_duty_cycle, "_clock", clock)
    monkeypatch.setattr(gpu_duty_cycle, "_sleep", clock.sleep)
    tagger = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3", use_gpu=False)
    tagger.load()

    tagger._run_inference(np.zeros((1, 448, 448, 3), dtype=np.float32))

    assert clock.sleeps == []


# --- one resident GPU tagger session -------------------------------------------


def test_loading_a_second_gpu_tagger_releases_the_first(monkeypatch, fake_gpu_ort):
    first = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3")
    second = _gpu_tagger(monkeypatch, "wd-vit-tagger-v3")

    first.load()
    assert first.session is not None
    assert ai_runtime_guard.gpu_resident_count() == 1

    second.load()

    assert first.session is None
    assert first._loaded is False
    assert second.session is not None
    assert ai_runtime_guard.gpu_resident_count() == 1


def test_released_tagger_reloads_on_next_use_and_evicts_the_other(
    monkeypatch, fake_gpu_ort
):
    first = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3")
    second = _gpu_tagger(monkeypatch, "wd-vit-tagger-v3")
    image_path = fake_gpu_ort / "image.png"
    Image.new("RGB", (64, 64), (10, 20, 30)).save(image_path)
    monkeypatch.setattr(gpu_duty_cycle, "_sleep", lambda _s: None)

    first.load()
    second.load()
    result = first.tag(str(image_path))

    assert result["general_tags"]
    assert first.session is not None
    assert second.session is None
    assert ai_runtime_guard.gpu_resident_count() == 1


def test_get_tagger_model_switch_releases_the_previous_session(
    monkeypatch, fake_gpu_ort
):
    monkeypatch.setattr(tagger_module, "_tagger", None)
    monkeypatch.setattr(tagger_module, "_current_settings", {})
    patched = {}

    original_init = tagger_module.WD14Tagger.__init__

    def init_with_fake_paths(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self._get_model_paths = lambda: ("dummy.onnx", "dummy.csv")
        self._load_tags = lambda _path: None
        patched[self.model_name] = self

    monkeypatch.setattr(tagger_module.WD14Tagger, "__init__", init_with_fake_paths)

    tagger_module.get_tagger(model_name="wd-swinv2-tagger-v3", use_gpu=True).load()
    tagger_module.get_tagger(model_name="wd-vit-tagger-v3", use_gpu=True).load()

    assert patched["wd-swinv2-tagger-v3"].session is None
    assert patched["wd-vit-tagger-v3"].session is not None
    assert ai_runtime_guard.gpu_resident_count() == 1


def test_cpu_sessions_are_not_resident_and_not_evicted(monkeypatch, fake_gpu_ort):
    cpu = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3", use_gpu=False)
    gpu = _gpu_tagger(monkeypatch, "wd-vit-tagger-v3")

    cpu.load()
    gpu.load()

    assert cpu.session is not None
    assert ai_runtime_guard.gpu_resident_count() == 1


def test_release_session_forgets_residency(monkeypatch, fake_gpu_ort):
    tagger = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3")
    tagger.load()

    tagger.release_session()

    assert tagger.session is None
    assert ai_runtime_guard.gpu_resident_count() == 0


def test_release_gpu_residents_frees_every_resident_session(monkeypatch, fake_gpu_ort):
    tagger = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3")
    tagger.load()

    assert ai_runtime_guard.release_gpu_residents() == 1
    assert tagger.session is None
    assert ai_runtime_guard.gpu_resident_count() == 0


def test_garbage_collected_tagger_leaves_no_resident_entry():
    class _Owner:
        def release_session(self) -> None:
            raise AssertionError("a collected owner must not be released")

    owner = _Owner()
    ai_runtime_guard.claim_gpu_residency(owner, owner.release_session, label="gone")
    del owner
    gc.collect()

    assert ai_runtime_guard.gpu_resident_count() == 0
    assert ai_runtime_guard.release_gpu_residents() == 0


def test_residency_is_shared_across_tagger_backends(monkeypatch, fake_gpu_ort):
    class _OtherBackend:
        def __init__(self) -> None:
            self.released = False

        def release_session(self) -> None:
            self.released = True
            ai_runtime_guard.forget_gpu_residency(self)

    other = _OtherBackend()
    ai_runtime_guard.claim_gpu_residency(other, other.release_session, label="other")
    tagger = _gpu_tagger(monkeypatch, "wd-swinv2-tagger-v3")

    tagger.load()

    assert other.released is True
    assert ai_runtime_guard.gpu_resident_count() == 1


def test_oppai_and_cl_taggers_can_release_their_sessions():
    import cl_tagger_v2
    import oppai_oracle_tagger

    for cls in (oppai_oracle_tagger.OppaiOracleTagger, cl_tagger_v2.CLTaggerV2Tagger):
        tagger = object.__new__(cls)
        tagger.model_name = "test"
        tagger.session = object()
        tagger._loaded = True
        ai_runtime_guard.claim_gpu_residency(
            tagger, tagger.release_session, label="test"
        )

        tagger.release_session()

        assert tagger.session is None
        assert tagger._loaded is False
        assert ai_runtime_guard.gpu_resident_count() == 0


def test_cl_tagger_batch_honours_the_preferred_gpu_batch_size(monkeypatch, tmp_path):
    import cl_tagger_v2

    tagger = object.__new__(cl_tagger_v2.CLTaggerV2Tagger)
    tagger._loaded = True
    tagger._target = 8
    tagger.use_gpu = True
    batch_sizes: List[int] = []

    def run_logits(pixels: np.ndarray) -> np.ndarray:
        batch_sizes.append(int(pixels.shape[0]))
        return np.zeros((pixels.shape[0], 1), dtype=np.float32)

    monkeypatch.setattr(tagger, "_run_logits", run_logits, raising=False)
    monkeypatch.setattr(
        tagger, "_process_probs", lambda row, **_k: {"ok": True}, raising=False
    )
    paths = []
    for index in range(5):
        path = tmp_path / f"{index}.png"
        Image.new("RGB", (16, 16)).save(path)
        paths.append(str(path))

    results, info = tagger.tag_batch(
        paths,
        preferred_batch_size=2,
        min_batch_size=1,
        threshold=0.5,
        character_threshold=0.5,
        copyright_threshold=0.5,
        return_runtime_info=True,
    )

    assert batch_sizes == [2, 2, 1]
    assert results == [{"ok": True}] * 5
    assert info["initial_chunk_size"] == 2
