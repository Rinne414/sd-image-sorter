"""Waifu Scorer V3: an anime aesthetic head on the same CLIP pass as the LAION score.

The head is an 11 MB file pinned to a repository commit and checked by
SHA-256. Once installed, every aesthetic scoring run stores both scores from
one CLIP embedding; pictures that already have a current LAION score but no
Waifu score count as "to score" again so one run fills them in.
"""

from __future__ import annotations

import dataclasses
import hashlib
from pathlib import Path

import pytest

import aesthetic
import database as db
from db_images_write import _clear_image_pixel_caches, _copy_image_derived_state
from services.aesthetic_service import AestheticService
from services.derived_state_service import write_image_aesthetic_score

HEAD_BYTES = b"waifu-head-bytes"
AESTHETIC_COLUMNS = (
    "aesthetic_score",
    "aesthetic_version",
    "aesthetic_waifu",
    "aesthetic_anime",
    "aesthetic_anime_pct",
    "aesthetic_anime_grade",
)


@pytest.fixture
def models_dir(tmp_path: Path, monkeypatch) -> Path:
    folder = tmp_path / "models-aesthetic"
    folder.mkdir()
    monkeypatch.setattr(aesthetic, "_get_models_dir", lambda: folder)
    monkeypatch.setattr(
        aesthetic,
        "WAIFU_HEAD_FILE",
        dataclasses.replace(
            aesthetic.WAIFU_HEAD_FILE, sha256=hashlib.sha256(HEAD_BYTES).hexdigest()
        ),
    )
    import pinned_download

    monkeypatch.setattr(
        pinned_download,
        "get_hf_endpoint_order",
        lambda **_: ["https://huggingface.co", "https://hf-mirror.com"],
    )
    return folder


def _downloader(content: bytes):
    calls: list[str] = []

    def download(url: str, dest: Path, *, timeout: int) -> Path:
        calls.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return dest

    download.calls = calls
    return download


def _add(test_db, tmp_path: Path, name: str) -> int:
    path = tmp_path / name
    path.write_bytes(b"x")
    return test_db.add_image(path=str(path), filename=name, metadata_json="{}")


def _set(image_id: int, **columns) -> None:
    assignments = ", ".join(f"{name} = ?" for name in columns)
    with db.get_db() as conn:
        conn.execute(
            f"UPDATE images SET {assignments} WHERE id = ?",
            (*columns.values(), image_id),
        )
        conn.commit()


