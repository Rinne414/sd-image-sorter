"""Anime censor + face guard model files: pinned, verified, and never half-installed."""

from __future__ import annotations

import dataclasses
import hashlib
from pathlib import Path

import pytest

import anime_censor_models as models

CENSOR_BYTES = b"censor-model-bytes"
FACE_BYTES = b"face-model-bytes"


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        models.config, "get_yolo_model_dir", lambda: str(tmp_path / "yolo")
    )
    monkeypatch.setattr(models.config, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        models,
        "CENSOR_FILE",
        dataclasses.replace(
            models.CENSOR_FILE, sha256=hashlib.sha256(CENSOR_BYTES).hexdigest()
        ),
    )
    monkeypatch.setattr(
        models,
        "FACE_FILE",
        dataclasses.replace(
            models.FACE_FILE, sha256=hashlib.sha256(FACE_BYTES).hexdigest()
        ),
    )
    monkeypatch.setattr(
        models,
        "get_hf_endpoint_order",
        lambda **_: ["https://huggingface.co", "https://hf-mirror.com"],
    )


def _downloader(serve):
    calls = []

    def download(url: str, dest: Path, *, timeout: int) -> Path:
        calls.append(url)
        content = serve(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return dest

    download.calls = calls
    return download


def _right_bytes(url: str) -> bytes:
    return CENSOR_BYTES if "censor" in url else FACE_BYTES


def test_both_files_are_fetched_from_the_pinned_commit_and_placed() -> None:
    download = _downloader(_right_bytes)

    paths = models.prepare(download)

    assert Path(paths["censor_model_path"]).read_bytes() == CENSOR_BYTES
    assert Path(paths["face_model_path"]).read_bytes() == FACE_BYTES
    assert Path(paths["censor_model_path"]).parent == Path(
        models.config.get_yolo_model_dir()
    )
    assert download.calls[0] == (
        "https://huggingface.co/deepghs/anime_censor_detection/resolve/"
        "0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2/censor_detect_v1.0_s/model.onnx"
    )
    assert models.health()["available"] is True


def test_a_verified_copy_is_not_downloaded_again() -> None:
    models.prepare(_downloader(_right_bytes))
    again = _downloader(_right_bytes)

    models.prepare(again)

    assert again.calls == []


def test_a_failing_endpoint_falls_back_to_the_mirror() -> None:
    def serve(url: str) -> bytes:
        if url.startswith("https://huggingface.co"):
            raise OSError("connection reset")
        return _right_bytes(url)

    download = _downloader(serve)

    models.prepare(download)

    assert models.health()["available"] is True
    assert sum(url.startswith("https://hf-mirror.com") for url in download.calls) == 2


def test_a_file_with_the_wrong_checksum_is_never_installed() -> None:
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        models.prepare(_downloader(lambda url: b"tampered"))

    assert not models.censor_model_path().exists()
    assert not list(models.censor_model_path().parent.glob("*.download*"))
    assert models.health()["message_key"] == "models.censorAnime.missing"


def test_health_reports_a_half_finished_download() -> None:
    models.censor_model_path().parent.mkdir(parents=True, exist_ok=True)
    models.censor_model_path().write_bytes(CENSOR_BYTES)

    health = models.health()

    assert health["available"] is False
    assert health["message_key"] == "models.censorAnime.partial"


def test_the_anime_detector_is_preferred_over_general_yolo_models(tmp_path: Path, monkeypatch) -> None:
    import model_health_paths

    yolo = Path(models.config.get_yolo_model_dir())
    yolo.mkdir(parents=True, exist_ok=True)
    (yolo / "yolov8s-seg.onnx").write_bytes(b"general")
    models.censor_model_path().write_bytes(CENSOR_BYTES)
    monkeypatch.setattr(model_health_paths._svc(), "get_yolo_model_dir", lambda: str(yolo))

    assert Path(model_health_paths.get_default_legacy_model_path()).name == models.CENSOR_FILE.filename
