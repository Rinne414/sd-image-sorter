"""Artist Identify must not download Kaloscope (~2.8 GB) without Prepare."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

import artist_identifier as ai


def _tiny_png(path: Path) -> str:
    Image.new("RGB", (8, 8), color="red").save(path)
    return str(path)


def _add_png(db, tmp_path: Path) -> int:
    path = tmp_path / "identify-me.png"
    Image.new("RGB", (32, 32), "white").save(path)
    return db.add_image(path=str(path), filename=path.name, metadata_json="{}")


def _forbid_downloads(monkeypatch, tmp_path: Path) -> list[str]:
    calls: list[str] = []
    empty = tmp_path / "empty-artist"
    monkeypatch.setattr(ai, "_identifier", None)
    monkeypatch.setattr(ai, "_get_artist_model_root", lambda: empty)
    monkeypatch.setattr(ai, "_resolve_lsnet_runtime_path", lambda: None)

    def record(name: str):
        def _blocked(*_args, **_kwargs):
            calls.append(name)
            raise AssertionError(f"{name} must not run during Identify")

        return _blocked

    monkeypatch.setattr(ai, "prepare_artist_assets", record("prepare_artist_assets"))
    monkeypatch.setattr(ai, "_hf_download_with_fallback", record("_hf_download_with_fallback"))
    monkeypatch.setattr(ai, "_fetch_artist_file", record("_fetch_artist_file"))
    monkeypatch.setattr(ai, "_download_and_extract_github_zip", record("_download_and_extract_github_zip"))
    monkeypatch.setattr(ai, "_ensure_comfyui_lsnet_runtime", record("_ensure_comfyui_lsnet_runtime"))
    return calls


def test_load_does_not_download_when_unprepared(monkeypatch, tmp_path):
    calls = _forbid_downloads(monkeypatch, tmp_path)
    ident = ai.ArtistIdentifier(model_source="huggingface")
    ident.load()

    assert ident._model is None
    assert calls == []
    err = str(ident._load_error or "")
    assert "2.8" in err
    assert "Prepare" in err


def test_modelscope_load_does_not_download_when_unprepared(monkeypatch, tmp_path):
    calls = _forbid_downloads(monkeypatch, tmp_path)
    ident = ai.ArtistIdentifier(model_source="modelscope")
    ident.load()

    assert ident._model is None
    assert calls == []
    assert "2.8" in str(ident._load_error or "")


def test_identify_error_mentions_prepare_without_downloading(monkeypatch, tmp_path):
    calls = _forbid_downloads(monkeypatch, tmp_path)
    image_path = _tiny_png(tmp_path / "probe.png")
    ident = ai.ArtistIdentifier(model_source="huggingface")
    result = ident.identify(image_path)

    assert result["artist"] == "undefined"
    assert result["model_loaded"] is False
    assert calls == []
    assert "2.8" in result["error"]
    assert "Prepare" in result["error"]


def test_identify_endpoint_returns_503_when_unprepared(
    test_client, test_db, tmp_path, monkeypatch
):
    import database as db

    calls = _forbid_downloads(monkeypatch, tmp_path)
    image_id = _add_png(db, tmp_path)

    response = test_client.post("/api/artists/identify", json={"image_id": image_id})

    assert response.status_code == 503
    body = str(response.json())
    assert "2.8" in body
    assert "Prepare" in body
    assert calls == []
