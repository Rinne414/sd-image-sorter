"""Characterization pins for tagger.py (WD14 ONNX tagger) — TIER-2 step 0.

These lock the module-boundary contracts that a censor-style mixin / package
split must preserve VERBATIM, WITHOUT loading a real ONNX session or
downloading a model. Everything heavy is stubbed:

  * ``tagger.ort`` / ``tagger.hf_hub`` are the lazy-import globals; pins patch
    them to in-file fakes so no ``onnxruntime`` / ``huggingface_hub`` import
    ever runs.
  * pure scoring / preprocessing / metadata / planning helpers are exercised
    through ``WD14Tagger.__new__`` (bypasses ``__init__`` -> ``_ensure_imports``).

Priority mirrors the step-0 brief: OOM backoff sequence, hardware clamp,
session lifecycle, lazy-import family, singleton lifecycle, preprocessing.

Companion to the existing readers (test_tagger.py / test_resource_safety.py /
test_tag_score_service.py); this file is the UNIT twin that protects the seams
a decomposition would move.
"""

from __future__ import annotations

import json
from typing import Any, List, Optional

import numpy as np
import pytest
from PIL import Image

import tagger as tagger_module
from tagger import WD14Tagger


# ---------------------------------------------------------------------------
# Machine-state isolation (0edbb81): snapshot + restore every mutable module
# global so a pin can freely rebind them without bleeding into sibling suites.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _isolate_tagger_module_state():
    saved = {
        "ort": tagger_module.ort,
        "hf_hub": tagger_module.hf_hub,
        "_tagger": tagger_module._tagger,
        "_current_settings": dict(tagger_module._current_settings),
        "_preprocess_executor": tagger_module._preprocess_executor,
    }
    try:
        yield
    finally:
        created = tagger_module._preprocess_executor
        if created is not None and created is not saved["_preprocess_executor"]:
            created.shutdown(wait=False)
        tagger_module.ort = saved["ort"]
        tagger_module.hf_hub = saved["hf_hub"]
        tagger_module._tagger = saved["_tagger"]
        tagger_module._current_settings = saved["_current_settings"]
        tagger_module._preprocess_executor = saved["_preprocess_executor"]


# ---------------------------------------------------------------------------
# Fakes + helpers
# ---------------------------------------------------------------------------
class _FakeSessionOptions:
    def __init__(self) -> None:
        self.intra_op_num_threads: Optional[int] = None
        self.inter_op_num_threads: Optional[int] = None
        self.execution_mode: Any = None
        self.graph_optimization_level: Any = None
        self.enable_cpu_mem_arena = True
        self.enable_mem_pattern = True
        self.entries: dict = {}

    def add_session_config_entry(self, key: str, value: str) -> None:
        self.entries[key] = value


class _FakeOrt:
    """Minimal stand-in for the onnxruntime module (no real sessions)."""

    SessionOptions = _FakeSessionOptions

    class ExecutionMode:
        ORT_SEQUENTIAL = "ORT_SEQUENTIAL"

    class GraphOptimizationLevel:
        ORT_ENABLE_ALL = "ORT_ENABLE_ALL"

    @staticmethod
    def get_available_providers() -> List[str]:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]


class _FakeInput:
    def __init__(self, shape: List[Any], name: str = "input") -> None:
        self.shape = shape
        self.name = name


class _FakeSession:
    def __init__(self, *, shape=None, providers=("CPUExecutionProvider",)) -> None:
        self._shape = shape
        self._providers = list(providers)

    def get_providers(self) -> List[str]:
        return list(self._providers)

    def get_inputs(self) -> List[_FakeInput]:
        return [_FakeInput(self._shape)]


def _bare(**attrs: Any) -> WD14Tagger:
    """Build a WD14Tagger via __new__ (skips __init__ -> _ensure_imports)."""
    tagger = WD14Tagger.__new__(WD14Tagger)
    tagger.model_name = "wd-test"
    for key, value in attrs.items():
        setattr(tagger, key, value)
    return tagger


