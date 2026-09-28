"""deepghs anime_aesthetic: a seven-grade anime aesthetic classifier (ONNX).

The model gives probabilities for masterpiece ... worst. The app turns them
into a continuous score (0 = worst ... 6 = masterpiece), places that score
among the model's published reference samples (percentile), and names the
grade from the percentile, the same way deepghs' own tooling does.
"""

from __future__ import annotations

import dataclasses
import hashlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import anime_aesthetic as anime

MODEL_BYTES = b"model-bytes"
SAMPLES_BYTES = b"samples-bytes"


@pytest.fixture
def models_dir(tmp_path: Path, monkeypatch) -> Path:
    folder = tmp_path / "models-aesthetic"
    folder.mkdir()
    monkeypatch.setattr(anime, "models_dir", lambda: folder)
    monkeypatch.setattr(
        anime,
        "MODEL_FILE",
        dataclasses.replace(
            anime.MODEL_FILE, sha256=hashlib.sha256(MODEL_BYTES).hexdigest()
        ),
    )
    monkeypatch.setattr(
        anime,
        "SAMPLES_FILE",
        dataclasses.replace(
            anime.SAMPLES_FILE, sha256=hashlib.sha256(SAMPLES_BYTES).hexdigest()
        ),
    )
    import pinned_download

    monkeypatch.setattr(
        pinned_download, "get_hf_endpoint_order", lambda **_: ["https://huggingface.co"]
    )
    return folder


def _download(url: str, dest: Path, *, timeout: int) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(SAMPLES_BYTES if url.endswith("samples.npz") else MODEL_BYTES)
    return dest


# --- pinned files --------------------------------------------------------------


def test_both_files_are_pinned_to_one_commit() -> None:
    revision = "a83ab545e1d2a869f1180b99b2a7dee22ec3b97e"
    assert anime.MODEL_FILE == anime.pinned_download.PinnedFile(
        repo="deepghs/anime_aesthetic",
        revision=revision,
        remote_path="swinv2pv3_v0_448_ls0.2_x/model.onnx",
        sha256="174a988ff458e84bd28c2a71cd22a5e7e160ec2518e501efbdfc3de1d09d82a2",
        size_bytes=418_260_629,
    )
    assert anime.SAMPLES_FILE == anime.pinned_download.PinnedFile(
        repo="deepghs/anime_aesthetic",
        revision=revision,
        remote_path="swinv2pv3_v0_448_ls0.2_x/samples.npz",
        sha256="f37d22a7fbfb2748c007cefddf7b4c95602cb5037f847a81ab47fc5d4c1df013",
        size_bytes=20_515_784,
    )


def test_prepare_places_both_files_and_health_turns_ready(models_dir: Path) -> None:
    assert anime.health()["available"] is False

    paths = anime.prepare(_download)

    assert Path(paths["model_path"]).read_bytes() == MODEL_BYTES
    assert Path(paths["samples_path"]).read_bytes() == SAMPLES_BYTES
    assert Path(paths["model_path"]).parent == models_dir
    assert anime.is_installed() is True
    assert anime.health()["message_key"] == "models.aestheticAnime.ready"


def test_one_file_alone_is_not_ready(models_dir: Path) -> None:
    anime.model_path().write_bytes(MODEL_BYTES)

    assert anime.is_installed() is False
    assert anime.health()["message_key"] == "models.aestheticAnime.partial"


# --- the maths -----------------------------------------------------------------


def test_the_score_weights_each_grade_by_its_rank() -> None:
    masterpiece_first = [1, 0, 0, 0, 0, 0, 0]
    worst_last = [0, 0, 0, 0, 0, 0, 1]
    half_good_half_normal = [0, 0, 0, 0.5, 0.5, 0, 0]

    assert anime.score_from_probabilities(np.array(masterpiece_first)) == 6.0
    assert anime.score_from_probabilities(np.array(worst_last)) == 0.0
    assert anime.score_from_probabilities(np.array(half_good_half_normal)) == 2.5


def test_the_percentile_interpolates_and_clamps_to_the_samples() -> None:
    xs = np.array([1.0, 2.0, 3.0])
    ys = np.array([0.1, 0.5, 0.9])

    assert anime.percentile_for(2.5, xs, ys) == pytest.approx(0.7)
    assert anime.percentile_for(-5.0, xs, ys) == pytest.approx(0.1)
    assert anime.percentile_for(9.0, xs, ys) == pytest.approx(0.9)


@pytest.mark.parametrize(
    ("percentile", "grade"),
    [
        (0.99, "masterpiece"),
        (0.95, "masterpiece"),
        (0.9499, "best"),
        (0.85, "best"),
        (0.80, "great"),
        (0.50, "good"),
        (0.30, "normal"),
        (0.10, "low"),
        (0.0999, "worst"),
    ],
)
def test_the_grade_follows_the_percentile(percentile: float, grade: str) -> None:
    assert anime.grade_for(percentile) == grade


