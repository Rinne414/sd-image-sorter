"""Regression tests for heavy AI runtime crash-prevention behavior."""

from __future__ import annotations

from pathlib import Path
from typing import Any, List

import pytest
import numpy as np
from PIL import Image

import aesthetic
import similarity as similarity_module
import tagger as tagger_module
from services.censor_service import CensorService


class _FakeTorchNoCuda:
    class cuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def empty_cache() -> None:
            return None

    @staticmethod
    def no_grad():
        class _Context:
            def __enter__(self):
                return None

            def __exit__(self, *_args):
                return False

        return _Context()


class _FakeCudaOutOfMemoryError(RuntimeError):
    pass


def test_aesthetic_uses_cpu_when_cuda_headroom_is_too_low(monkeypatch):
    monkeypatch.setattr(aesthetic, "_predictor", None)
    monkeypatch.setattr(aesthetic, "_clip_model", None)
    monkeypatch.setattr(aesthetic, "_clip_preprocess", None)
    monkeypatch.setattr(aesthetic, "_device", None)
    monkeypatch.setattr(aesthetic, "_force_cpu_after_gpu_failure", False)
    monkeypatch.setattr(aesthetic, "_get_torch_module", lambda: _FakeTorchNoCuda)
    monkeypatch.setattr(aesthetic, "_cuda_has_headroom", lambda *_args, **_kwargs: False)

    selected = aesthetic._select_device(use_gpu=True)

    assert selected == "cpu"


def test_aesthetic_gpu_oom_unloads_and_retries_on_cpu(monkeypatch, tmp_path: Path):
    image_path = tmp_path / "score.png"
    Image.new("RGB", (16, 16), color="white").save(image_path)

    calls: List[str] = []

    class _FakeTensor:
        def unsqueeze(self, _dim: int):
            return self

        def to(self, device: str):
            calls.append(f"tensor:{device}")
            return self

        def half(self):
            return self

    class _FakeClipModel:
        def __init__(self, device: str):
            self.device = device

        def encode_image(self, _tensor: Any):
            if self.device == "cuda":
                raise _FakeCudaOutOfMemoryError("CUDA out of memory")
            return _FakeFeatures()

    class _FakeFeatures:
        def norm(self, dim: int = -1, keepdim: bool = True):
            return 1

        def __truediv__(self, _other):
            return self

        def float(self):
            return self

    class _FakeScore:
        def item(self):
            return 7.25

    class _FakePredictor:
        def __call__(self, _features: Any):
            return _FakeScore()

    monkeypatch.setattr(aesthetic, "_predictor", None)
    monkeypatch.setattr(aesthetic, "_clip_model", None)
    monkeypatch.setattr(aesthetic, "_clip_preprocess", None)
    monkeypatch.setattr(aesthetic, "_device", None)
    monkeypatch.setattr(aesthetic, "_force_cpu_after_gpu_failure", False)
    monkeypatch.setattr(aesthetic, "_get_torch_module", lambda: _FakeTorchNoCuda)
    monkeypatch.setattr(aesthetic, "_select_device", lambda use_gpu=True: "cuda" if use_gpu else "cpu")
    monkeypatch.setattr(aesthetic, "_is_cuda_oom", lambda exc: "out of memory" in str(exc).lower())
    monkeypatch.setattr(aesthetic, "_load_predictor", lambda device=None: _install_fake_aesthetic(aesthetic, device, calls, _FakeClipModel, _FakePredictor, _FakeTensor))
    monkeypatch.setattr(aesthetic, "_unload_models", lambda: _fake_unload_aesthetic(aesthetic, calls))

    assert aesthetic.predict_score(str(image_path)) == 7.25
    assert calls.count("load:cuda") == 1
    assert calls.count("unload") == 1
    assert calls.count("load:cpu") == 1
    assert aesthetic._force_cpu_after_gpu_failure is True


def _install_fake_aesthetic(module, device, calls, model_cls, predictor_cls, tensor_cls):
    selected_device = device or "cuda"
    calls.append(f"load:{selected_device}")
    module._device = selected_device
    module._clip_model = model_cls(selected_device)
    module._clip_preprocess = lambda _image: tensor_cls()
    module._predictor = predictor_cls()


def _fake_unload_aesthetic(module, calls):
    calls.append("unload")
    module._predictor = None
    module._clip_model = None
    module._clip_preprocess = None
    module._device = None