# ===========================================================================
# 1. Lazy-import family (facade-critical)
# ===========================================================================
def test_ensure_imports_fast_path_is_noop_when_both_globals_set(monkeypatch):
    """With ort + hf_hub already bound, _ensure_imports returns without
    re-importing anything (the lock-free fast path)."""
    ort_sentinel = object()
    hub_sentinel = object()
    monkeypatch.setattr(tagger_module, "ort", ort_sentinel)
    monkeypatch.setattr(tagger_module, "hf_hub", hub_sentinel)

    tagger_module._ensure_imports()  # must not raise / must not rebind

    assert tagger_module.ort is ort_sentinel
    assert tagger_module.hf_hub is hub_sentinel


def test_ort_is_read_as_a_defining_module_global(monkeypatch):
    """SEAM: every ``ort.`` call in a WD14Tagger method reads the tagger-module
    global. A split that moves the class to a submodule (leaving ``ort`` bound on
    the facade that tests patch) would break this. Proven by patching only
    ``tagger_module.ort`` and observing the method use the fake."""
    monkeypatch.setattr(tagger_module, "ort", _FakeOrt)
    options = _bare()._build_session_options(gpu_enabled=True)
    assert isinstance(options, _FakeSessionOptions)


# ===========================================================================
# 2. Hardware clamp — _build_session_options (v3.0.5 machine-check guard)
# ===========================================================================
def test_build_session_options_gpu_pins_two_intra_threads_no_mem_arena(monkeypatch):
    monkeypatch.setattr(tagger_module, "ort", _FakeOrt)
    monkeypatch.setattr("multiprocessing.cpu_count", lambda: 16)

    options = _bare()._build_session_options(gpu_enabled=True)

    assert options.intra_op_num_threads == 2
    assert options.inter_op_num_threads == 1
    # GPU mode disables the CPU arena / mem pattern.
    assert options.enable_cpu_mem_arena is False
    assert options.enable_mem_pattern is False
    assert options.execution_mode == "ORT_SEQUENTIAL"
    assert options.entries["session.intra_op.allow_spinning"] == "0"


def test_build_session_options_cpu_leaves_core_headroom(monkeypatch):
    """CPU mode defaults to half-minus-one cores (min 2) to avoid pinning every
    core (marginal-hardware machine-check / thermal guard)."""
    monkeypatch.setattr(tagger_module, "ort", _FakeOrt)
    monkeypatch.setattr("multiprocessing.cpu_count", lambda: 8)
    monkeypatch.delenv("TAGGER_CPU_THREADS", raising=False)

    options = _bare()._build_session_options(gpu_enabled=False)

    assert options.intra_op_num_threads == 3  # max(2, 8//2 - 1)
    assert options.inter_op_num_threads == 1  # max(1, 3//2)
    assert options.enable_cpu_mem_arena is True
    assert options.enable_mem_pattern is True


def test_build_session_options_honors_env_thread_override(monkeypatch):
    monkeypatch.setattr(tagger_module, "ort", _FakeOrt)
    monkeypatch.setattr("multiprocessing.cpu_count", lambda: 8)
    monkeypatch.setenv("TAGGER_CPU_THREADS", "2")

    options = _bare()._build_session_options(gpu_enabled=False)

    assert options.intra_op_num_threads == 2  # min(cpu_count, override)


# ===========================================================================
# 3. Session lifecycle
# ===========================================================================
def test_refresh_metadata_none_session_resets_defaults():
    tagger = _bare(
        session=None, _input_name="x", _input_hw=(1, 1), _supports_true_batch=True
    )
    tagger._refresh_session_metadata()
    assert tagger._input_name is None
    assert tagger._input_hw == (448, 448)
    assert tagger._supports_true_batch is False


def test_refresh_metadata_session_without_get_inputs_uses_input_default():
    tagger = _bare(session=object())  # no get_inputs attribute
    tagger._refresh_session_metadata()
    assert tagger._input_name == "input"
    assert tagger._input_hw == (448, 448)
    assert tagger._supports_true_batch is False


def test_refresh_metadata_infers_nhwc_shape_and_dynamic_batch():
    tagger = _bare(session=_FakeSession(shape=["batch", 300, 400, 3]))
    tagger._refresh_session_metadata()
    assert tagger._input_layout == "nhwc"
    assert tagger._input_hw == (400, 300)  # (width, height)
    assert tagger._supports_true_batch is True  # non-int batch dim