def test_transparent_pixels_are_judged_on_white() -> None:
    picture = Image.new("RGBA", (10, 20), (0, 0, 0, 0))
    picture.putpixel((0, 0), (0, 0, 0, 255))

    batch = anime.preprocess(picture)

    assert batch.shape == (1, 3, 448, 448)
    assert batch.dtype == np.float32
    assert batch.max() == pytest.approx(1.0)
    assert batch.min() >= -1.0
    assert batch[0, :, 447, 447].tolist() == pytest.approx([1.0, 1.0, 1.0])


# --- prediction ------------------------------------------------------------------


class _Session:
    def __init__(self, probabilities):
        self.probabilities = np.array([probabilities], dtype=np.float32)
        self.fed = []

    def get_inputs(self):
        return [type("Input", (), {"name": "input"})()]

    def get_outputs(self):
        return [type("Output", (), {"name": "output"})()]

    def run(self, outputs, feeds):
        self.fed.append((outputs, {k: v.shape for k, v in feeds.items()}))
        return [self.probabilities]


def test_predict_returns_score_percentile_and_grade(
    models_dir: Path, monkeypatch
) -> None:
    anime.model_path().write_bytes(MODEL_BYTES)
    xs = np.linspace(0.0, 6.0, 61)
    np.savez(anime.samples_path(), np.stack([xs, xs / 6.0]))
    session = _Session([0.1, 0.8, 0.1, 0, 0, 0, 0])
    monkeypatch.setattr(anime, "_open_session", lambda _path, *, use_gpu: session)
    anime.unload()

    result = anime.predict(Image.new("RGB", (64, 32), (200, 100, 50)), use_gpu=False)

    assert result.score == pytest.approx(5.0)
    assert result.percentile == pytest.approx(5.0 / 6.0, abs=1e-4)
    assert result.grade == "great"
    assert session.fed == [(["output"], {"input": (1, 3, 448, 448)})]
    anime.unload()


def test_a_gpu_session_takes_its_turn_among_resident_gpu_models(
    models_dir: Path, monkeypatch
) -> None:
    claims, forgets = [], []
    monkeypatch.setattr(anime, "_open_session", lambda _path, *, use_gpu: object())
    monkeypatch.setattr(anime, "_load_samples", lambda _path: (None, None))
    monkeypatch.setattr(
        anime, "claim_gpu_residency", lambda owner, release, *, label: claims.append(label)
    )
    monkeypatch.setattr(anime, "forget_gpu_residency", lambda owner: forgets.append(owner))
    monkeypatch.setattr(anime, "_cuda_provider_available", lambda: True)
    anime.unload()
    forgets.clear()

    anime.load(use_gpu=False)
    assert claims == []
    anime.load(use_gpu=True)
    assert claims == ["anime-aesthetic"]
    before_unload = len(forgets)

    anime.unload()
    assert len(forgets) == before_unload + 1



def test_a_cpu_only_runtime_does_not_evict_gpu_models(models_dir: Path, monkeypatch) -> None:
    claims, opened = [], []
    monkeypatch.setattr(
        anime, "_open_session", lambda _path, *, use_gpu: opened.append(use_gpu) or object()
    )
    monkeypatch.setattr(anime, "_load_samples", lambda _path: (None, None))
    monkeypatch.setattr(anime, "_cuda_provider_available", lambda: False)
    monkeypatch.setattr(
        anime, "claim_gpu_residency", lambda owner, release, *, label: claims.append(label)
    )
    anime.unload()

    anime.load(use_gpu=True)

    assert (claims, opened) == ([], [False])
    anime.unload()


def test_eviction_by_another_gpu_model_keeps_an_unusable_model_marked(
    models_dir: Path, monkeypatch
) -> None:
    anime.model_path().write_bytes(MODEL_BYTES)
    anime.samples_path().write_bytes(SAMPLES_BYTES)
    forgets = []
    monkeypatch.setattr(anime, "_cuda_provider_available", lambda: True)
    monkeypatch.setattr(anime, "claim_gpu_residency", lambda *a, **k: 0)
    monkeypatch.setattr(anime, "forget_gpu_residency", lambda owner: forgets.append(owner))

    def cannot_open(_path, *, use_gpu):
        raise RuntimeError("not an onnx file")

    monkeypatch.setattr(anime, "_open_session", cannot_open)
    anime.unload()
    forgets.clear()

    with pytest.raises(RuntimeError):
        anime.load(use_gpu=True)
    assert forgets, "a session that never opened must not stay registered on the GPU"

    anime._RESIDENT.release()

    assert anime.is_scoring() is False
    anime.unload()
    assert anime.is_scoring() is True