def test_tagger_batch_preprocesses_only_runtime_chunks(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(tagger_module, "_ensure_imports", lambda: None)

    image_paths = []
    for index in range(6):
        path = tmp_path / f"image-{index}.png"
        Image.new("RGB", (8, 8), color="white").save(path)
        image_paths.append(str(path))

    tagger = tagger_module.WD14Tagger(use_gpu=True)
    tagger._loaded = True
    tagger.session = object()
    tagger._input_name = "input"
    tagger._supports_true_batch = True
    tagger._input_hw = (8, 8)
    monkeypatch.setattr(tagger, "_session_uses_gpu", lambda: True)
    tagger.general_tags = [(0, "safe")]
    tagger.threshold = 0.5

    max_live_inputs = 0

    def fake_run_true_batch(
        prepared_inputs,
        prepared_indices,
        paths,
        *,
        initial_chunk_size=None,
        min_chunk_size=1,
        **_threshold_kwargs,
    ):
        nonlocal max_live_inputs
        max_live_inputs = max(max_live_inputs, len(prepared_inputs))
        results = [None] * len(paths)
        for source_index in prepared_indices:
            results[source_index] = tagger._build_empty_result()
        return results, {
            "initial_chunk_size": len(prepared_inputs),
            "final_chunk_size": len(prepared_inputs),
            "backoff_steps": [],
            "used_cpu_fallback": False,
            "attempted_gpu_backoff": False,
        }

    monkeypatch.setattr(tagger, "_run_true_batch_with_backoff", fake_run_true_batch)
    monkeypatch.setattr(tagger, "_preprocess", lambda _image: np.zeros((8, 8, 3), dtype=np.float32))

    results, info = tagger.tag_batch(image_paths, preferred_batch_size=2, return_runtime_info=True)

    assert len(results) == 6
    assert max_live_inputs == 2
    assert info["initial_chunk_size"] == 2
    assert info["final_chunk_size"] == 2


def test_tagger_batch_uses_updated_runtime_chunk_for_next_preprocess_window(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(tagger_module, "_ensure_imports", lambda: None)

    image_paths = []
    for index in range(8):
        path = tmp_path / f"backoff-{index}.png"
        Image.new("RGB", (8, 8), color="white").save(path)
        image_paths.append(str(path))

    tagger = tagger_module.WD14Tagger(use_gpu=True)
    tagger._loaded = True
    tagger.session = object()
    tagger._input_name = "input"
    tagger._supports_true_batch = True
    tagger._input_hw = (8, 8)
    tagger.general_tags = [(0, "safe")]
    tagger.threshold = 0.5
    monkeypatch.setattr(tagger, "_session_uses_gpu", lambda: True)
    monkeypatch.setattr(tagger, "_preprocess", lambda _image: np.zeros((8, 8, 3), dtype=np.float32))

    prepared_window_sizes: List[int] = []

    def fake_run_true_batch(
        prepared_inputs,
        prepared_indices,
        paths,
        *,
        initial_chunk_size=None,
        min_chunk_size=1,
        **_threshold_kwargs,
    ):
        prepared_window_sizes.append(len(prepared_inputs))
        if len(prepared_inputs) == 4:
            tagger._learned_stable_gpu_batch_size = 2
            final_size = 2
        else:
            final_size = len(prepared_inputs)
        results = [None] * len(paths)
        for source_index in prepared_indices:
            results[source_index] = tagger._build_empty_result()
        return results, {
            "initial_chunk_size": len(prepared_inputs),
            "final_chunk_size": final_size,
            "backoff_steps": [{"from": 4, "to": 1}] if len(prepared_inputs) == 4 else [],
            "used_cpu_fallback": False,
            "attempted_gpu_backoff": len(prepared_inputs) == 4,
        }

    monkeypatch.setattr(tagger, "_run_true_batch_with_backoff", fake_run_true_batch)

    results, info = tagger.tag_batch(image_paths, preferred_batch_size=4, return_runtime_info=True)

    assert len(results) == 8
    assert prepared_window_sizes == [4, 2, 2]
    assert info["initial_chunk_size"] == 4
    assert info["final_chunk_size"] == 2
    assert info["attempted_gpu_backoff"] is True


def test_wd14_non_oom_batch_error_skips_gpu_halving(monkeypatch, tmp_path: Path):
    """A non-OOM batch error must NOT halve the GPU batch (halving cannot fix it);
    it goes straight to the CPU fallback instead of wastefully shrinking 4 -> 1."""
    monkeypatch.setattr(tagger_module, "_ensure_imports", lambda: None)

    image_paths = []
    for index in range(4):
        path = tmp_path / f"nonoom-{index}.png"
        Image.new("RGB", (8, 8), color="white").save(path)
        image_paths.append(str(path))

    tagger = tagger_module.WD14Tagger(use_gpu=True)
    tagger._loaded = True
    tagger.session = object()
    tagger._input_name = "input"
    tagger._supports_true_batch = True
    tagger._input_hw = (8, 8)
    tagger.general_tags = [(0, "safe")]
    tagger.threshold = 0.5
    monkeypatch.setattr(tagger, "_session_uses_gpu", lambda: tagger.use_gpu)
    monkeypatch.setattr(tagger, "_preprocess", lambda _image: np.zeros((8, 8, 3), dtype=np.float32))

    cpu_fallbacks = {"count": 0}

    def fake_run_inference(input_data, *, allow_gpu_fallback=True):
        # The batched call (>1 row) raises a NON-OOM error; single-row runs succeed.
        if input_data.shape[0] > 1:
            raise RuntimeError("invalid input dimensions for node")
        return np.zeros((1, 1), dtype=np.float32)

    def fake_cpu_fallback(_error):
        cpu_fallbacks["count"] += 1
        tagger.use_gpu = False

    monkeypatch.setattr(tagger, "_run_inference", fake_run_inference)
    monkeypatch.setattr(tagger, "_fallback_to_cpu_session", fake_cpu_fallback)

    results, info = tagger.tag_batch(image_paths, preferred_batch_size=4, return_runtime_info=True)

    assert len(results) == 4
    # Non-OOM: no GPU batch-halving steps...
    assert all(step.get("mode") != "gpu_backoff" for step in info["backoff_steps"])
    # ...it went straight to the CPU fallback exactly once.
    assert cpu_fallbacks["count"] == 1
    assert info["used_cpu_fallback"] is True


def test_wd14_tag_batch_isolates_unreadable_image(monkeypatch, tmp_path: Path):
    """A bad image is isolated (empty result) while readable neighbours tag, in
    order — parallel preprocessing must preserve order + per-image isolation."""
    monkeypatch.setattr(tagger_module, "_ensure_imports", lambda: None)

    good = []
    for index in range(2):
        path = tmp_path / f"ok-{index}.png"
        Image.new("RGB", (8, 8), color="white").save(path)
        good.append(str(path))
    paths = [good[0], str(tmp_path / "missing.png"), good[1]]

    tagger = tagger_module.WD14Tagger(use_gpu=True)
    tagger._loaded = True
    tagger.session = object()
    tagger._input_name = "input"
    tagger._supports_true_batch = True
    tagger._input_hw = (8, 8)
    tagger.general_tags = [(0, "safe")]
    tagger.threshold = 0.5
    monkeypatch.setattr(tagger, "_session_uses_gpu", lambda: True)
    monkeypatch.setattr(tagger, "_preprocess", lambda _image: np.zeros((8, 8, 3), dtype=np.float32))

    def fake_backoff(prepared_inputs, prepared_indices, paths_arg, **_kw):
        results = [None] * len(paths_arg)
        for source_index in prepared_indices:
            result = tagger._build_empty_result()
            result["general_tags"] = [{"tag": "safe", "confidence": 1.0}]
            results[source_index] = result
        return results, {
            "initial_chunk_size": len(prepared_inputs),
            "final_chunk_size": len(prepared_inputs),
            "backoff_steps": [],
            "used_cpu_fallback": False,
            "attempted_gpu_backoff": False,
        }

    monkeypatch.setattr(tagger, "_run_true_batch_with_backoff", fake_backoff)

    results = tagger.tag_batch(paths, preferred_batch_size=8)

    assert len(results) == 3
    assert "error" in results[1]
    for index in (0, 2):
        assert results[index]["general_tags"][0]["tag"] == "safe"


class _NoFetchAllCursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self.position = 0
        self.last_query = ""
        self.params = ()

    def execute(self, query, params=()):
        self.last_query = query
        self.params = params
        self.position = 0

    def fetchone(self):
        if "WHERE id = ?" in self.last_query:
            image_id = self.params[0]
            for row in self.rows:
                if row[0] == image_id:
                    return (row[0], row[3])
            return None
        return None

    def fetchmany(self, size):
        rows = []
        excluded_id = self.params[0] if self.params else None
        while self.position < len(self.rows) and len(rows) < size:
            row = self.rows[self.position]
            self.position += 1
            if excluded_id is not None and row[0] == excluded_id:
                continue
            rows.append(row)
        return rows

    def fetchall(self):
        raise AssertionError("similarity search must stream with fetchmany, not fetchall")


class _NoFetchAllConnection:
    def __init__(self, rows):
        self.cursor_obj = _NoFetchAllCursor(rows)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.cursor_obj


class _NoFetchAllDb:
    def __init__(self, rows):
        self.rows = rows

    def get_db(self):
        return _NoFetchAllConnection(self.rows)


def test_similarity_search_streams_candidates_without_fetchall(monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_SEARCH_CHUNK_SIZE", 2)
    query = similarity_module.embedding_to_bytes(np.array([1.0, 0.0], dtype=np.float32))
    high = similarity_module.embedding_to_bytes(np.array([0.98, 0.02], dtype=np.float32))
    medium = similarity_module.embedding_to_bytes(np.array([0.7, 0.3], dtype=np.float32))
    low = similarity_module.embedding_to_bytes(np.array([0.0, 1.0], dtype=np.float32))
    rows = [
        (1, "/tmp/query.png", "query.png", query),
        (2, "/tmp/high.png", "high.png", high),
        (3, "/tmp/medium.png", "medium.png", medium),
        (4, "/tmp/low.png", "low.png", low),
    ]

    index = similarity_module.SimilarityIndex(_NoFetchAllDb(rows))

    result = index.search_by_id(1, limit=2, threshold=0.1)

    assert [item["id"] for item in result["results"]] == [2, 3]
    assert result["total"] == 2
    assert result["has_more"] is False


def test_similarity_search_rejects_unsafe_pagination_window(monkeypatch):
    monkeypatch.setattr(similarity_module, "SIMILARITY_SEARCH_MAX_WINDOW", 3)
    index = similarity_module.SimilarityIndex(_NoFetchAllDb([]))

    with pytest.raises(similarity_module.SimilaritySearchWindowTooLargeError):
        index._normalize_similarity_window(limit=3, offset=1)


def test_censor_edit_budget_rejects_too_many_stroke_points(monkeypatch):
    monkeypatch.setattr("services.censor_service.MAX_EDIT_STROKE_POINTS", 3)
    operations = [
        {
            "kind": "stroke",
            "tool": "brush",
            "points": [{"x": index, "y": index} for index in range(4)],
        }
    ]

    with pytest.raises(Exception) as exc_info:
        CensorService._validate_edit_operation_budget(operations, image_size=(100, 100))

    assert getattr(exc_info.value, "status_code", None) == 413
    assert "brush points" in str(getattr(exc_info.value, "detail", ""))


def test_censor_mask_ref_applies_crop_without_full_image_alpha(monkeypatch, tmp_path: Path):
    mask_path = tmp_path / "mask.png"
    Image.new("L", (4, 4), color=255).save(mask_path)
    monkeypatch.setattr(
        CensorService,
        "_get_cached_mask_entry",
        classmethod(lambda cls, _ref: {"path": str(mask_path), "bounds": [1, 1, 5, 5]}),
    )

    calls = []

    def fake_apply_crop(cls, image, original_image, mask_crop, bbox, **kwargs):
        calls.append((mask_crop.size, bbox, kwargs["style"]))

    monkeypatch.setattr(CensorService, "_apply_mask_crop_style", classmethod(fake_apply_crop))

    image = Image.new("RGBA", (100, 100), color="white")
    original = image.copy()
    CensorService._apply_mask_effect_operation(
        image,
        original,
        {"kind": "mask_effect", "mask_ref": "abc", "style": "mosaic"},
    )

    assert calls == [((4, 4), (1, 1, 5, 5), "mosaic")]


def test_tag_export_batch_reads_images_and_tags_per_chunk(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from services import tag_export_service

    image_calls = []
    tag_calls = []

    def fake_get_images_by_ids(image_ids):
        image_calls.append(list(image_ids))
        return {
            image_id: {
                "id": image_id,
                "filename": f"image-{image_id}.png",
                "prompt": f"prompt {image_id}",
            }
            for image_id in image_ids
        }

    def fake_get_image_tags_map(image_ids):
        tag_calls.append(list(image_ids))
        return {image_id: [{"tag": f"tag_{image_id}"}] for image_id in image_ids}

    monkeypatch.setattr(tag_export_service.db, "get_images_by_ids", fake_get_images_by_ids)
    monkeypatch.setattr(tag_export_service.db, "get_image_tags_map", fake_get_image_tags_map)

    request = SimpleNamespace(
        image_ids=[1, 2, 3, 4],
        output_folder=str(tmp_path),
        blacklist=[],
        prefix="",
        content_mode="tags",
        overwrite_policy="unique",
    )

    result = tag_export_service.export_tags_batch_request(
        request,
        id_chunks=iter([[1, 2], [3, 4]]),
        total=4,
    )

    assert result["exported"] == 4
    assert image_calls == [[1, 2], [3, 4]]
    assert tag_calls == [[1, 2], [3, 4]]
