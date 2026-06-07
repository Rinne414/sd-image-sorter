"""Backend tests for the OppaiOracle V1.1 ONNX tagger backend.

These pin three things that are silently catastrophic if they regress:

1. The preprocessing math matches the model card exactly.
   - Letterbox to 448x448 keeping aspect ratio
   - Pad with RGB [114, 114, 114]
   - Normalize (x/255 - 0.5) / 0.5 per channel
   - Layout BCHW (channels-first), dtype float32
   - Padding mask is True on the gray bars and False on the actual image
2. The tag table loader puts general tags / rating tags into the right
   buckets and skips ``<PAD>`` / ``<UNK>``.
3. ``TAGGER_MODELS["oppai-oracle-v1.1"]`` exposes the values the tagging
   service relies on (default_threshold, runtime_backend, etc.).

These tests are deliberately self-contained: they do not download the real
ONNX file or load the real session. The smoke-test script under
``.tmp/oppai_oracle_smoke.py`` covers the live-inference path against real
anime images.
"""
from __future__ import annotations

import sys
import csv
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from oppai_oracle_tagger import (
    DEFAULT_MODEL,
    DEFAULT_THRESHOLD,
    OppaiOracleTagger,
    letterbox_to_square,
    preprocess_image,
)


# ---------------------------------------------------------------------------
# Preprocessing math
# ---------------------------------------------------------------------------