def test_refresh_metadata_infers_nchw_and_fixed_batch_one_blocks_true_batch():
    tagger = _bare(session=_FakeSession(shape=[1, 3, 512, 512]))
    tagger._refresh_session_metadata()
    assert tagger._input_layout == "nchw"
    assert tagger._input_hw == (512, 512)
    assert tagger._supports_true_batch is False  # batch dim == 1


def test_session_uses_gpu_reads_active_providers():
    assert _bare(session=None)._session_uses_gpu() is False
    assert (
        _bare(
            session=_FakeSession(providers=["CUDAExecutionProvider"])
        )._session_uses_gpu()
        is True
    )
    assert (
        _bare(
            session=_FakeSession(providers=["DmlExecutionProvider"])
        )._session_uses_gpu()
        is True
    )
    assert (
        _bare(
            session=_FakeSession(providers=["CPUExecutionProvider"])
        )._session_uses_gpu()
        is False
    )


def test_fallback_to_cpu_raises_before_model_paths_resolved():
    tagger = _bare(_resolved_model_path=None, _resolved_tags_path=None)
    with pytest.raises(RuntimeError, match="before model paths are resolved"):
        tagger._fallback_to_cpu_session(RuntimeError("gpu inference died"))


def test_recreate_session_is_noop_when_paths_unresolved():
    tagger = _bare(
        _resolved_model_path=None,
        _resolved_tags_path=None,
        session="SENTINEL",
        _images_since_session_create=7,
    )
    assert tagger._recreate_session() is None
    assert tagger.session == "SENTINEL"  # untouched
    assert tagger._images_since_session_create == 7


def test_validate_model_file_rejects_missing_and_small_accepts_large(tmp_path):
    tagger = _bare()
    assert tagger._validate_model_file(str(tmp_path / "nope.onnx")) is False

    small = tmp_path / "small.onnx"
    small.write_bytes(b"x" * 16)
    assert tagger._validate_model_file(str(small)) is False

    big = tmp_path / "big.onnx"
    big.write_bytes(b"\x08\x01\x12\x00" + b"0" * (1024 * 1024))
    assert tagger._validate_model_file(str(big)) is True


def test_finalize_recreates_session_at_interval_and_swallows_errors():
    tagger = _bare(_images_since_session_create=0, _session_refresh_interval=3)
    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise RuntimeError("recreate failed mid-run")

    tagger._recreate_session = boom
    # Reaching the interval triggers a recreate; the recreate error is swallowed
    # (logged) rather than propagated so a single hiccup does not abort tagging.
    tagger._finalize_processed_images(3)
    assert calls["n"] == 1
    assert tagger._images_since_session_create == 3


def test_finalize_is_noop_for_nonpositive_image_count():
    tagger = _bare(_images_since_session_create=5, _session_refresh_interval=1)

    def must_not_recreate():
        raise AssertionError("recreate must not run for count <= 0")

    tagger._recreate_session = must_not_recreate
    tagger._finalize_processed_images(0)
    assert tagger._images_since_session_create == 5


# ===========================================================================
# 4. OOM backoff sequence (SAFETY) + runtime-info aggregation
# ===========================================================================
def test_run_true_batch_halves_gpu_chunk_on_oom_and_learns_stable_size():
    """SAFETY: a CUDA-OOM at the requested chunk size halves the GPU batch
    (records a ``gpu_backoff`` step, recreates the session, clamps the learned
    stable size) and stays on GPU — the v3.0.5 hardware-clamp / OOM-backoff
    contract at the unit boundary."""
    tagger = _bare(
        use_gpu=True,
        _learned_stable_gpu_batch_size=None,
        _successful_gpu_batch_runs=0,
        _images_since_session_create=0,
        _session_refresh_interval=0,
    )
    tagger._session_uses_gpu = lambda: True
    recreated = {"n": 0}
    tagger._recreate_session = lambda: recreated.__setitem__("n", recreated["n"] + 1)
    tagger._process_probs = lambda output, **_kw: {"ok": True}

    run_sizes: List[int] = []

    def fake_run(batch, *, allow_gpu_fallback=True):
        run_sizes.append(int(batch.shape[0]))
        if batch.shape[0] > 2:
            raise RuntimeError("CUDA out of memory: failed to allocate")
        return np.zeros((batch.shape[0], 3), dtype=np.float32)

    tagger._run_inference = fake_run

    inputs = [np.zeros((4, 4, 3), dtype=np.float32) for _ in range(4)]
    results, info = tagger._run_true_batch_with_backoff(
        inputs,
        [0, 1, 2, 3],
        ["a", "b", "c", "d"],
        initial_chunk_size=4,
        retry_cooldown_seconds=0,
    )

    assert run_sizes[0] == 4
    assert all(size <= 2 for size in run_sizes[1:])
    assert all(result == {"ok": True} for result in results)
    assert info["attempted_gpu_backoff"] is True
    assert info["used_cpu_fallback"] is False
    assert info["backoff_steps"][0]["mode"] == "gpu_backoff"
    assert info["backoff_steps"][0]["from"] == 4
    assert info["backoff_steps"][0]["to"] == 2
    assert tagger._learned_stable_gpu_batch_size == 2
    assert recreated["n"] >= 1