def _row(image_id: int) -> dict:
    with db.get_db() as conn:
        row = conn.execute(
            f"SELECT {', '.join(AESTHETIC_COLUMNS)} FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()
    return dict(row)


# --- the pinned file ---------------------------------------------------------


def test_the_head_is_pinned_to_a_commit_and_checksum() -> None:
    pinned = aesthetic.WAIFU_HEAD_FILE

    assert pinned.repo == "Eugeoter/waifu-scorer-v3"
    assert pinned.revision == "c2a747fd61d310a90e9cbbf8fc590c522f234424"
    assert pinned.remote_path == "model.safetensors"
    assert pinned.sha256 == (
        "7def1b66314e318d9b045ff225fd51bb83bfbca855b12b2e213a5483efe37efd"
    )
    assert pinned.size_bytes == 11_219_340


def test_prepare_places_the_verified_head_next_to_the_laion_head(
    models_dir: Path,
) -> None:
    download = _downloader(HEAD_BYTES)
    assert aesthetic.waifu_health()["available"] is False

    path = aesthetic.prepare_waifu_head(download)

    assert path == models_dir / "waifu_scorer_v3.safetensors"
    assert path.read_bytes() == HEAD_BYTES
    assert download.calls == [
        "https://huggingface.co/Eugeoter/waifu-scorer-v3/resolve/"
        "c2a747fd61d310a90e9cbbf8fc590c522f234424/model.safetensors"
    ]
    assert aesthetic.is_waifu_installed() is True
    assert aesthetic.waifu_health()["available"] is True


def test_a_head_with_the_wrong_checksum_is_never_installed(models_dir: Path) -> None:
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        aesthetic.prepare_waifu_head(_downloader(b"tampered"))

    assert list(models_dir.iterdir()) == []
    assert aesthetic.is_waifu_installed() is False


# --- the model ---------------------------------------------------------------


def _reference_head(torch):
    nn = torch.nn
    return nn.Sequential(
        nn.Linear(768, 2048),
        nn.ReLU(),
        nn.BatchNorm1d(2048),
        nn.Dropout(0.3),
        nn.Linear(2048, 512),
        nn.ReLU(),
        nn.BatchNorm1d(512),
        nn.Dropout(0.3),
        nn.Linear(512, 256),
        nn.ReLU(),
        nn.BatchNorm1d(256),
        nn.Dropout(0.2),
        nn.Linear(256, 128),
        nn.ReLU(),
        nn.BatchNorm1d(128),
        nn.Dropout(0.1),
        nn.Linear(128, 32),
        nn.ReLU(),
        nn.Linear(32, 1),
    ).eval()


def test_the_head_loads_the_published_layer_layout(tmp_path: Path) -> None:
    torch = pytest.importorskip("torch")
    safetensors_torch = pytest.importorskip("safetensors.torch")
    torch.manual_seed(0)
    reference = _reference_head(torch)
    for module in reference:
        if isinstance(module, torch.nn.BatchNorm1d):
            module.running_mean.uniform_(-0.2, 0.2)
            module.running_var.uniform_(0.5, 1.5)
    path = tmp_path / "head.safetensors"
    safetensors_torch.save_file(
        {f"layers.{key}": value for key, value in reference.state_dict().items()},
        str(path),
    )
    features = torch.nn.functional.normalize(torch.randn(1, 768), dim=-1)

    head = aesthetic._build_waifu_head(torch, path, "cpu")

    with torch.no_grad():
        assert torch.allclose(head(features), reference(features), atol=1e-6)
        assert torch.equal(head(features), head(features))


def test_one_clip_pass_gives_both_scores(tmp_path: Path, monkeypatch) -> None:
    torch = pytest.importorskip("torch")
    from PIL import Image

    image_path = tmp_path / "pic.png"
    Image.new("RGB", (8, 8), (10, 20, 30)).save(image_path)
    encoded = []

    class _Clip:
        def encode_image(self, tensor):
            encoded.append(tensor.shape)
            return torch.full((1, 768), 2.0)

    laion = torch.nn.Linear(768, 1)
    torch.nn.init.constant_(laion.weight, 0.01)
    torch.nn.init.constant_(laion.bias, 5.0)
    monkeypatch.setattr(aesthetic, "_clip_model", _Clip())
    monkeypatch.setattr(
        aesthetic, "_clip_preprocess", lambda _img: torch.zeros(3, 4, 4)
    )
    monkeypatch.setattr(aesthetic, "_predictor", laion)
    monkeypatch.setattr(aesthetic, "_device", "cpu")
    monkeypatch.setattr(aesthetic, "_waifu_head", lambda _f: torch.tensor([[12.5]]))

    scores = aesthetic._predict_scores_loaded(str(image_path))

    assert len(encoded) == 1
    assert scores.laion == pytest.approx(5.0 + 0.01 * 768 / (768**0.5), abs=1e-4)
    assert scores.waifu == 10.0

    monkeypatch.setattr(aesthetic, "_waifu_head", None)
    assert aesthetic._predict_scores_loaded(str(image_path)).waifu is None


def test_a_head_installed_while_scoring_is_loaded_is_picked_up(monkeypatch) -> None:
    loaded = []
    monkeypatch.setattr(aesthetic, "_predictor", object())
    monkeypatch.setattr(aesthetic, "_clip_model", object())
    monkeypatch.setattr(aesthetic, "_device", "cpu")
    monkeypatch.setattr(aesthetic, "_waifu_head", None)
    monkeypatch.setattr(aesthetic, "_waifu_head_failed", False)
    monkeypatch.setattr(aesthetic, "is_waifu_installed", lambda: True)
    monkeypatch.setattr(aesthetic, "_select_device", lambda use_gpu=True: "cpu")

    def reload_everything(_device=None):
        raise AssertionError("CLIP must not be reloaded for the Waifu head")

    def load_head():
        loaded.append("waifu")
        aesthetic._waifu_head = object()

    monkeypatch.setattr(aesthetic, "_load_predictor", reload_everything)
    monkeypatch.setattr(aesthetic, "_load_waifu_head", load_head)

    aesthetic._ensure_loaded()
    aesthetic._ensure_loaded()

    assert loaded == ["waifu"]


def test_a_broken_head_file_does_not_stop_laion_scoring(
    models_dir: Path, monkeypatch, caplog
) -> None:
    pytest.importorskip("torch")
    (models_dir / "waifu_scorer_v3.safetensors").write_bytes(b"not a safetensors file")
    monkeypatch.setattr(aesthetic, "_device", "cpu")
    monkeypatch.setattr(aesthetic, "_waifu_head", None)
    monkeypatch.setattr(aesthetic, "_waifu_head_failed", False)

    aesthetic._load_waifu_head()

    assert aesthetic._waifu_head is None
    assert aesthetic._waifu_head_pending() is False
    assert "Waifu Scorer" in caplog.text


# --- storage -----------------------------------------------------------------


def test_score_all_stores_the_waifu_score_with_the_laion_score(
    test_db, tmp_path: Path, monkeypatch
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    service = AestheticService()
    monkeypatch.setattr(service, "_compute_content_fingerprint", lambda _path: "fp")
    monkeypatch.setattr(service, "_gpu_cleanup", lambda: None)

    service.score_batch(
        force=False,
        predict_scores=lambda _path: aesthetic.AestheticScores(laion=6.5, waifu=8.25),
    )

    row = _row(image_id)
    assert (row["aesthetic_score"], row["aesthetic_waifu"]) == (6.5, 8.25)
    assert row["aesthetic_version"] == aesthetic.AESTHETIC_SCORE_VERSION


def test_pictures_without_a_waifu_score_are_scored_once_the_head_is_installed(
    test_db, tmp_path: Path, monkeypatch
) -> None:
    done = _add(test_db, tmp_path, "done.png")
    laion_only = _add(test_db, tmp_path, "laion-only.png")
    current = aesthetic.AESTHETIC_SCORE_VERSION
    _set(done, aesthetic_score=6, aesthetic_version=current, aesthetic_waifu=7)
    _set(laion_only, aesthetic_score=6, aesthetic_version=current)
    service = AestheticService()

    monkeypatch.setattr(aesthetic, "is_waifu_installed", lambda: False)
    assert service.count_images_to_score(force=False) == 0
    assert service.get_status(lambda: True)["missing_extra_count"] == 0

    monkeypatch.setattr(aesthetic, "is_waifu_installed", lambda: True)
    status = service.get_status(lambda: True)
    assert status["to_score_count"] == 1
    assert status["missing_extra_count"] == 1
    assert status["outdated_count"] == 0

    monkeypatch.setattr(service, "_compute_content_fingerprint", lambda _path: "fp")
    monkeypatch.setattr(service, "_gpu_cleanup", lambda: None)
    scored = []
    service.score_batch(
        force=False,
        predict_scores=lambda path: (
            scored.append(Path(path).name)
            or aesthetic.AestheticScores(laion=6.0, waifu=5.5)
        ),
    )

    assert scored == ["laion-only.png"]
    assert _row(laion_only)["aesthetic_waifu"] == 5.5


def test_a_run_without_the_head_keeps_an_earlier_waifu_score(
    test_db, tmp_path: Path
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    _set(image_id, content_fingerprint="fp", aesthetic_score=5, aesthetic_waifu=8)
    with db.get_db() as conn:
        written = write_image_aesthetic_score(
            conn.cursor(),
            image_id=image_id,
            scores=aesthetic.AestheticScores(laion=6.0),
            content_fingerprint="fp",
        )
        conn.commit()

    assert written is True
    assert (_row(image_id)["aesthetic_score"], _row(image_id)["aesthetic_waifu"]) == (
        6.0,
        8,
    )


def test_scoring_one_picture_returns_both_scores(
    test_db, tmp_path: Path, monkeypatch
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    service = AestheticService()
    monkeypatch.setattr(service, "_compute_content_fingerprint", lambda _path: "fp")

    result = service.score_single_image(
        image_id=image_id,
        predict_scores=lambda _path: aesthetic.AestheticScores(laion=6.0, waifu=7.0),
    )

    assert result == {
        "image_id": image_id,
        "aesthetic_score": 6.0,
        "aesthetic_waifu": 7.0,
    }


def test_changed_pixels_clear_every_aesthetic_score(test_db, tmp_path: Path) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    _set(
        image_id,
        aesthetic_score=6,
        aesthetic_version=2,
        aesthetic_waifu=7,
        aesthetic_anime=4.5,
        aesthetic_anime_pct=0.8,
        aesthetic_anime_grade="great",
    )
    with db.get_db() as conn:
        _clear_image_pixel_caches(conn.cursor(), image_id)
        conn.commit()

    assert all(value is None for value in _row(image_id).values())


def test_a_duplicate_file_keeps_every_aesthetic_score(test_db, tmp_path: Path) -> None:
    source = _add(test_db, tmp_path, "a.png")
    copy = _add(test_db, tmp_path, "b.png")
    scores = {
        "aesthetic_score": 6.0,
        "aesthetic_version": 2,
        "aesthetic_waifu": 7.0,
        "aesthetic_anime": 4.5,
        "aesthetic_anime_pct": 0.8,
        "aesthetic_anime_grade": "great",
    }
    _set(source, **scores)
    with db.get_db() as conn:
        _copy_image_derived_state(conn.cursor(), source, copy)
        conn.commit()

    assert _row(copy) == scores


# --- gallery -----------------------------------------------------------------


def test_the_gallery_carries_and_sorts_by_the_waifu_score(
    test_db, tmp_path: Path
) -> None:
    low = _add(test_db, tmp_path, "low.png")
    high = _add(test_db, tmp_path, "high.png")
    unscored = _add(test_db, tmp_path, "none.png")
    zero = _add(test_db, tmp_path, "zero.png")
    _set(low, aesthetic_waifu=3.0)
    _set(high, aesthetic_waifu=9.0)
    _set(zero, aesthetic_waifu=0.0)

    best_first = db.get_images(sort_by="aesthetic_waifu")
    worst_first = db.get_images(sort_by="aesthetic_waifu_asc")

    assert [img["id"] for img in best_first] == [high, low, zero, unscored]
    assert [img["id"] for img in worst_first] == [zero, low, high, unscored]
    assert best_first[0]["aesthetic_waifu"] == 9.0


def test_the_sort_is_accepted_by_the_api_allowlists() -> None:
    from db_query_columns import VALID_SORT_OPTIONS as QUERY_SORTS
    from services.image._constants import VALID_SORT_OPTIONS as SERVICE_SORTS

    for sort in ("aesthetic_waifu", "aesthetic_waifu_asc"):
        assert sort in QUERY_SORTS
        assert sort in SERVICE_SORTS


# --- Model Center ------------------------------------------------------------


def _fake_aesthetic_module(head_dir: Path, *, runtime_ready: bool, fetched: list):
    from types import SimpleNamespace

    return SimpleNamespace(
        reset_availability_cache=lambda: None,
        _ensure_loaded=lambda: None,
        _get_models_dir=lambda: head_dir,
        get_aesthetic_backbone_path=lambda: head_dir / "backbone.safetensors",
        is_available=lambda: runtime_ready,
        is_fully_ready=lambda: runtime_ready,
        prepare_waifu_head=lambda download: fetched.append(download)
        or head_dir / "waifu_scorer_v3.safetensors",
    )


def _prepare_waifu(monkeypatch, tmp_path: Path, *, runtime_ready: bool):
    import sys

    from services import model_service

    head_dir = tmp_path / "aesthetic"
    head_dir.mkdir()
    (head_dir / "sa_0_4_vit_l_14_linear.pth").write_bytes(b"head")
    fetched: list = []
    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: model_service.DependencyInstallResult((), False),
    )
    monkeypatch.setitem(
        sys.modules,
        "aesthetic",
        _fake_aesthetic_module(head_dir, runtime_ready=runtime_ready, fetched=fetched),
    )
    result = model_service.ModelService().prepare_model("aesthetic-waifu")
    return result, fetched, head_dir


def test_prepare_sets_up_the_aesthetic_predictor_then_adds_the_head(
    monkeypatch, tmp_path: Path
) -> None:
    result, fetched, head_dir = _prepare_waifu(monkeypatch, tmp_path, runtime_ready=True)

    assert result["status"] == "ok"
    assert result["model_id"] == "aesthetic-waifu"
    assert len(fetched) == 1
    assert result["paths"]["waifu_head_path"] == str(head_dir / "waifu_scorer_v3.safetensors")
    assert result["paths"]["head_path"] == str(head_dir / "sa_0_4_vit_l_14_linear.pth")


def test_prepare_stops_before_the_head_when_the_predictor_is_not_ready(
    monkeypatch, tmp_path: Path
) -> None:
    result, fetched, _ = _prepare_waifu(monkeypatch, tmp_path, runtime_ready=False)

    assert result["status"] == "needs_runtime"
    assert result["model_id"] == "aesthetic-waifu"
    assert fetched == []


@pytest.mark.parametrize(
    ("installed", "base_ready", "status", "message_key"),
    [
        (False, True, "missing", "models.aestheticWaifu.missing"),
        (True, False, "missing", "models.aestheticWaifu.needsBase"),
        (True, True, "ready", "models.aestheticWaifu.ready"),
    ],
)
def test_the_card_is_ready_only_with_the_head_and_the_predictor(
    installed: bool, base_ready: bool, status: str, message_key: str
) -> None:
    from services.model_service_inventory import _waifu_card

    health = {
        "available": installed,
        "message_key": "models.aestheticWaifu.ready" if installed else "models.aestheticWaifu.missing",
        "message": "",
        "expected_path": "models/aesthetic/waifu_scorer_v3.safetensors",
    }

    card = _waifu_card(health, aesthetic_available=base_ready)

    assert (card["status"], card["message_key"]) == (status, message_key)
    assert card["available"] is (status == "ready")


def test_the_image_detail_endpoint_returns_the_waifu_score(
    test_client, test_db, tmp_path: Path
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    _set(image_id, aesthetic_score=6.0, aesthetic_waifu=7.25)

    response = test_client.get(f"/api/images/{image_id}")

    assert response.status_code == 200
    assert response.json()["image"]["aesthetic_waifu"] == 7.25


def test_a_head_that_failed_to_load_stops_asking_for_waifu_scores(
    test_db, tmp_path: Path, models_dir: Path, monkeypatch
) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    _set(image_id, aesthetic_score=6, aesthetic_version=aesthetic.AESTHETIC_SCORE_VERSION)
    (models_dir / "waifu_scorer_v3.safetensors").write_bytes(b"cannot load")
    service = AestheticService()
    monkeypatch.setattr(aesthetic, "_waifu_head_failed", False)
    assert service.count_images_to_score(force=False) == 1

    monkeypatch.setattr(aesthetic, "_waifu_head_failed", True)

    assert service.count_images_to_score(force=False) == 0
    assert service.get_status(lambda: True)["missing_extra_count"] == 0
    health = aesthetic.waifu_health()
    assert health["available"] is False
    assert health["message_key"] == "models.aestheticWaifu.broken"