def test_letterbox_keeps_aspect_ratio_and_centers_image() -> None:
    """A 200x300 portrait must produce ~298 image rows centered vertically."""
    src = Image.new("RGB", (200, 300), (255, 0, 0))
    canvas, (paste_x, paste_y, new_w, new_h) = letterbox_to_square(
        src, target=448, pad_color=(114, 114, 114)
    )
    assert canvas.size == (448, 448)
    # min(448/200, 448/300) = 448/300 ≈ 1.493; new_h ≈ 448, new_w ≈ 298
    assert new_h == 448
    assert new_w == 299  # round(200 * 1.4933...) = 299
    # The image must be centered, leaving the same number of pad columns
    # on the left and the right.
    assert paste_x in {(448 - new_w) // 2, ((448 - new_w) // 2) + 1}
    assert paste_y == 0


def test_preprocess_image_returns_correct_shapes_and_range() -> None:
    src = Image.new("RGB", (200, 300), (128, 64, 192))
    pixel_values, padding_mask = preprocess_image(src)
    assert pixel_values.shape == (3, 448, 448)
    assert pixel_values.dtype == np.float32
    assert padding_mask.shape == (448, 448)
    assert padding_mask.dtype == np.bool_
    # After (x/255 - 0.5)/0.5 every pixel must be in [-1, 1].
    assert pixel_values.min() >= -1.0 - 1e-6
    assert pixel_values.max() <= 1.0 + 1e-6


def test_preprocess_image_normalizes_pad_color_to_minus_0_106() -> None:
    """Gray RGB(114,114,114) must map to (114/255 - 0.5)/0.5 ≈ -0.106."""
    src = Image.new("RGB", (200, 300), (255, 0, 0))
    pixel_values, padding_mask = preprocess_image(
        src, target=448, pad_color=(114, 114, 114)
    )
    expected_pad = (114.0 / 255.0 - 0.5) / 0.5
    # Top row is fully padded for a 200x300 portrait (paste_y=0 means no top
    # pad — switch to a square that DOES have left/right padding to avoid
    # ambiguity).
    src_square = Image.new("RGB", (300, 200), (255, 0, 0))
    pv, pm = preprocess_image(src_square, target=448, pad_color=(114, 114, 114))
    # Top rows are padded for a 300x200 landscape.
    top_row_red = pv[0, 0, :]
    top_row_green = pv[1, 0, :]
    top_row_blue = pv[2, 0, :]
    assert np.allclose(top_row_red, expected_pad, atol=1e-5)
    assert np.allclose(top_row_green, expected_pad, atol=1e-5)
    assert np.allclose(top_row_blue, expected_pad, atol=1e-5)
    # And the padding mask must mark them as padded.
    assert bool(pm[0, 0]) is True


def test_preprocess_image_marks_padded_region() -> None:
    src = Image.new("RGB", (200, 300), (255, 0, 0))
    _, padding_mask = preprocess_image(src, target=448)
    # 200x300 portrait letterboxed into 448x448 has left/right pads.
    # Total padded pixels should be the gray columns on both sides.
    assert padding_mask.sum() > 0  # some pad
    # The vertical center column of the canvas should land inside the image,
    # so the corresponding mask cell must be False.
    assert bool(padding_mask[224, 224]) is False
    # And the leftmost column should be padded.
    assert bool(padding_mask[0, 0]) is True


def test_preprocess_rgb_channel_order() -> None:
    """RGB channel order: a pure red input must put the high signal in [0]."""
    src = Image.new("RGB", (448, 448), (255, 0, 0))
    pv, _ = preprocess_image(src)
    # Channel 0 (R) saturates at +1.0; channels 1/2 (G/B) hit -1.0.
    assert pv[0].mean() == pytest.approx(1.0, abs=1e-5)
    assert pv[1].mean() == pytest.approx(-1.0, abs=1e-5)
    assert pv[2].mean() == pytest.approx(-1.0, abs=1e-5)


# ---------------------------------------------------------------------------
# Tag table loader
# ---------------------------------------------------------------------------


def _write_minimal_oppai_csv(tmp_path: Path) -> Path:
    """Write a tiny stand-in selected_tags.csv with the same shape as real.

    Layout: header + 2 dummy PAD/UNK rows + 3 general rows + 4 rating rows.
    """
    csv_path = tmp_path / "selected_tags.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["tag_id", "name", "category"])
        writer.writerow(["0", "<PAD>", "0"])
        writer.writerow(["1", "<UNK>", "0"])
        writer.writerow(["2", "1girl", "0"])
        writer.writerow(["3", "long_hair", "0"])
        writer.writerow(["4", "smile", "0"])
        writer.writerow(["5", "rating:general", "0"])
        writer.writerow(["6", "rating:sensitive", "0"])
        writer.writerow(["7", "rating:questionable", "0"])
        writer.writerow(["8", "rating:explicit", "0"])
    return csv_path


def test_tag_loader_skips_pad_and_unk_and_splits_ratings(tmp_path: Path) -> None:
    csv_path = _write_minimal_oppai_csv(tmp_path)
    tagger = OppaiOracleTagger(use_gpu=False)
    tagger._load_tags(str(csv_path))

    # All non-skip tags appear in self.tags including PAD/UNK entries.
    assert tagger.tags == [
        "<PAD>", "<UNK>", "1girl", "long_hair", "smile",
        "rating:general", "rating:sensitive", "rating:questionable", "rating:explicit",
    ]
    # General tags exclude PAD/UNK and rating tags.
    general_names = [name for _, name in tagger.general_tags]
    assert general_names == ["1girl", "long_hair", "smile"]
    # Rating tags are stripped of the "rating:" prefix.
    rating_names = [name for _, name in tagger.rating_tags]
    assert sorted(rating_names) == ["explicit", "general", "questionable", "sensitive"]
    # Rating index lookup matches the original tag_id column.
    assert tagger.rating_indices["general"] == 5
    assert tagger.rating_indices["explicit"] == 8


def test_process_probs_applies_threshold_and_picks_best_rating(tmp_path: Path) -> None:
    csv_path = _write_minimal_oppai_csv(tmp_path)
    tagger = OppaiOracleTagger(use_gpu=False, threshold=0.5)
    tagger._load_tags(str(csv_path))

    # Build a probability vector aligned with tag ids.
    probs = np.zeros(9, dtype=np.float32)
    probs[2] = 0.99   # 1girl  -> kept
    probs[3] = 0.30   # long_hair -> dropped (< 0.5)
    probs[4] = 0.80   # smile  -> kept
    probs[5] = 0.10   # rating:general
    probs[6] = 0.20   # rating:sensitive
    probs[7] = 0.85   # rating:questionable -> highest, becomes the rating
    probs[8] = 0.40   # rating:explicit

    result = tagger._process_probs(probs)
    general_names = [item["tag"] for item in result["general_tags"]]
    assert general_names == ["1girl", "smile"]
    assert result["rating"] == "questionable"
    assert result["rating_confidences"]["questionable"] == pytest.approx(0.85, abs=1e-6)
    assert result["character_tags"] == []


def test_process_probs_clips_invalid_scores(tmp_path: Path) -> None:
    csv_path = _write_minimal_oppai_csv(tmp_path)
    tagger = OppaiOracleTagger(use_gpu=False, threshold=0.5)
    tagger._load_tags(str(csv_path))

    probs = np.zeros(9, dtype=np.float32)
    probs[2] = float("nan")   # NaN must not become a high-confidence tag
    probs[3] = float("inf")   # Inf must not become a tag
    probs[4] = 1.5            # Out-of-range must be ignored
    probs[7] = 0.99           # Valid

    result = tagger._process_probs(probs)
    general_names = [item["tag"] for item in result["general_tags"]]
    assert general_names == []  # all three invalid scores were dropped
    assert result["rating"] == "questionable"


# ---------------------------------------------------------------------------
# Tagger registry / config
# ---------------------------------------------------------------------------


def test_tagger_models_registry_exposes_oppai_oracle() -> None:
    from config import TAGGER_MODELS

    assert "oppai-oracle-v1.1" in TAGGER_MODELS
    cfg = TAGGER_MODELS["oppai-oracle-v1.1"]
    assert cfg["repo_id"] == "Grio43/OppaiOracle"
    assert cfg["repo_subfolder"] == "V1.1_onnx"
    assert cfg["model_file"] == "model.onnx"
    assert cfg["tags_file"] == "selected_tags.csv"
    assert cfg["runtime_backend"] == "oppai-oracle"
    assert cfg["input_normalization"] == "minus_one_to_one"
    assert cfg["resize_mode"] == "letterbox"
    assert cfg["pad_color"] == [114, 114, 114]
    assert cfg["image_size"] == 448
    assert cfg["default_threshold"] == pytest.approx(0.7927, abs=1e-4)
    # The character threshold is set to 1.0 because the model has no
    # character category.
    assert cfg["default_character_threshold"] == 1.0


def test_default_constants_match_config() -> None:
    from config import TAGGER_MODELS
    cfg = TAGGER_MODELS[DEFAULT_MODEL]
    assert cfg["default_threshold"] == pytest.approx(DEFAULT_THRESHOLD, abs=1e-4)


def test_get_oppai_oracle_tagger_returns_singleton() -> None:
    from oppai_oracle_tagger import get_oppai_oracle_tagger
    a = get_oppai_oracle_tagger(use_gpu=False, force_reload=True)
    b = get_oppai_oracle_tagger(use_gpu=False)
    assert a is b
    # threshold update must propagate without rebuilding the singleton.
    c = get_oppai_oracle_tagger(use_gpu=False, threshold=0.5)
    assert c is a
    assert c.threshold == 0.5


# ---------------------------------------------------------------------------
# GPU OOM backoff (adaptive batch sizing)
# ---------------------------------------------------------------------------


class _FakeOrtSession:
    """Stand-in ONNX session: raises (OOM) when the batch exceeds max_batch."""

    def __init__(self, *, max_batch, providers, num_tags, fail_always=False, oom=True):
        self._max_batch = max_batch
        self._providers = list(providers)
        self._num_tags = num_tags
        self._fail_always = fail_always
        self._oom = oom
        self.run_batch_sizes = []

    def get_providers(self):
        return list(self._providers)

    def run(self, output_names, feed):
        batch = int(feed["pixel_values"].shape[0])
        self.run_batch_sizes.append(batch)
        if self._fail_always or batch > self._max_batch:
            msg = "CUDA out of memory: failed to allocate" if self._oom else "invalid input dimensions"
            raise RuntimeError(msg)
        probs = np.zeros((batch, self._num_tags), dtype=np.float32)
        probs[:, 2] = 0.99   # 1girl -> kept above the default threshold
        probs[:, 7] = 0.85   # rating:questionable
        return [probs]


def _make_fake_loaded_tagger(tmp_path: Path, *, max_batch=2, fail_always=False):
    """A tagger wired with a fake GPU session, bypassing the real ONNX load."""
    csv_path = _write_minimal_oppai_csv(tmp_path)
    tagger = OppaiOracleTagger(use_gpu=True)
    tagger._load_tags(str(csv_path))
    tagger._target = 8  # tiny canvas keeps preprocessing cheap
    tagger._pad_color = (114, 114, 114)
    tagger._resolved_model_path = "fake-model.onnx"
    tagger._loaded = True
    tagger.use_gpu = True
    tagger.session = _FakeOrtSession(
        max_batch=max_batch,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        num_tags=len(tagger.tags),
        fail_always=fail_always,
    )
    return tagger


def test_run_inference_reraises_when_cpu_fallback_disabled(tmp_path: Path) -> None:
    """allow_cpu_fallback=False must let the GPU error propagate (so the batch
    backoff can retry a SMALLER GPU batch) instead of silently dropping to CPU."""
    tagger = _make_fake_loaded_tagger(tmp_path, fail_always=True)
    pv = np.zeros((1, 3, 8, 8), dtype=np.float32)
    pm = np.zeros((1, 8, 8), dtype=bool)

    with pytest.raises(Exception):
        tagger._run_inference(pv, pm, allow_cpu_fallback=False)

    # It must NOT have rebuilt the session on CPU.
    assert tagger.use_gpu is True
    assert "CUDAExecutionProvider" in tagger.session.get_providers()


def test_tag_batch_backs_off_gpu_chunk_on_oom_and_stays_on_gpu(tmp_path: Path, monkeypatch) -> None:
    """A batch that OOMs at the requested size must retry at a halved size ON
    THE GPU (not crash, not fall to CPU permanently), and tag every image."""
    tagger = _make_fake_loaded_tagger(tmp_path, max_batch=2)
    # Keep the GPU session rebuild between backoff steps a no-op (no real model).
    monkeypatch.setattr(tagger, "_recreate_gpu_session", lambda: None)

    paths = []
    for i in range(4):
        p = tmp_path / f"img-{i}.png"
        Image.new("RGB", (12, 16), (200, 50, 50)).save(p)
        paths.append(str(p))

    results, info = tagger.tag_batch(paths, preferred_batch_size=4, return_runtime_info=True)

    # Every image tagged with the high-confidence 1girl tag.
    assert len(results) == 4
    assert all(any(t["tag"] == "1girl" for t in r["general_tags"]) for r in results)
    # Stayed on the GPU (did NOT permanently fall back to CPU after one OOM).
    assert tagger.use_gpu is True
    # Backoff happened: the 4-batch failed, then halved sub-batches succeeded.
    assert info["attempted_gpu_backoff"] is True
    assert info["initial_chunk_size"] == 4
    assert info["final_chunk_size"] <= 2
    assert tagger.session.run_batch_sizes[0] == 4
    assert all(b <= 2 for b in tagger.session.run_batch_sizes[1:])


def test_tag_batch_non_oom_error_skips_halving_and_falls_to_cpu(tmp_path: Path, monkeypatch) -> None:
    """A NON-OOM GPU error must NOT trigger batch halving (halving cannot fix it);
    it should fall straight to the CPU fallback instead of wastefully shrinking."""
    tagger = _make_fake_loaded_tagger(tmp_path, max_batch=2)
    gpu_session = _FakeOrtSession(
        max_batch=2,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        num_tags=len(tagger.tags),
        oom=False,
    )
    tagger.session = gpu_session
    cpu_session = _FakeOrtSession(
        max_batch=9999, providers=["CPUExecutionProvider"], num_tags=len(tagger.tags),
    )
    # CPU rebuild returns a session that succeeds at any size.
    monkeypatch.setattr(tagger, "_create_session", lambda *a, **k: cpu_session)
    monkeypatch.setattr(tagger, "_build_session_options", lambda **k: object())

    paths = []
    for i in range(4):
        p = tmp_path / f"n-{i}.png"
        Image.new("RGB", (10, 12), (10, 20, 30)).save(p)
        paths.append(str(p))

    results, info = tagger.tag_batch(paths, preferred_batch_size=4, return_runtime_info=True)

    assert len(results) == 4
    assert all(any(t["tag"] == "1girl" for t in r["general_tags"]) for r in results)
    # No GPU halving happened (non-OOM): the GPU session only ever saw size 4.
    assert all(step.get("mode") != "gpu_backoff" for step in info["backoff_steps"])
    assert all(b == 4 for b in gpu_session.run_batch_sizes)
    # It fell back to CPU rather than crashing or halving.
    assert tagger.use_gpu is False


def test_tag_batch_isolates_unreadable_image_and_preserves_order(tmp_path: Path) -> None:
    """A bad image in the middle of a batch must be isolated (empty result) while
    its neighbours still tag, in order (parallel preprocessing keeps order)."""
    tagger = _make_fake_loaded_tagger(tmp_path, max_batch=8)
    good = []
    for i in range(3):
        p = tmp_path / f"g-{i}.png"
        Image.new("RGB", (10, 12), (5, 5, 5)).save(p)
        good.append(str(p))
    paths = [good[0], str(tmp_path / "does-not-exist.png"), good[1], good[2]]

    results = tagger.tag_batch(paths, preferred_batch_size=8)

    assert len(results) == 4
    # Index 1 (the unreadable path) is isolated, not a crash.
    assert "error" in results[1]
    assert results[1]["general_tags"] == []
    # The readable neighbours still tagged, in order.
    for index in (0, 2, 3):
        assert any(t["tag"] == "1girl" for t in results[index]["general_tags"])