def test_run_true_batch_empty_prepared_returns_empty_runtime_info():
    tagger = _bare()
    results, info = tagger._run_true_batch_with_backoff([], [], ["a", "b"])
    assert results == [None, None]
    assert info == {
        "initial_chunk_size": 0,
        "final_chunk_size": 0,
        "backoff_steps": [],
        "used_cpu_fallback": False,
        "attempted_gpu_backoff": False,
    }


def test_runtime_chunk_size_rules():
    zero = _bare(_supports_true_batch=True)
    zero._session_uses_gpu = lambda: False
    assert zero._runtime_chunk_size(0, None) == 0

    single = _bare(_supports_true_batch=False)
    single._session_uses_gpu = lambda: False
    assert single._runtime_chunk_size(5, 8) == 1  # no true batch -> 1

    preferred = _bare(_supports_true_batch=True, _learned_stable_gpu_batch_size=None)
    preferred._session_uses_gpu = lambda: False
    assert preferred._runtime_chunk_size(10, 4) == 4  # min(count, preferred)

    learned = _bare(_supports_true_batch=True, _learned_stable_gpu_batch_size=2)
    learned._session_uses_gpu = lambda: True
    assert learned._runtime_chunk_size(10, 8) == 2  # learned GPU cap wins


def test_empty_runtime_info_shape():
    assert WD14Tagger._empty_runtime_info() == {
        "initial_chunk_size": 0,
        "final_chunk_size": 0,
        "backoff_steps": [],
        "used_cpu_fallback": False,
        "attempted_gpu_backoff": False,
    }


def test_merge_runtime_info_takes_max_initial_min_final_or_flags():
    total = WD14Tagger._empty_runtime_info()
    WD14Tagger._merge_runtime_info(
        total,
        {
            "initial_chunk_size": 4,
            "final_chunk_size": 2,
            "backoff_steps": [{"from": 4, "to": 2}],
            "used_cpu_fallback": False,
            "attempted_gpu_backoff": True,
        },
    )
    WD14Tagger._merge_runtime_info(
        total,
        {
            "initial_chunk_size": 8,
            "final_chunk_size": 1,
            "backoff_steps": [{"from": 8, "to": 4}],
            "used_cpu_fallback": True,
            "attempted_gpu_backoff": False,
        },
    )
    assert total["initial_chunk_size"] == 8  # max
    assert total["final_chunk_size"] == 1  # min of non-zero
    assert total["used_cpu_fallback"] is True
    assert total["attempted_gpu_backoff"] is True
    assert len(total["backoff_steps"]) == 2


# ===========================================================================
# 5. Singleton lifecycle + configured proxy (facade-critical)
# ===========================================================================
def _prime_singleton(monkeypatch):
    monkeypatch.setattr(tagger_module, "ort", _FakeOrt)
    monkeypatch.setattr(tagger_module, "hf_hub", object())
    monkeypatch.setattr(tagger_module, "_tagger", None)
    monkeypatch.setattr(tagger_module, "_current_settings", {})


