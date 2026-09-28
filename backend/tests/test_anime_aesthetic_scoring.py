"""The deepghs anime grade joins aesthetic scoring once its files are installed.

It is graded on the picture the CLIP pass already opened, stored next to the
LAION and Waifu scores, and never costs a picture its LAION score.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

import aesthetic
import anime_aesthetic
import database as db
from services.aesthetic_service import AestheticService

GRADE = anime_aesthetic.AnimeAesthetic(score=4.5, percentile=0.8, grade="great")
REAL_LOAD = anime_aesthetic.load


def _add(test_db, tmp_path: Path, name: str) -> int:
    path = tmp_path / name
    Image.new("RGB", (8, 8), (10, 20, 30)).save(path)
    return test_db.add_image(path=str(path), filename=name, metadata_json="{}")


def _set(image_id: int, **columns) -> None:
    assignments = ", ".join(f"{name} = ?" for name in columns)
    with db.get_db() as conn:
        conn.execute(
            f"UPDATE images SET {assignments} WHERE id = ?",
            (*columns.values(), image_id),
        )
        conn.commit()


def _anime_columns(image_id: int) -> tuple:
    with db.get_db() as conn:
        return tuple(
            conn.execute(
                "SELECT aesthetic_anime, aesthetic_anime_pct, aesthetic_anime_grade "
                "FROM images WHERE id = ?",
                (image_id,),
            ).fetchone()
        )


@pytest.fixture
def scoring(monkeypatch):
    service = AestheticService()
    monkeypatch.setattr(service, "_compute_content_fingerprint", lambda _path: "fp")
    monkeypatch.setattr(service, "_gpu_cleanup", lambda: None)
    monkeypatch.setattr(aesthetic, "is_waifu_installed", lambda: False)
    return service


# --- inside the CLIP pass --------------------------------------------------------


@pytest.fixture
def loaded_clip(monkeypatch):
    torch = pytest.importorskip("torch")

    class _Clip:
        def encode_image(self, _tensor):
            return torch.ones((1, 768))

    laion = torch.nn.Linear(768, 1)
    monkeypatch.setattr(aesthetic, "_clip_model", _Clip())
    monkeypatch.setattr(
        aesthetic, "_clip_preprocess", lambda _img: torch.zeros(3, 4, 4)
    )
    monkeypatch.setattr(aesthetic, "_predictor", laion)
    monkeypatch.setattr(aesthetic, "_device", "cpu")
    monkeypatch.setattr(aesthetic, "_waifu_head", None)
    monkeypatch.setattr(anime_aesthetic, "is_installed", lambda: True)
    monkeypatch.setattr(anime_aesthetic, "_load_failed", False)
    monkeypatch.setattr(anime_aesthetic, "load", lambda *, use_gpu: None)


def test_the_grade_comes_from_the_picture_the_clip_pass_opened(
    loaded_clip, tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "pic.png"
    Image.new("RGBA", (8, 8), (10, 20, 30, 0)).save(path)
    seen = []
    monkeypatch.setattr(
        anime_aesthetic,
        "predict",
        lambda picture, *, use_gpu: seen.append((picture.mode, use_gpu)) or GRADE,
    )

    scores = aesthetic._predict_scores_loaded(str(path))

    assert scores.anime == GRADE
    assert seen == [("RGBA", False)]


def test_a_picture_the_grade_fails_on_keeps_its_laion_score(
    loaded_clip, tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "pic.png"
    Image.new("RGB", (8, 8)).save(path)

    def broken(_picture, *, use_gpu):
        raise ValueError("bad pixels")

    monkeypatch.setattr(anime_aesthetic, "predict", broken)

    scores = aesthetic._predict_scores_loaded(str(path))

    assert scores.anime is None
    assert isinstance(scores.laion, float)
    assert anime_aesthetic.is_scoring() is True


def test_an_unopenable_model_is_skipped_for_the_rest_of_the_run(
    loaded_clip, tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "pic.png"
    Image.new("RGB", (8, 8)).save(path)
    opened = []

    def cannot_open(_path, *, use_gpu):
        opened.append(use_gpu)
        raise RuntimeError("not an onnx file")

    monkeypatch.setattr(anime_aesthetic, "models_dir", lambda: tmp_path)
    anime_aesthetic.model_path().write_bytes(b"not an onnx file")
    anime_aesthetic.samples_path().write_bytes(b"samples")
    monkeypatch.setattr(anime_aesthetic, "load", REAL_LOAD)
    monkeypatch.setattr(anime_aesthetic, "_open_session", cannot_open)
    monkeypatch.setattr(anime_aesthetic, "_load_failed", False)

    first = aesthetic._predict_scores_loaded(str(path))
    second = aesthetic._predict_scores_loaded(str(path))

    assert (first.anime, second.anime) == (None, None)
    assert opened == [False]
    assert anime_aesthetic.is_scoring() is False
    assert anime_aesthetic.health()["message_key"] == "models.aestheticAnime.broken"


# --- storage ---------------------------------------------------------------------


def test_score_all_stores_the_grade(test_db, tmp_path: Path, scoring) -> None:
    image_id = _add(test_db, tmp_path, "a.png")

    scoring.score_batch(
        force=False,
        predict_scores=lambda _path: aesthetic.AestheticScores(laion=6.0, anime=GRADE),
    )

    assert _anime_columns(image_id) == (4.5, 0.8, "great")


def test_scored_pictures_without_a_grade_are_scored_once_the_model_is_installed(
    test_db, tmp_path: Path, scoring, monkeypatch
) -> None:
    graded = _add(test_db, tmp_path, "graded.png")
    ungraded = _add(test_db, tmp_path, "ungraded.png")
    current = aesthetic.AESTHETIC_SCORE_VERSION
    _set(graded, aesthetic_score=6, aesthetic_version=current, aesthetic_anime=3.0)
    _set(ungraded, aesthetic_score=6, aesthetic_version=current)

    monkeypatch.setattr(anime_aesthetic, "is_installed", lambda: False)
    assert scoring.count_images_to_score(force=False) == 0

    monkeypatch.setattr(anime_aesthetic, "is_installed", lambda: True)
    status = scoring.get_status(lambda: True)
    assert (status["to_score_count"], status["missing_extra_count"]) == (1, 1)

    scored = []
    scoring.score_batch(
        force=False,
        predict_scores=lambda path: (
            scored.append(Path(path).name)
            or aesthetic.AestheticScores(laion=6.0, anime=GRADE)
        ),
    )
    assert scored == ["ungraded.png"]
    assert _anime_columns(ungraded) == (4.5, 0.8, "great")


def test_a_run_without_the_model_keeps_an_earlier_grade(
    test_db, tmp_path: Path, scoring
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    _set(
        image_id,
        aesthetic_anime=2.0,
        aesthetic_anime_pct=0.3,
        aesthetic_anime_grade="normal",
    )

    scoring.score_batch(
        force=True, predict_scores=lambda _path: aesthetic.AestheticScores(laion=5.0)
    )

    assert _anime_columns(image_id) == (2.0, 0.3, "normal")


def test_scoring_one_picture_returns_the_grade(
    test_db, tmp_path: Path, scoring
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")

    result = scoring.score_single_image(
        image_id=image_id,
        predict_scores=lambda _path: aesthetic.AestheticScores(laion=6.0, anime=GRADE),
    )

    assert result["aesthetic_anime_grade"] == "great"
    assert (result["aesthetic_anime"], result["aesthetic_anime_pct"]) == (4.5, 0.8)


# --- gallery ---------------------------------------------------------------------


def test_the_gallery_carries_and_sorts_by_the_grade(test_db, tmp_path: Path) -> None:
    low = _add(test_db, tmp_path, "low.png")
    high = _add(test_db, tmp_path, "high.png")
    ungraded = _add(test_db, tmp_path, "none.png")
    _set(low, aesthetic_anime=1.5, aesthetic_anime_pct=0.2, aesthetic_anime_grade="low")
    _set(
        high,
        aesthetic_anime=5.5,
        aesthetic_anime_pct=0.97,
        aesthetic_anime_grade="masterpiece",
    )

    best_first = db.get_images(sort_by="aesthetic_anime")
    worst_first = db.get_images(sort_by="aesthetic_anime_asc")

    assert [img["id"] for img in best_first] == [high, low, ungraded]
    assert [img["id"] for img in worst_first] == [low, high, ungraded]
    assert best_first[0]["aesthetic_anime_grade"] == "masterpiece"
    assert best_first[0]["aesthetic_anime_pct"] == 0.97


# --- Model Center ------------------------------------------------------------------


def test_prepare_sets_up_the_aesthetic_predictor_then_adds_the_grade_model(
    monkeypatch, tmp_path: Path
) -> None:
    from services import model_service

    head_dir = tmp_path / "aesthetic"
    head_dir.mkdir()
    (head_dir / "sa_0_4_vit_l_14_linear.pth").write_bytes(b"head")
    fetched = []
    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: model_service.DependencyInstallResult((), False),
    )
    monkeypatch.setitem(
        sys.modules,
        "aesthetic",
        SimpleNamespace(
            reset_availability_cache=lambda: None,
            _ensure_loaded=lambda: None,
            _get_models_dir=lambda: head_dir,
            get_aesthetic_backbone_path=lambda: head_dir / "backbone",
            is_available=lambda: True,
            is_fully_ready=lambda: True,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "anime_aesthetic",
        SimpleNamespace(
            prepare=lambda download: (
                fetched.append(download)
                or {"model_path": "m.onnx", "samples_path": "s.npz"}
            )
        ),
    )

    result = model_service.ModelService().prepare_model("aesthetic-anime")

    assert result["status"] == "ok"
    assert result["model_id"] == "aesthetic-anime"
    assert len(fetched) == 1
    assert result["paths"]["model_path"] == "m.onnx"
    assert result["paths"]["head_path"] == str(head_dir / "sa_0_4_vit_l_14_linear.pth")


def test_the_grade_card_is_ready_only_with_the_predictor() -> None:
    from services.model_service_inventory import _anime_card

    installed = {
        "available": True,
        "message_key": "models.aestheticAnime.ready",
        "message": "",
    }

    assert _anime_card(installed, aesthetic_available=False)["message_key"] == (
        "models.aestheticAnime.needsBase"
    )
    assert _anime_card(installed, aesthetic_available=True)["status"] == "ready"


def test_after_running_out_of_gpu_memory_the_grade_stays_on_cpu(
    loaded_clip, tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "pic.png"
    Image.new("RGB", (8, 8)).save(path)
    monkeypatch.setattr(aesthetic, "_device", "cuda")
    monkeypatch.setattr(aesthetic, "_anime_on_cpu", False)
    monkeypatch.setattr(aesthetic, "_is_cuda_oom", lambda exc: "out of memory" in str(exc))
    runs = []

    def predict(_picture, *, use_gpu):
        runs.append(use_gpu)
        if use_gpu:
            raise RuntimeError("CUDA out of memory")
        return GRADE

    monkeypatch.setattr(anime_aesthetic, "predict", predict)

    first = aesthetic._predict_anime(Image.open(path))
    second = aesthetic._predict_anime(Image.open(path))

    assert (first, second) == (GRADE, GRADE)
    assert runs == [True, False, False]


def test_a_failed_cpu_retry_only_loses_the_grade(
    loaded_clip, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(aesthetic, "_device", "cuda")
    monkeypatch.setattr(aesthetic, "_anime_on_cpu", False)
    monkeypatch.setattr(aesthetic, "_is_cuda_oom", lambda exc: "out of memory" in str(exc))

    def predict(_picture, *, use_gpu):
        raise RuntimeError("CUDA out of memory" if use_gpu else "cpu also failed")

    monkeypatch.setattr(anime_aesthetic, "predict", predict)

    assert aesthetic._predict_anime(Image.new("RGB", (8, 8))) is None


# --- review findings: GPU memory, device switching, failures, audit -----------------


def test_running_out_of_gpu_memory_while_loading_retries_on_cpu(
    loaded_clip, monkeypatch
) -> None:
    monkeypatch.setattr(aesthetic, "_device", "cuda")
    monkeypatch.setattr(aesthetic, "_anime_on_cpu", False)
    monkeypatch.setattr(aesthetic, "_is_cuda_oom", lambda exc: "out of memory" in str(exc))
    monkeypatch.setattr(anime_aesthetic, "load", REAL_LOAD)
    monkeypatch.setattr(anime_aesthetic, "_load_samples", lambda _path: (None, None))
    monkeypatch.setattr(anime_aesthetic, "_cuda_provider_available", lambda: True)
    monkeypatch.setattr(anime_aesthetic, "claim_gpu_residency", lambda *a, **k: 0)
    opened = []

    def open_session(_path, *, use_gpu):
        opened.append(use_gpu)
        if use_gpu:
            raise RuntimeError("CUDA failure 2: out of memory")
        return object()

    monkeypatch.setattr(anime_aesthetic, "_open_session", open_session)
    monkeypatch.setattr(anime_aesthetic, "predict", lambda _picture, *, use_gpu: GRADE)

    assert aesthetic._predict_anime(Image.new("RGB", (8, 8))) == GRADE
    assert opened == [True, False]
    assert anime_aesthetic.is_scoring() is True
    assert aesthetic._anime_on_cpu is True
    anime_aesthetic.unload()


def test_a_model_that_also_fails_on_cpu_is_marked_unusable(loaded_clip, monkeypatch) -> None:
    monkeypatch.setattr(aesthetic, "_device", "cuda")
    monkeypatch.setattr(aesthetic, "_anime_on_cpu", False)
    monkeypatch.setattr(aesthetic, "_is_cuda_oom", lambda exc: "out of memory" in str(exc))
    monkeypatch.setattr(anime_aesthetic, "load", REAL_LOAD)
    monkeypatch.setattr(anime_aesthetic, "_load_failed", False)
    monkeypatch.setattr(anime_aesthetic, "_cuda_provider_available", lambda: True)
    monkeypatch.setattr(anime_aesthetic, "claim_gpu_residency", lambda *a, **k: 0)

    def open_session(_path, *, use_gpu):
        raise RuntimeError("CUDA failure 2: out of memory" if use_gpu else "not an onnx file")

    monkeypatch.setattr(anime_aesthetic, "_open_session", open_session)

    assert aesthetic._predict_anime(Image.new("RGB", (8, 8))) is None
    assert anime_aesthetic.is_scoring() is False


def test_models_loaded_on_the_gpu_stay_there_when_free_memory_drops(monkeypatch) -> None:
    monkeypatch.setattr(aesthetic, "_predictor", object())
    monkeypatch.setattr(aesthetic, "_device", "cuda")
    monkeypatch.setattr(aesthetic, "is_waifu_installed", lambda: False)
    monkeypatch.setattr(aesthetic, "_select_device", lambda use_gpu=True: "cpu")

    def reload(_device=None):
        raise AssertionError("a loaded GPU model must not be moved for low free memory")

    monkeypatch.setattr(aesthetic, "_load_predictor", reload)
    monkeypatch.setattr(aesthetic, "_unload_models", lambda: reload())

    aesthetic._ensure_loaded()
    aesthetic._ensure_loaded()

    assert aesthetic._device == "cuda"


def test_models_on_the_cpu_still_move_to_the_gpu_when_it_has_room(monkeypatch) -> None:
    loads = []
    monkeypatch.setattr(aesthetic, "_predictor", object())
    monkeypatch.setattr(aesthetic, "_device", "cpu")
    monkeypatch.setattr(aesthetic, "is_waifu_installed", lambda: False)
    monkeypatch.setattr(aesthetic, "_select_device", lambda use_gpu=True: "cuda")
    monkeypatch.setattr(aesthetic, "_unload_models", lambda: setattr(aesthetic, "_predictor", None))
    monkeypatch.setattr(aesthetic, "_load_predictor", lambda device=None: loads.append(device))

    aesthetic._ensure_loaded()

    assert loads == ["cuda"]


def test_a_picture_whose_grade_failed_counts_as_an_error(
    test_db, tmp_path: Path, scoring
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    updates = []

    scoring.score_batch(
        force=False,
        predict_scores=lambda _path: aesthetic.AestheticScores(laion=6.0, anime_failed=True),
        progress_callback=updates.append,
    )

    errors = [u["errors"] for u in updates if "errors" in u]
    assert errors[-1] == 1
    with db.get_db() as conn:
        assert conn.execute(
            "SELECT aesthetic_score FROM images WHERE id = ?", (image_id,)
        ).fetchone()[0] == 6.0


def test_a_grade_failure_is_reported_in_the_scores(loaded_clip, tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "pic.png"
    Image.new("RGB", (8, 8)).save(path)

    def broken(_picture, *, use_gpu):
        raise ValueError("bad pixels")

    monkeypatch.setattr(anime_aesthetic, "predict", broken)

    scores = aesthetic._predict_scores_loaded(str(path))

    assert (scores.anime, scores.anime_failed) == (None, True)


def test_the_dataset_audit_only_computes_the_laion_score(monkeypatch) -> None:
    from services import dataset_audit_service

    calls = []
    monkeypatch.setattr(
        aesthetic,
        "predict_scores",
        lambda path, **kwargs: calls.append(kwargs) or aesthetic.AestheticScores(laion=5.5),
    )

    assert dataset_audit_service._safe_aesthetic_score("x.png") == 5.5
    assert calls == [{"extras": False}]


def test_extras_off_skips_the_waifu_head_and_the_grade(
    loaded_clip, tmp_path: Path, monkeypatch
) -> None:
    torch = pytest.importorskip("torch")
    path = tmp_path / "pic.png"
    Image.new("RGB", (8, 8)).save(path)
    monkeypatch.setattr(aesthetic, "_waifu_head", lambda _f: torch.tensor([[5.0]]))
    monkeypatch.setattr(
        anime_aesthetic,
        "predict",
        lambda *_a, **_k: pytest.fail("the grade must not run for a LAION-only score"),
    )

    scores = aesthetic._predict_scores_loaded(str(path), extras=False)

    assert (scores.waifu, scores.anime, scores.anime_failed) == (None, None, False)