def test_get_tagger_reuses_shared_instance_when_settings_unchanged(monkeypatch):
    _prime_singleton(monkeypatch)
    first = tagger_module.get_tagger(model_name="wd-swinv2-tagger-v3", use_gpu=False)
    second = tagger_module.get_tagger(model_name="wd-swinv2-tagger-v3", use_gpu=False)
    assert second._tagger is first._tagger


def test_get_tagger_force_reload_rebuilds_instance(monkeypatch):
    _prime_singleton(monkeypatch)
    first = tagger_module.get_tagger(model_name="wd-swinv2-tagger-v3", use_gpu=False)
    reloaded = tagger_module.get_tagger(
        model_name="wd-swinv2-tagger-v3", use_gpu=False, force_reload=True
    )
    assert reloaded._tagger is not first._tagger


def test_get_tagger_rebuilds_when_use_gpu_changes(monkeypatch):
    _prime_singleton(monkeypatch)
    first = tagger_module.get_tagger(model_name="wd-swinv2-tagger-v3", use_gpu=False)
    switched = tagger_module.get_tagger(model_name="wd-swinv2-tagger-v3", use_gpu=True)
    assert switched._tagger is not first._tagger


def test_configured_proxy_delegates_unknown_attrs_to_underlying_tagger():
    class _Rec:
        model_name = "underlying"

    proxy = tagger_module._ConfiguredTaggerProxy(
        _Rec(), threshold=0.8, character_threshold=0.9
    )
    assert proxy.model_name == "underlying"  # __getattr__ passthrough


def test_configured_proxy_tag_batch_setdefaults_thresholds_but_explicit_wins():
    class _Rec:
        def __init__(self):
            self.calls: List[dict] = []

        def tag_batch(self, image_paths, **kwargs):
            self.calls.append(kwargs)
            return []

    rec = _Rec()
    proxy = tagger_module._ConfiguredTaggerProxy(
        rec, threshold=0.8, character_threshold=0.9, copyright_threshold=0.7
    )
    proxy.tag_batch(["a"])
    assert rec.calls[0] == {
        "threshold": 0.8,
        "character_threshold": 0.9,
        "copyright_threshold": 0.7,
    }
    proxy.tag_batch(["a"], threshold=0.1)
    assert rec.calls[1]["threshold"] == 0.1  # explicit kwarg overrides default


def test_get_available_models_lists_registry_keys():
    models = tagger_module.get_available_models()
    assert models == list(tagger_module.MODELS.keys())
    assert tagger_module.DEFAULT_MODEL in models


def test_tag_image_delegates_to_get_tagger_with_threshold(monkeypatch):
    captured = {}

    class _Rec:
        def tag(self, image_path):
            captured["image_path"] = image_path
            return {"ok": True}

    def fake_get_tagger(threshold=0.35, **_kwargs):
        captured["threshold"] = threshold
        return _Rec()

    monkeypatch.setattr(tagger_module, "get_tagger", fake_get_tagger)
    result = tagger_module.tag_image("/some/img.png", threshold=0.42)
    assert result == {"ok": True}
    assert captured == {"threshold": 0.42, "image_path": "/some/img.png"}


# ===========================================================================
# 6. Preprocessing + metadata + rating
# ===========================================================================
def test_preprocess_imagenet_normalization_emits_nchw_float32():
    tagger = _bare(
        _input_hw=(64, 64),
        _resize_mode="letterbox",
        _pad_color=(255, 255, 255),
        _input_normalization="imagenet",
        _input_layout="nchw",
    )
    arr = tagger._preprocess(Image.new("RGB", (64, 64), (255, 255, 255)))
    assert arr.shape == (3, 64, 64)  # channels-first
    assert arr.dtype == np.float32
    assert np.isfinite(arr).all()


def test_preprocess_minus_one_to_one_stretch_stays_in_range_and_nhwc():
    tagger = _bare(
        _input_hw=(32, 32),
        _resize_mode="stretch",
        _pad_color=(255, 255, 255),
        _input_normalization="minus_one_to_one",
        _input_layout="nhwc",
    )
    arr = tagger._preprocess(Image.new("RGB", (10, 20), (128, 128, 128)))
    assert arr.shape == (32, 32, 3)
    assert arr.min() >= -1.0 - 1e-6
    assert arr.max() <= 1.0 + 1e-6


def test_load_tags_wd14_csv_buckets_by_numeric_category(tmp_path):
    csv_path = tmp_path / "selected_tags.csv"
    csv_path.write_text(
        "name,category\n1girl,0\nblue_archive,3\nshiroko,4\ngeneral,9\nsensitive,9\n",
        encoding="utf-8",
    )
    tagger = _bare(_metadata_format="wd14_csv")
    tagger._load_tags(str(csv_path))

    assert tagger.tags == ["1girl", "blue_archive", "shiroko", "general", "sensitive"]
    assert tagger.general_tags == [(0, "1girl")]
    assert tagger.copyright_tags == [(1, "blue_archive")]
    assert tagger.character_tags == [(2, "shiroko")]
    assert tagger.rating_tags == [(3, "general"), (4, "sensitive")]
    assert tagger.rating_indices == {"general": 3, "sensitive": 4}


def test_load_tags_camie_json_records_general_category_overrides(tmp_path):
    """Camie's artist/year/meta entries live in the general bucket but keep
    their TRUE category in _general_category_overrides (the export engine's
    {artists} section reads it); rating names are stripped of the prefix."""
    metadata = {
        "dataset_info": {
            "tag_mapping": {
                "idx_to_tag": {
                    "0": "1girl",
                    "1": "by_artistx",
                    "2": "2023",
                    "3": "rating_explicit",
                    "4": "chara_y",
                },
                "tag_to_category": {
                    "1girl": "general",
                    "by_artistx": "artist",
                    "2023": "year",
                    "rating_explicit": "rating",
                    "chara_y": "character",
                },
            }
        }
    }
    json_path = tmp_path / "camie-metadata.json"
    json_path.write_text(json.dumps(metadata), encoding="utf-8")

    tagger = _bare(_metadata_format="camie_v2")
    tagger._load_tags(str(json_path))

    assert (0, "1girl") in tagger.general_tags
    assert (1, "by_artistx") in tagger.general_tags
    assert (2, "2023") in tagger.general_tags
    assert tagger._general_category_overrides == {
        "by_artistx": "artist",
        "2023": "year",
    }
    assert "1girl" not in tagger._general_category_overrides
    assert tagger.character_tags == [(4, "chara_y")]
    assert tagger.rating_tags == [(3, "explicit")]  # 'rating_' prefix stripped
    assert tagger.rating_indices == {"explicit": 3}


def test_derive_fallback_rating_marker_precedence():
    derive = _bare()._derive_fallback_rating
    assert derive({"general_tags": [{"tag": "pussy"}]}) == "explicit"
    assert derive({"general_tags": [{"tag": "bikini"}]}) == "questionable"
    assert derive({"general_tags": [{"tag": "midriff"}]}) == "sensitive"
    assert derive({"general_tags": [{"tag": "1girl"}]}) == "general"
    assert derive({"general_tags": []}) == "unknown"


def test_normalize_output_probs_unknown_activation_zeroes_out_of_range():
    tagger = _bare(_output_activation="mystery_activation")
    out = tagger._normalize_output_probs(np.array([0.5, 1.5], dtype=np.float32))
    # Unknown activation -> treated as probabilities; out-of-range score zeroed.
    assert out[0] == pytest.approx(0.5)
    assert out[1] == 0.0


def test_build_empty_result_shape_and_optional_error():
    result = _bare()._build_empty_result()
    assert set(result) == {
        "general_tags",
        "copyright_tags",
        "character_tags",
        "rating",
        "rating_confidences",
        "all_tags",
    }
    assert result["rating"] == "unknown"
    assert _bare()._build_empty_result("boom")["error"] == "boom"


# ===========================================================================
# 7. tag_batch guardrails + per-image preprocess isolation
# ===========================================================================
def test_tag_batch_empty_list_short_circuits_without_load():
    tagger = _bare()
    assert tagger.tag_batch([]) == []
    empty, info = tagger.tag_batch([], return_runtime_info=True)
    assert empty == []
    assert info == WD14Tagger._empty_runtime_info()


def test_preprocess_paths_single_image_isolates_open_failure():
    tagger = _bare()
    prepared = tagger._preprocess_paths(["/definitely/not/a/real/image.png"])
    assert len(prepared) == 1
    assert isinstance(prepared[0], Exception)
